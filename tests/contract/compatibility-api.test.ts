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
import type { IndexingJob } from "../../src/persistence/repositories/indexing-job.repository.js";
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
    title: "Normativa de matrícula",
    academicYear: "2026-2027",
    description: "Procedimiento académico",
    contentHash: `content-${versionId}`,
  };
}

function fakeModel() {
  return {
    embedQuery: vi.fn(async () => [0.1, 0.2, 0.3]),
    decide: vi.fn(async () => ({
      status: "found",
      answer: "El plazo es el 15 de julio.",
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
          documentTitle: "Normativa de matrícula",
          academicYear: "2026-2027",
          page: 3,
          section: "Plazos",
          chunkIndex: 0,
          contentHash: "hash",
          text: "El plazo de matrícula termina el 15 de julio de 2026.",
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

describe("GET /health", () => {
  it("returns ok without authentication", async () => {
    const context = createTestContext();
    try {
      const response = await request(context.app).get("/health");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: "ok" });
    } finally {
      closeContext(context);
    }
  });
});

describe("POST /ask", () => {
  it("returns the legacy answer and citation shape", async () => {
    const context = createTestContext();
    try {
      const version = indexingVersion();
      context.documents.upsertIndexing(version);
      context.documents.markReady(version.versionId);
      context.lifecycle.activate(version.documentId, version.versionId);

      const response = await request(context.app)
        .post("/ask")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({ question: "¿Cuál es el plazo?" });

      expect(response.status).toBe(200);
      expect(typeof response.body.answer).toBe("string");
      expect(response.body.citations).toHaveLength(1);
      expect(response.body.citations[0]).toMatchObject({
        documentId: expect.any(String),
        title: "Normativa de matrícula",
        excerpt: expect.any(String),
      });
    } finally {
      closeContext(context);
    }
  });

  it("requires authentication", async () => {
    const context = createTestContext();
    try {
      const response = await request(context.app)
        .post("/ask")
        .send({ question: "Pregunta" });

      expect(response.status).toBe(401);
    } finally {
      closeContext(context);
    }
  });

  it("intersects legacy documentIds with active documents", async () => {
    const context = createTestContext();
    try {
      const activeVersion = indexingVersion();
      const inactiveVersion = indexingVersion();
      context.documents.upsertIndexing(activeVersion);
      context.documents.markReady(activeVersion.versionId);
      context.lifecycle.activate(
        activeVersion.documentId,
        activeVersion.versionId,
      );
      // This version exists but is never activated
      context.documents.upsertIndexing(inactiveVersion);
      context.documents.markReady(inactiveVersion.versionId);

      const response = await request(context.app)
        .post("/ask")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({
          question: "¿Cuál es el plazo?",
          documentIds: [inactiveVersion.documentId],
        });

      // The inactive document is not in the allowed set — nothing retrievable
      expect(response.status).toBe(200);
      expect(response.body.answer).toBe(
        "No se encontró información suficiente en los documentos activos.",
      );
      expect(response.body.citations).toEqual([]);
    } finally {
      closeContext(context);
    }
  });

  it("supplies the compatibility fallback when the answer is null", async () => {
    const context = createTestContext();
    try {
      const version = indexingVersion();
      context.documents.upsertIndexing(version);
      context.documents.markReady(version.versionId);
      context.lifecycle.activate(version.documentId, version.versionId);
      (context.model.decide as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        status: "not_found",
        answer: null,
        citedChunkIds: [],
      });

      const response = await request(context.app)
        .post("/ask")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({ question: "¿Cuál es el comedor?" });

      expect(response.status).toBe(200);
      expect(response.body.answer).toBe(
        "No se encontró información suficiente en los documentos activos.",
      );
      expect(response.body.citations).toEqual([]);
    } finally {
      closeContext(context);
    }
  });

  it("includes active documents matched by legacy documentIds", async () => {
    const context = createTestContext();
    try {
      const activeVersion = indexingVersion();
      context.documents.upsertIndexing(activeVersion);
      context.documents.markReady(activeVersion.versionId);
      context.lifecycle.activate(
        activeVersion.documentId,
        activeVersion.versionId,
      );

      const response = await request(context.app)
        .post("/ask")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({
          question: "¿Cuál es el plazo?",
          documentIds: [activeVersion.documentId],
        });

      expect(response.status).toBe(200);
      expect(typeof response.body.answer).toBe("string");
      expect(response.body.citations).toHaveLength(1);
    } finally {
      closeContext(context);
    }
  });

  it("supplies the fallback with status ambiguous", async () => {
    const context = createTestContext();
    try {
      const version = indexingVersion();
      context.documents.upsertIndexing(version);
      context.documents.markReady(version.versionId);
      context.lifecycle.activate(version.documentId, version.versionId);
      (context.model.decide as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        status: "ambiguous",
        answer: null,
        citedChunkIds: [],
      });

      const response = await request(context.app)
        .post("/ask")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({ question: "¿Cuál es la normativa?" });

      expect(response.status).toBe(200);
      expect(response.body.answer).toBe(
        "No se encontró información suficiente en los documentos activos.",
      );
      expect(response.body.status).toBe("ambiguous");
      expect(response.body.citations).toEqual([]);
    } finally {
      closeContext(context);
    }
  });

  it("maps /ask queue saturation to 429 with Retry-After", async () => {
    const context = createTestContext();
    try {
      const version = indexingVersion();
      context.documents.upsertIndexing(version);
      context.documents.markReady(version.versionId);
      context.lifecycle.activate(version.documentId, version.versionId);

      const gate = new GenerationGate({
        concurrency: 1,
        maxQueued: 0,
        timeoutMs: 1000,
      });
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
        .post("/ask")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({ question: "¿Cuál es el plazo?" });

      expect(response.status).toBe(429);
      expect(response.body.error.code).toBe("QUEUE_SATURATED");
      expect(response.headers["retry-after"]).toBe("1");
    } finally {
      closeContext(context);
    }
  });
});

describe("GET /api/v1/admin/jobs/:id/status", () => {
  it("maps a failed canonical job to error with the external shape", async () => {
    const context = createTestContext();
    try {
      const jobId = randomUUID();
      const failedJob: IndexingJob = {
        id: jobId,
        documentId: randomUUID(),
        versionId: randomUUID(),
        idempotencyKey: "key",
        requestHash: "hash",
        contentHash: "chash",
        tempFilePath: "/tmp/x.pdf",
        status: "failed",
        stage: "storing",
        progress: 85,
        attempts: 2,
        leaseOwner: null,
        leaseUntil: null,
        errorCode: "VECTOR_STORE_UNAVAILABLE",
        errorMessage: "No se ha podido almacenar el contenido indexado.",
        createdAt: "2026-08-16T10:00:00.000Z",
        updatedAt: "2026-08-16T10:00:05.000Z",
        completedAt: "2026-08-16T10:00:05.000Z",
      };
      const appWithJobs = createApp({
        config: testConfig(),
        logger: pino({ level: "silent" }),
        lifecycle: context.lifecycle,
        questionService: undefined,
        indexingJobs: { find: () => failedJob },
      });

      const response = await request(appWithJobs)
        .get(`/api/v1/admin/jobs/${jobId}/status`)
        .set("Authorization", `Bearer ${AUTH_TOKEN}`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: jobId,
        status: "error",
        progressDescription: "Almacenando los fragmentos en el índice",
        errorCode: "VECTOR_STORE_UNAVAILABLE",
        errorMessage: "No se ha podido almacenar el contenido indexado.",
        completedAt: "2026-08-16T10:00:05.000Z",
      });
    } finally {
      closeContext(context);
    }
  });

  it("maps a completed canonical job to completed", async () => {
    const context = createTestContext();
    try {
      const jobId = randomUUID();
      const completedJob: IndexingJob = {
        id: jobId,
        documentId: randomUUID(),
        versionId: randomUUID(),
        idempotencyKey: "key",
        requestHash: "hash",
        contentHash: "chash",
        tempFilePath: "/tmp/x.pdf",
        status: "completed",
        stage: "completed",
        progress: 100,
        attempts: 1,
        leaseOwner: null,
        leaseUntil: null,
        errorCode: null,
        errorMessage: null,
        createdAt: "2026-08-16T10:00:00.000Z",
        updatedAt: "2026-08-16T10:00:02.000Z",
        completedAt: "2026-08-16T10:00:02.000Z",
      };
      const appWithJobs = createApp({
        config: testConfig(),
        logger: pino({ level: "silent" }),
        lifecycle: context.lifecycle,
        indexingJobs: { find: () => completedJob },
      });

      const response = await request(appWithJobs)
        .get(`/api/v1/admin/jobs/${jobId}/status`)
        .set("Authorization", `Bearer ${AUTH_TOKEN}`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: jobId,
        status: "completed",
        progressDescription: "Completado",
      });
    } finally {
      closeContext(context);
    }
  });

  it("returns 404 for an unknown job", async () => {
    const context = createTestContext();
    try {
      const appWithJobs = createApp({
        config: testConfig(),
        logger: pino({ level: "silent" }),
        lifecycle: context.lifecycle,
        indexingJobs: { find: () => undefined },
      });

      const response = await request(appWithJobs)
        .get(`/api/v1/admin/jobs/${randomUUID()}/status`)
        .set("Authorization", `Bearer ${AUTH_TOKEN}`);

      expect(response.status).toBe(404);
    } finally {
      closeContext(context);
    }
  });

  it("returns 400 for a malformed job id", async () => {
    const context = createTestContext();
    try {
      const appWithJobs = createApp({
        config: testConfig(),
        logger: pino({ level: "silent" }),
        lifecycle: context.lifecycle,
        indexingJobs: { find: () => undefined },
      });

      const response = await request(appWithJobs)
        .get("/api/v1/admin/jobs/not-a-uuid/status")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`);

      expect(response.status).toBe(400);
    } finally {
      closeContext(context);
    }
  });
});
