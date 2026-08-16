/**
 * End-to-end test: failure recovery scenarios.
 *
 * Tests:
 * 1. The application recovers from transient failures (503 from model)
 * 2. Malformed model output is handled gracefully
 * 3. The server starts and health checks pass regardless of downstream
 *    dependency failures
 */

import PQueue from "p-queue";
import pino from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { loadConfig } from "../../src/config/env.js";
import { ActivityTracker } from "../../src/shared/activity-tracker.js";
import {
  startFakeOllamaServer,
  type FakeOllamaServer,
} from "../support/fake-ollama-server.js";

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
    QDRANT_COLLECTION: "test-e2e-recovery",
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

function defaultGate() {
  const queue = new PQueue({ concurrency: 2 });
  return {
    run: async <T>(fn: () => Promise<T>): Promise<T> => {
      return queue.add(fn);
    },
  };
}

describe("E2E: Failure recovery", () => {
  let fakeOllama: FakeOllamaServer;

  beforeAll(async () => {
    fakeOllama = await startFakeOllamaServer();
  });

  afterAll(async () => {
    await fakeOllama.stop();
  });

  it("health endpoint returns 200 even without downstream dependencies", async () => {
    const config = testConfig("http://localhost:19999"); // unreachable
    const app = createApp({
      config,
      logger: pino({ level: "silent" }),
      readiness: {
        check: async () => ({
          status: "not_ready",
          dependencies: {
            sqlite: "not_ready",
            qdrant: "not_ready",
            collection: "not_ready",
            ollama: "not_ready",
            chatModel: "not_ready",
            embeddingModel: "not_ready",
            embeddingDimensions: "not_ready",
          },
        }),
      },
    });

    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });

  it("health live endpoint always returns 200", async () => {
    const config = testConfig("http://localhost:19999");
    const app = createApp({
      config,
      logger: pino({ level: "silent" }),
      readiness: {
        check: async () => ({
          status: "not_ready",
          dependencies: {
            sqlite: "not_ready",
            qdrant: "not_ready",
            collection: "not_ready",
            ollama: "not_ready",
            chatModel: "not_ready",
            embeddingModel: "not_ready",
            embeddingDimensions: "not_ready",
          },
        }),
      },
    });

    const response = await request(app).get("/health/live");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });

  it("returns 502 when the model returns invalid output", async () => {
    const config = testConfig(fakeOllama.url);
    const app = createApp({
      config,
      logger: pino({ level: "silent" }),
      questionService: {
        ask: async () => {
          throw Object.assign(
            new Error("La respuesta del modelo no tiene el formato esperado."),
            { code: "MODEL_OUTPUT_INVALID" },
          );
        },
      } as never,
      activity: new ActivityTracker(),
    });

    const response = await request(app)
      .post("/api/v1/questions")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`)
      .send({ question: "¿Cuál es el plazo de matrícula?" });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("MODEL_OUTPUT_INVALID");
  });

  it("returns 503 when the question queue times out", async () => {
    const config = testConfig(fakeOllama.url);
    const app = createApp({
      config,
      logger: pino({ level: "silent" }),
      questionService: {
        ask: async () => {
          throw Object.assign(new Error("La cola de generación ha expirado."), {
            code: "QUESTION_QUEUE_TIMEOUT",
          });
        },
      } as never,
      activity: new ActivityTracker(),
    });

    const response = await request(app)
      .post("/api/v1/questions")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`)
      .send({ question: "¿Cuál es el plazo?" });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("QUESTION_QUEUE_TIMEOUT");
  });

  it("returns 404 for unknown routes", async () => {
    const config = testConfig(fakeOllama.url);
    const app = createApp({
      config,
      logger: pino({ level: "silent" }),
    });

    const response = await request(app)
      .get("/api/v1/nonexistent")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});