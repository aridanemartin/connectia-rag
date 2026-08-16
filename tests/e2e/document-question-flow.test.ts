/**
 * End-to-end test: full document question flow.
 *
 * Simulates:
 * 1. Health/liveness checks
 * 2. The authenticate → ask question → receive answer path
 * 3. Integration of all components with deterministic fake dependencies
 */

import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import pino from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { loadConfig } from "../../src/config/env.js";
import { LifecycleService } from "../../src/documents/lifecycle.service.js";
import { openDatabase } from "../../src/persistence/database.js";
import { migrate } from "../../src/persistence/migrate.js";
import { DocumentRepository } from "../../src/persistence/repositories/document.repository.js";
import { GenerationGate } from "../../src/rag/generation-gate.js";
import { QuestionService } from "../../src/rag/question.service.js";
import { ActivityTracker } from "../../src/shared/activity-tracker.js";
import type { Clock } from "../../src/shared/clock.js";
import {
  type FakeOllamaServer,
  startFakeOllamaServer,
} from "../support/fake-ollama-server.js";

class MutableClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

const AUTH_TOKEN = "test-auth-token-with-at-least-32-characters";

function testConfig(ollamaUrl: string) {
  return loadConfig({
    PORT: "3000",
    LOG_LEVEL: "silent",
    AUTH_TOKEN,
    AUTH_DISABLED: "false",
    DATABASE_PATH: ":memory:",
    TEMP_DIR: "/tmp/test",
    OLLAMA_BASE_URL: ollamaUrl,
    OLLAMA_CHAT_MODEL: "fake-chat-model",
    OLLAMA_EMBEDDING_MODEL: "fake-embed-model",
    QDRANT_URL: "http://localhost:16333",
    QDRANT_COLLECTION: "test-e2e",
    EMBEDDING_DIMENSIONS: "128",
    DEPENDENCY_TIMEOUT_MS: "5000",
    MAX_PDF_BYTES: (25 * 1024 * 1024).toString(),
    MAX_ACTIVE_GENERATIONS: "2",
    MAX_QUEUED_GENERATIONS: "20",
    QUESTION_QUEUE_TIMEOUT_MS: "5000",
    RAG_TOP_K: "6",
    RAG_SCORE_THRESHOLD: "0.0",
    DIAGNOSTICS_ENABLED: "false",
    DIAGNOSTICS_TTL_HOURS: "24",
    ENABLE_INTERNAL_METRICS: "false",
    INDEXING_EMBED_BATCH_SIZE: "16",
    INDEXING_LEASE_MS: "60000",
    INDEXING_POLL_INTERVAL_MS: "1000",
  });
}

function fakeVectorStore() {
  return {
    ensureCollection: async () => {},
    upsert: async () => {},
    search: async () => [
      {
        id: "chunk-e2e-1",
        score: 0.85,
        payload: {
          documentId: "doc-e2e-1",
          versionId: "v-e2e-1",
          documentTitle: "Normativa de matrícula",
          academicYear: "2026-2027",
          page: 1,
          section: "Plazos",
          chunkIndex: 0,
          contentHash: "hash-e2e-1",
          text: "El plazo de matrícula ordinaria finaliza el 15 de julio de 2026.",
        },
      },
    ],
    deleteVersion: async () => {},
    health: async () => ({
      qdrant: true,
      collection: true,
      dimensions: 128,
    }),
  };
}

function fakeUploadFailureReporter() {}

function fakeUploadUnlink(): Promise<void> {
  return Promise.resolve();
}

describe("E2E: Document question flow", () => {
  let fakeOllama: FakeOllamaServer;
  let _server: Server;
  let database: ReturnType<typeof openDatabase>;

  beforeAll(async () => {
    fakeOllama = await startFakeOllamaServer();
  });

  afterAll(async () => {
    await fakeOllama.stop();
  });

  it("answers a question via the API using the fake Ollama server", async () => {
    const config = testConfig(fakeOllama.url);
    database = openDatabase(":memory:");
    migrate(database);
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const documents = new DocumentRepository(database, clock);
    const lifecycle = new LifecycleService(documents);

    // Create and activate a version so the question route has document versions
    const docId = randomUUID();
    const versionId = "v-e2e-1";
    documents.upsertIndexing({
      documentId: docId,
      versionId,
      title: "Normativa de matrícula",
      academicYear: "2026-2027",
      description: "documento de prueba",
      contentHash: "hash-content",
    });
    documents.markReady(versionId);
    lifecycle.activate(docId, versionId);

    const gate = new GenerationGate({
      concurrency: 2,
      maxQueued: 20,
      timeoutMs: 5000,
    });

    const model = {
      embedQuery: async (text: string) => {
        const response = await fetch(`${fakeOllama.url}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "fake-embed-model", input: text }),
        });
        const data = (await response.json()) as {
          embedding?: number[];
          embeddings?: number[][];
        };
        return data.embedding ?? data.embeddings?.[0] ?? [];
      },
      decide: async (input: {
        system: string;
        question: string;
        context: ReadonlyArray<{ chunkId: string; text: string }>;
      }) => {
        const response = await fetch(`${fakeOllama.url}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "fake-chat-model",
            messages: [
              { role: "system", content: input.system },
              {
                role: "user",
                content: JSON.stringify({
                  question: input.question,
                  context: input.context,
                }),
              },
            ],
          }),
        });
        const data = (await response.json()) as {
          message?: { content?: string };
        };
        const content = data?.message?.content ?? "{}";
        return JSON.parse(content);
      },
    };

    const questionService = new QuestionService({
      model,
      vectorStore: fakeVectorStore(),
      gate,
      topK: 6,
      scoreThreshold: 0.0,
    });

    const app = createApp({
      config,
      logger: pino({ level: "silent" }),
      questionService,
      lifecycle,
      activity: new ActivityTracker(),
      uploadFailureReporter: fakeUploadFailureReporter,
      uploadUnlink: fakeUploadUnlink,
    });

    await new Promise<void>((resolve, reject) => {
      const s = app.listen(0, () => {
        _server = s;
        resolve();
      });
      s.once("error", reject);
    });

    const response = await request(app)
      .post("/api/v1/questions")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`)
      .send({ question: "¿Cuál es el plazo de matrícula ordinaria?" });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("found");
    expect(response.body.answer).toBeTruthy();
    expect(response.body.citations).toBeInstanceOf(Array);
    expect(response.body.requestId).toBeDefined();
  });

  it("returns 401 without authentication", async () => {
    const config = testConfig(fakeOllama.url);
    const app = createApp({
      config,
      logger: pino({ level: "silent" }),
    });

    const response = await request(app)
      .post("/api/v1/questions")
      .send({ question: "¿Cuál es el plazo?" });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 400 for an empty question", async () => {
    const config = testConfig(fakeOllama.url);
    const app = createApp({
      config,
      logger: pino({ level: "silent" }),
    });

    const response = await request(app)
      .post("/api/v1/questions")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`)
      .send({ question: "" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("QUESTION_INVALID");
  });
});
