import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { loadConfig } from "../../src/config/env.js";
import {
  createIndexingComposition,
  type IndexingComposition,
} from "../../src/documents/indexing.service.js";
import { PdfExtractor } from "../../src/documents/pdf-extractor.js";
import { TextChunker } from "../../src/documents/text-chunker.js";
import { RetryingUploadCleaner } from "../../src/documents/upload-storage.js";
import { DocumentRepository } from "../../src/persistence/repositories/document.repository.js";
import { IndexingJobRepository } from "../../src/persistence/repositories/indexing-job.repository.js";
import { systemClock } from "../../src/shared/clock.js";
import { IndexingWorker } from "../../src/workers/indexing.worker.js";
import { createTestPdf } from "../support/create-test-pdf.js";

const AUTH_TOKEN = "test-auth-token-with-at-least-32-characters";
const temporaryDirectories: string[] = [];
const compositions: IndexingComposition[] = [];

async function createTestContext(overrides: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), "connectia-indexing-status-test-"));
  temporaryDirectories.push(root);
  const uploadDirectory = join(root, "uploads");
  const config = loadConfig({
    AUTH_TOKEN,
    DATABASE_PATH: join(root, "connectia.sqlite"),
    TEMP_DIR: uploadDirectory,
    ...overrides,
  });
  const composition = createIndexingComposition(config);
  compositions.push(composition);
  return {
    app: createApp({
      config,
      logger: pino({ level: "silent" }),
      indexingService: composition.indexingService,
      indexingJobs: composition.jobs,
    }),
    composition,
    config,
    root,
    uploadDirectory,
  };
}

afterEach(async () => {
  for (const composition of compositions.splice(0)) {
    composition.close();
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function fakeModels() {
  return {
    embedDocuments: vi.fn(async (texts: string[]) =>
      texts.map(() => [0.1, 0.2, 0.3]),
    ),
  };
}

function fakeVectorStore() {
  return {
    ensureCollection: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    deleteVersion: vi.fn().mockResolvedValue(undefined),
  };
}

function buildTestWorker(
  context: Awaited<ReturnType<typeof createTestContext>>,
  overrides: { vectorStore?: ReturnType<typeof fakeVectorStore> } = {},
) {
  const documents = new DocumentRepository(
    context.composition.database,
    systemClock,
  );
  const jobs = new IndexingJobRepository(
    context.composition.database,
    systemClock,
  );
  const models = fakeModels();
  const vectorStore = overrides.vectorStore ?? fakeVectorStore();
  const worker = new IndexingWorker({
    jobs,
    documents,
    extractor: new PdfExtractor(),
    chunker: new TextChunker(),
    models,
    vectorStore,
    cleaner: new RetryingUploadCleaner(),
    clock: systemClock,
    owner: "status-test-worker",
    leaseMs: 60_000,
    embedBatchSize: 16,
    pollIntervalMs: 1_000,
    embeddingDimensions: context.config.EMBEDDING_DIMENSIONS,
  });
  return { worker, jobs, documents, models, vectorStore };
}

async function enqueueViaHttp(
  context: Awaited<ReturnType<typeof createTestContext>>,
) {
  const pdfPath = await createTestPdf(context.root, [
    ["MATRÍCULA", "Contenido de prueba con líneas suficientes para indexar."],
  ]);
  const documentId = randomUUID();
  const versionId = randomUUID();
  const response = await request(context.app)
    .post("/api/v1/indexing/jobs")
    .set("Authorization", `Bearer ${AUTH_TOKEN}`)
    .set("Idempotency-Key", `status-${versionId}`)
    .field("documentId", documentId)
    .field("versionId", versionId)
    .field("title", "Matrícula 2026-2027")
    .field("academicYear", "2026-2027")
    .attach("file", pdfPath, {
      filename: "matricula.pdf",
      contentType: "application/pdf",
    });
  expect(response.status).toBe(202);
  return { jobId: response.body.jobId as string, documentId, versionId };
}

describe("GET /api/v1/indexing/jobs/:jobId", () => {
  it("returns the exact queued status contract", async () => {
    const context = await createTestContext();
    const { jobId, documentId, versionId } = await enqueueViaHttp(context);

    const response = await request(context.app)
      .get(`/api/v1/indexing/jobs/${jobId}`)
      .set("Authorization", `Bearer ${AUTH_TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      jobId,
      documentId,
      versionId,
      status: "queued",
      progress: 0,
      stage: "queued",
      errorCode: null,
      errorMessage: null,
      completedAt: null,
    });
  });

  it("reflects processing then completed as the job advances", async () => {
    const context = await createTestContext();
    const { jobId } = await enqueueViaHttp(context);
    const { jobs: directJobs } = buildTestWorker(context);
    directJobs.leaseNext("status-test-worker", 60_000);
    directJobs.progress(jobId, "status-test-worker", "embedding", 55);

    const midflight = await request(context.app)
      .get(`/api/v1/indexing/jobs/${jobId}`)
      .set("Authorization", `Bearer ${AUTH_TOKEN}`);

    expect(midflight.status).toBe(200);
    expect(midflight.body.status).toBe("processing");
    expect(midflight.body.progress).toBeGreaterThan(0);
    expect(midflight.body.stage).not.toBe("queued");

    directJobs.complete(jobId, "status-test-worker");

    const completed = await request(context.app)
      .get(`/api/v1/indexing/jobs/${jobId}`)
      .set("Authorization", `Bearer ${AUTH_TOKEN}`);

    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({
      status: "completed",
      progress: 100,
      stage: "completed",
    });
    expect(completed.body.completedAt).not.toBeNull();
  });

  it("exposes only sanitized error details for a failed job", async () => {
    const context = await createTestContext();
    const { jobId } = await enqueueViaHttp(context);
    const { worker, vectorStore } = buildTestWorker(context);
    vectorStore.upsert.mockRejectedValueOnce(
      new Error(`connection details leaked from ${context.uploadDirectory}`),
    );

    const outcome = await worker.runOnce();
    expect(outcome).toBe("processed");

    const response = await request(context.app)
      .get(`/api/v1/indexing/jobs/${jobId}`)
      .set("Authorization", `Bearer ${AUTH_TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("failed");
    expect(response.body.errorCode).toBe("VECTOR_STORE_UNAVAILABLE");
    expect(response.body.errorMessage).not.toContain(context.uploadDirectory);
    expect(response.body.errorMessage).not.toContain("connection details");
    expect(response.body.errorMessage).not.toMatch(/\/tmp\//);
    expect(JSON.stringify(response.body)).not.toContain("at ");
  });

  it("requires authentication before returning a job status", async () => {
    const context = await createTestContext();
    const { jobId } = await enqueueViaHttp(context);

    const response = await request(context.app).get(
      `/api/v1/indexing/jobs/${jobId}`,
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns a safe 404 for an unknown but well-formed job id", async () => {
    const context = await createTestContext();

    const response = await request(context.app)
      .get(`/api/v1/indexing/jobs/${randomUUID()}`)
      .set("Authorization", `Bearer ${AUTH_TOKEN}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toEqual({
      code: "INDEXING_JOB_NOT_FOUND",
      message: expect.any(String),
      requestId: response.headers["x-request-id"],
    });
  });

  it("returns 400 for a malformed job id", async () => {
    const context = await createTestContext();

    const response = await request(context.app)
      .get("/api/v1/indexing/jobs/not-a-uuid")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INDEXING_JOB_ID_INVALID");
  });
});
