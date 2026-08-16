import { randomUUID } from "node:crypto";
import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { loadConfig } from "../../src/config/env.js";
import { LifecycleService } from "../../src/documents/lifecycle.service.js";
import {
  closeDatabase,
  type DatabaseConnection,
  openDatabase,
} from "../../src/persistence/database.js";
import { migrate } from "../../src/persistence/migrate.js";
import { DocumentRepository } from "../../src/persistence/repositories/document.repository.js";
import { GenerationGate } from "../../src/rag/generation-gate.js";
import { QuestionService } from "../../src/rag/question.service.js";
import type { Clock } from "../../src/shared/clock.js";

const AUTH_TOKEN = "test-auth-token-with-at-least-32-characters";

class MutableClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }
}

function indexingVersion(documentId = randomUUID(), versionId = randomUUID()) {
  return {
    documentId,
    versionId,
    title: "Horario escolar",
    academicYear: "2026-2027",
    description: "Horario del curso",
    contentHash: `content-${versionId}`,
  };
}

function fakeModel() {
  return {
    embedQuery: vi.fn(async () => [0.1, 0.2, 0.3]),
    decide: vi.fn(async () => ({
      status: "found",
      answer: "El horario es de 9:00 a 14:00.",
      citedChunkIds: ["chunk-1"],
    })),
    embedDocuments: vi.fn(async () => []),
    health: vi.fn(async () => ({
      ollama: true,
      chat: true,
      embeddings: true,
      dimensions: 3,
    })),
  };
}

function fakeVectorStore() {
  return {
    search: vi.fn(async (_vector: number[], _allowedVersionIds: string[]) => [
      {
        id: "chunk-1",
        score: 0.85,
        payload: {
          documentId: randomUUID(),
          versionId: randomUUID(),
          documentTitle: "Horario escolar",
          academicYear: "2026-2027",
          page: 2,
          section: "Horario",
          chunkIndex: 0,
          contentHash: "hash",
          text: "El horario escolar es de 9:00 a 14:00 de lunes a viernes.",
        },
      },
    ]),
    ensureCollection: vi.fn(async () => {}),
    upsert: vi.fn(async () => {}),
    deleteVersion: vi.fn(async () => {}),
    health: vi.fn(async () => ({
      qdrant: true,
      collection: true,
      dimensions: 3,
    })),
  };
}

function testConfig() {
  return loadConfig({
    AUTH_TOKEN,
    DATABASE_PATH: ":memory:",
    TEMP_DIR: "/tmp/test",
  });
}

interface Context {
  database: DatabaseConnection;
  lifecycle: LifecycleService;
  model: ReturnType<typeof fakeModel>;
  vectorStore: ReturnType<typeof fakeVectorStore>;
  app: ReturnType<typeof createApp>;
  documents: DocumentRepository;
}

function createTestContext(): Context {
  const database = openDatabase(":memory:");
  migrate(database);
  const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
  const documents = new DocumentRepository(database, clock);
  const lifecycle = new LifecycleService(documents);
  const model = fakeModel();
  const vectorStore = fakeVectorStore();
  const gate = new GenerationGate({
    concurrency: 2,
    maxQueued: 20,
    timeoutMs: 1000,
  });
  const questionService = new QuestionService({
    model,
    vectorStore,
    gate,
    topK: 6,
    scoreThreshold: 0.35,
  });
  const app = createApp({
    config: testConfig(),
    logger: pino({ level: "silent" }),
    lifecycle,
    questionService,
  });
  return { database, lifecycle, model, vectorStore, app, documents };
}

function closeContext(context: Context): void {
  closeDatabase(context.database);
}

describe("POST /api/v1/questions", () => {
  it("returns the rich canonical citation contract", async () => {
    const context = createTestContext();
    try {
      const version = indexingVersion();
      context.documents.upsertIndexing(version);
      context.documents.markReady(version.versionId);
      context.lifecycle.activate(version.documentId, version.versionId);

      const response = await request(context.app)
        .post("/api/v1/questions")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({ question: "¿Cuál es el horario?" });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("found");
      expect(response.body.answer).toBe("El horario es de 9:00 a 14:00.");
      expect(response.body.citations).toHaveLength(1);
      expect(response.body.citations[0]).toMatchObject({
        documentTitle: "Horario escolar",
        page: 2,
        academicYear: "2026-2027",
      });
      expect(response.body.requestId).toBe(response.headers["x-request-id"]);
    } finally {
      closeContext(context);
    }
  });

  it("rejects documentIds on the canonical public question route", async () => {
    const context = createTestContext();
    try {
      const response = await request(context.app)
        .post("/api/v1/questions")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({ question: "Pregunta", documentIds: [randomUUID()] });

      expect(response.status).toBe(400);
    } finally {
      closeContext(context);
    }
  });

  it("returns not_found when retrieval is empty", async () => {
    const context = createTestContext();
    try {
      context.vectorStore.search.mockResolvedValueOnce([]);

      const response = await request(context.app)
        .post("/api/v1/questions")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({ question: "¿Cuál es el comedor?" });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: "not_found",
        answer: null,
        citations: [],
      });
    } finally {
      closeContext(context);
    }
  });

  it("requires authentication", async () => {
    const context = createTestContext();
    try {
      const response = await request(context.app)
        .post("/api/v1/questions")
        .send({ question: "Pregunta" });

      expect(response.status).toBe(401);
    } finally {
      closeContext(context);
    }
  });

  it("maps queue saturation to 429 with Retry-After", async () => {
    const context = createTestContext();
    try {
      const version = indexingVersion();
      context.documents.upsertIndexing(version);
      context.documents.markReady(version.versionId);
      context.lifecycle.activate(version.documentId, version.versionId);

      // Reject the gate.run call with saturation
      const gate = new GenerationGate({
        concurrency: 1,
        maxQueued: 0,
        timeoutMs: 1000,
      });
      // Fill the gate to force saturation
      void gate.run(() => new Promise(() => undefined));
      const saturatedService = new QuestionService({
        model: context.model,
        vectorStore: context.vectorStore,
        gate,
        topK: 6,
        scoreThreshold: 0.35,
      });
      const saturatedApp = createApp({
        config: testConfig(),
        logger: pino({ level: "silent" }),
        lifecycle: context.lifecycle,
        questionService: saturatedService,
      });

      const response = await request(saturatedApp)
        .post("/api/v1/questions")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({ question: "¿Cuál es el horario?" });

      expect(response.status).toBe(429);
      expect(response.body.error.code).toBe("QUEUE_SATURATED");
      expect(response.headers["retry-after"]).toBe("1");
    } finally {
      closeContext(context);
    }
  });

  it("rejects malformed question bodies", async () => {
    const context = createTestContext();
    try {
      const response = await request(context.app)
        .post("/api/v1/questions")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({ question: "" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("QUESTION_INVALID");
    } finally {
      closeContext(context);
    }
  });
});

describe("POST /api/v1/documents/:documentId/versions/:versionId/preview", () => {
  it("previews a READY candidate with other active documents", async () => {
    const context = createTestContext();
    try {
      const candidate = indexingVersion();
      const other = indexingVersion();
      context.documents.upsertIndexing(candidate);
      context.documents.markReady(candidate.versionId);
      context.documents.upsertIndexing(other);
      context.documents.markReady(other.versionId);
      context.lifecycle.activate(other.documentId, other.versionId);

      const response = await request(context.app)
        .post(
          `/api/v1/documents/${candidate.documentId}/versions/${candidate.versionId}/preview`,
        )
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({ question: "¿Cuál es el horario?" });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("found");
      // The preview version set must include the candidate and the other
      // active version
      expect(context.vectorStore.search).toHaveBeenCalled();
      const searchCall = context.vectorStore.search.mock.calls[0] as [
        number[],
        string[],
      ];
      expect(searchCall[1]).toContain(candidate.versionId);
      expect(searchCall[1]).toContain(other.versionId);
    } finally {
      closeContext(context);
    }
  });

  it("rejects preview of a non-READY/non-ACTIVE target", async () => {
    const context = createTestContext();
    try {
      const version = indexingVersion();
      context.documents.upsertIndexing(version);

      const response = await request(context.app)
        .post(
          `/api/v1/documents/${version.documentId}/versions/${version.versionId}/preview`,
        )
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({ question: "¿Cuál es el horario?" });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("VERSION_NOT_PREVIEWABLE");
    } finally {
      closeContext(context);
    }
  });

  it("returns 404 for a non-existent preview version", async () => {
    const context = createTestContext();
    try {
      const response = await request(context.app)
        .post(
          `/api/v1/documents/${randomUUID()}/versions/${randomUUID()}/preview`,
        )
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({ question: "¿Cuál es el horario?" });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("VERSION_NOT_FOUND");
    } finally {
      closeContext(context);
    }
  });

  it("maps malformed JSON bodies to 400 BODY_INVALID", async () => {
    const context = createTestContext();
    try {
      const response = await request(context.app)
        .post("/api/v1/questions")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .set("Content-Type", "application/json")
        .send('{"question": "oops');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("BODY_INVALID");
    } finally {
      closeContext(context);
    }
  });

  it("maps queue timeout to 503 QUESTION_QUEUE_TIMEOUT", async () => {
    const context = createTestContext();
    try {
      const version = indexingVersion();
      context.documents.upsertIndexing(version);
      context.documents.markReady(version.versionId);
      context.lifecycle.activate(version.documentId, version.versionId);

      const timingOutService = new QuestionService({
        model: context.model,
        vectorStore: context.vectorStore,
        gate: {
          run: () =>
            Promise.reject(
              Object.assign(new Error("timeout"), {
                code: "QUEUE_TIMEOUT",
              }),
            ),
        },
        topK: 6,
        scoreThreshold: 0.35,
      });
      const timingOutApp = createApp({
        config: testConfig(),
        logger: pino({ level: "silent" }),
        lifecycle: context.lifecycle,
        questionService: timingOutService,
      });

      const response = await request(timingOutApp)
        .post("/api/v1/questions")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({ question: "¿Cuál es el horario?" });

      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("QUESTION_QUEUE_TIMEOUT");
    } finally {
      closeContext(context);
    }
  });
});
