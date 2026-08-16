import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type IndexingRequest,
  IndexingService,
} from "../../src/documents/indexing.service.js";
import { PdfExtractor } from "../../src/documents/pdf-extractor.js";
import { TextChunker } from "../../src/documents/text-chunker.js";
import { RetryingUploadCleaner } from "../../src/documents/upload-storage.js";
import {
  closeDatabase,
  type DatabaseConnection,
  openDatabase,
} from "../../src/persistence/database.js";
import { migrate } from "../../src/persistence/migrate.js";
import { DocumentRepository } from "../../src/persistence/repositories/document.repository.js";
import { IndexingJobRepository } from "../../src/persistence/repositories/indexing-job.repository.js";
import type { Clock } from "../../src/shared/clock.js";
import { IndexingWorker } from "../../src/workers/indexing.worker.js";
import { createTestPdf } from "../support/create-test-pdf.js";

class MutableClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

const temporaryDirectories: string[] = [];
const openDatabases: DatabaseConnection[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    closeDatabase(database);
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

interface SetupOverrides {
  leaseMs?: number;
  embedBatchSize?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

async function setup(overrides: SetupOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "connectia-worker-test-"));
  temporaryDirectories.push(root);
  const database = openDatabase(":memory:");
  openDatabases.push(database);
  migrate(database);
  const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
  const documents = new DocumentRepository(database, clock);
  const jobs = new IndexingJobRepository(database, clock);
  const indexingService = new IndexingService(database, documents, jobs);
  const models = fakeModels();
  const vectorStore = fakeVectorStore();
  const worker = new IndexingWorker({
    jobs,
    documents,
    extractor: new PdfExtractor(),
    chunker: new TextChunker(),
    models,
    vectorStore,
    cleaner: new RetryingUploadCleaner(),
    clock,
    owner: "worker-1",
    leaseMs: overrides.leaseMs ?? 60_000,
    embedBatchSize: overrides.embedBatchSize ?? 16,
    pollIntervalMs: 1_000,
    embeddingDimensions: 3,
    sleep: overrides.sleep,
  });
  return {
    root,
    database,
    clock,
    documents,
    jobs,
    indexingService,
    models,
    vectorStore,
    worker,
  };
}

interface EnqueueOverrides {
  documentId?: string;
  versionId?: string;
  idempotencyKey?: string;
  title?: string;
  academicYear?: string;
}

async function enqueueJob(
  ctx: Awaited<ReturnType<typeof setup>>,
  pdfPath: string,
  overrides: EnqueueOverrides = {},
) {
  const documentId = overrides.documentId ?? randomUUID();
  const versionId = overrides.versionId ?? randomUUID();
  const title = overrides.title ?? "Normativa de matrícula";
  const academicYear = overrides.academicYear ?? "2026-2027";
  const input: IndexingRequest = {
    idempotencyKey: overrides.idempotencyKey ?? `key-${versionId}`,
    documentId,
    versionId,
    title,
    academicYear,
    description: null,
    tempFilePath: pdfPath,
  };
  const job = await ctx.indexingService.enqueue(input);
  return { job, documentId, versionId, title, academicYear };
}

describe("IndexingWorker", () => {
  it("processes a queued job end-to-end and stores the expected vector points", async () => {
    const ctx = await setup();
    const pdfPath = await createTestPdf(ctx.root, [
      [
        "MATRÍCULA",
        "El plazo de matrícula termina el 15 de julio de 2026 para todo el alumnado.",
      ],
    ]);
    const expectedPages = await new PdfExtractor().extract(pdfPath);
    const { job, documentId, versionId, title, academicYear } =
      await enqueueJob(ctx, pdfPath);
    const expectedChunks = await new TextChunker().split({
      documentId,
      versionId,
      documentTitle: title,
      academicYear,
      pages: expectedPages,
    });

    const outcome = await ctx.worker.runOnce();

    expect(outcome).toBe("processed");
    const finalJob = ctx.jobs.find(job.id);
    expect(finalJob).toMatchObject({
      status: "completed",
      stage: "completed",
      progress: 100,
      errorCode: null,
      errorMessage: null,
    });
    expect(finalJob?.completedAt).not.toBeNull();
    expect(ctx.documents.findVersion(versionId)?.state).toBe("READY");
    expect(ctx.vectorStore.upsert).toHaveBeenCalledTimes(1);
    const [points] = ctx.vectorStore.upsert.mock.calls[0] as [
      { id: string; vector: number[]; payload: Record<string, unknown> }[],
    ];
    expect(points).toHaveLength(expectedChunks.length);
    expectedChunks.forEach((chunk, index) => {
      expect(points[index]?.id).toBe(chunk.pointId);
      expect(points[index]?.payload.text).toBe(chunk.text);
      expect(points[index]?.payload.page).toBe(chunk.page);
      expect(points[index]?.payload.section).toBe(chunk.section);
    });
    expect(existsSync(job.tempFilePath)).toBe(false);
  });

  it("returns idle when there are no queued jobs", async () => {
    const ctx = await setup();

    expect(await ctx.worker.runOnce()).toBe("idle");
  });

  it("fails an unextractable PDF with a safe code and marks the version FAILED", async () => {
    const ctx = await setup();
    const pdfPath = await createTestPdf(ctx.root, [["a"]]);
    const { job, versionId } = await enqueueJob(ctx, pdfPath);

    const outcome = await ctx.worker.runOnce();

    expect(outcome).toBe("processed");
    const finalJob = ctx.jobs.find(job.id);
    expect(finalJob?.status).toBe("failed");
    expect(finalJob?.errorCode).toBe("PDF_TEXT_NOT_FOUND");
    expect(ctx.documents.findVersion(versionId)?.state).toBe("FAILED");
    expect(existsSync(job.tempFilePath)).toBe(false);
    expect(ctx.models.embedDocuments).not.toHaveBeenCalled();
    expect(ctx.vectorStore.upsert).not.toHaveBeenCalled();
  });

  it("fails the job with a safe code when the vector store rejects a non-transient error", async () => {
    const ctx = await setup();
    const pdfPath = await createTestPdf(ctx.root, [
      ["MATRÍCULA", "Contenido de prueba con líneas suficientes para indexar."],
    ]);
    const { job, versionId } = await enqueueJob(ctx, pdfPath);
    ctx.vectorStore.upsert.mockRejectedValueOnce(
      new Error("connection details must not leak"),
    );

    const outcome = await ctx.worker.runOnce();

    expect(outcome).toBe("processed");
    const finalJob = ctx.jobs.find(job.id);
    expect(finalJob?.status).toBe("failed");
    expect(finalJob?.errorCode).toBe("VECTOR_STORE_UNAVAILABLE");
    expect(finalJob?.errorMessage).not.toContain("connection details");
    expect(ctx.vectorStore.deleteVersion).toHaveBeenCalledWith(versionId);
    expect(ctx.vectorStore.upsert).toHaveBeenCalledTimes(1);
    expect(ctx.documents.findVersion(versionId)?.state).toBe("FAILED");
  });

  it("retries a transient vector store failure and completes on the third attempt", async () => {
    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });
    const ctx = await setup({ sleep });
    const pdfPath = await createTestPdf(ctx.root, [
      ["MATRÍCULA", "Contenido de prueba con líneas suficientes para indexar."],
    ]);
    const { job } = await enqueueJob(ctx, pdfPath);
    let calls = 0;
    ctx.vectorStore.upsert.mockImplementation(async () => {
      calls += 1;
      if (calls < 3) {
        throw Object.assign(new Error("x"), { code: "ECONNRESET" });
      }
    });

    const outcome = await ctx.worker.runOnce();

    expect(outcome).toBe("processed");
    expect(ctx.jobs.find(job.id)?.status).toBe("completed");
    expect(ctx.vectorStore.upsert).toHaveBeenCalledTimes(3);
    expect(sleepCalls).toEqual([250, 500]);
  });

  it("fails after exhausting the retry budget for a transient vector store failure", async () => {
    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });
    const ctx = await setup({ sleep });
    const pdfPath = await createTestPdf(ctx.root, [
      ["MATRÍCULA", "Contenido de prueba con líneas suficientes para indexar."],
    ]);
    const { job } = await enqueueJob(ctx, pdfPath);
    ctx.vectorStore.upsert.mockImplementation(async () => {
      throw Object.assign(new Error("x"), { code: "ECONNREFUSED" });
    });

    const outcome = await ctx.worker.runOnce();

    expect(outcome).toBe("processed");
    const finalJob = ctx.jobs.find(job.id);
    expect(finalJob?.status).toBe("failed");
    expect(finalJob?.errorCode).toBe("VECTOR_STORE_UNAVAILABLE");
    expect(ctx.vectorStore.upsert).toHaveBeenCalledTimes(4);
    expect(sleepCalls).toEqual([250, 500, 1000]);
  });

  it("composes with recoverExpired so a reclaimed job completes under a new owner", async () => {
    const ctx = await setup();
    const pdfPath = await createTestPdf(ctx.root, [
      ["MATRÍCULA", "Contenido de prueba con líneas suficientes para indexar."],
    ]);
    const { job } = await enqueueJob(ctx, pdfPath);
    ctx.jobs.leaseNext("stale-owner", 10);
    ctx.clock.advance(11);
    expect(ctx.jobs.recoverExpired()).toBe(1);
    expect(ctx.jobs.find(job.id)?.status).toBe("queued");

    const outcome = await ctx.worker.runOnce();

    expect(outcome).toBe("processed");
    expect(ctx.jobs.find(job.id)?.status).toBe("completed");
  });

  it("does not crash when its lease expires mid-processing", async () => {
    const ctx = await setup({ leaseMs: 1 });
    const pdfPath = await createTestPdf(ctx.root, [
      ["MATRÍCULA", "Contenido de prueba con líneas suficientes para indexar."],
    ]);
    const { job } = await enqueueJob(ctx, pdfPath);
    ctx.models.embedDocuments.mockImplementation(async (texts: string[]) => {
      ctx.clock.advance(1_000);
      const otherJobs = new IndexingJobRepository(ctx.database, ctx.clock);
      otherJobs.recoverExpired();
      otherJobs.leaseNext("other-owner", 60_000);
      return texts.map(() => [0.1, 0.2, 0.3]);
    });

    const outcome = await ctx.worker.runOnce();

    expect(outcome).toBe("processed");
    const finalJob = ctx.jobs.find(job.id);
    expect(finalJob?.status).toBe("processing");
    expect(finalJob?.leaseOwner).toBe("other-owner");
  });

  it("still removes the temp file when the best-effort markFailed itself throws", async () => {
    const ctx = await setup();
    const pdfPath = await createTestPdf(ctx.root, [["a"]]);
    const { job, versionId } = await enqueueJob(ctx, pdfPath);
    ctx.documents.markReady(versionId);

    const outcome = await ctx.worker.runOnce();

    expect(outcome).toBe("processed");
    const finalJob = ctx.jobs.find(job.id);
    expect(finalJob?.status).toBe("failed");
    expect(finalJob?.errorCode).toBe("PDF_TEXT_NOT_FOUND");
    expect(existsSync(job.tempFilePath)).toBe(false);
  });

  it("embeds in bounded batches not exceeding the configured size", async () => {
    const ctx = await setup({ embedBatchSize: 2 });
    const sentence =
      "Apartado dedicado a la matrícula del curso académico, formalizada dentro del plazo establecido por la universidad para el alumnado.";
    const lines = Array.from(
      { length: 20 },
      (_, index) => `${sentence} Punto ${index + 1}.`,
    );
    const pdfPath = await createTestPdf(ctx.root, [
      ["NORMATIVA DE MATRÍCULA", ...lines],
      ["NORMATIVA DE MATRÍCULA", ...lines],
      ["NORMATIVA DE MATRÍCULA", ...lines],
    ]);
    const { job } = await enqueueJob(ctx, pdfPath);

    const outcome = await ctx.worker.runOnce();

    expect(outcome).toBe("processed");
    expect(ctx.jobs.find(job.id)?.status).toBe("completed");
    expect(ctx.models.embedDocuments.mock.calls.length).toBeGreaterThan(1);
    for (const [batch] of ctx.models.embedDocuments.mock.calls) {
      expect((batch as string[]).length).toBeLessThanOrEqual(2);
    }
  });

  it("fails with EMBEDDING_GENERATION_FAILED when a non-transient error occurs during embedding", async () => {
    const ctx = await setup();
    const pdfPath = await createTestPdf(ctx.root, [
      ["MATRÍCULA", "Contenido de prueba con líneas suficientes para indexar."],
    ]);
    const { job, versionId } = await enqueueJob(ctx, pdfPath);
    ctx.models.embedDocuments.mockRejectedValueOnce(
      new Error("private embedding backend detail"),
    );

    const outcome = await ctx.worker.runOnce();

    expect(outcome).toBe("processed");
    const finalJob = ctx.jobs.find(job.id);
    expect(finalJob?.status).toBe("failed");
    expect(finalJob?.errorCode).toBe("EMBEDDING_GENERATION_FAILED");
    expect(finalJob?.errorMessage).not.toContain("private embedding backend");
    expect(ctx.documents.findVersion(versionId)?.state).toBe("FAILED");
    expect(ctx.vectorStore.upsert).not.toHaveBeenCalled();
    expect(ctx.models.embedDocuments).toHaveBeenCalledTimes(1);
  });

  it("releases the job's lease instead of abandoning it when asked to stop mid-processing", async () => {
    const ctx = await setup();
    const pdfPath = await createTestPdf(ctx.root, [
      ["MATRÍCULA", "Contenido de prueba con líneas suficientes para indexar."],
    ]);
    const { job } = await enqueueJob(ctx, pdfPath);
    const controller = new AbortController();
    ctx.models.embedDocuments.mockImplementation(async (texts: string[]) => {
      // Simulate shutdown being requested while embedding is in flight; the
      // worker must finish this call naturally, then notice the abort at
      // the next stage boundary (before storing) and release the lease
      // instead of continuing or abandoning the job.
      controller.abort();
      return texts.map(() => [0.1, 0.2, 0.3]);
    });

    await ctx.worker.start(controller.signal);

    const finalJob = ctx.jobs.find(job.id);
    expect(finalJob).toMatchObject({
      status: "queued",
      stage: "queued",
      progress: 0,
      leaseOwner: null,
      leaseUntil: null,
    });
    expect(existsSync(job.tempFilePath)).toBe(true);
    expect(ctx.vectorStore.upsert).not.toHaveBeenCalled();

    // The released job can still be picked up and completed normally by a
    // fresh worker (simulating the next process) since the temp file
    // survived the graceful release.
    ctx.models.embedDocuments.mockReset();
    ctx.models.embedDocuments.mockImplementation(async (texts: string[]) =>
      texts.map(() => [0.1, 0.2, 0.3]),
    );
    const secondWorker = new IndexingWorker({
      jobs: ctx.jobs,
      documents: ctx.documents,
      extractor: new PdfExtractor(),
      chunker: new TextChunker(),
      models: ctx.models,
      vectorStore: ctx.vectorStore,
      cleaner: new RetryingUploadCleaner(),
      clock: ctx.clock,
      owner: "worker-2",
      leaseMs: 60_000,
      embedBatchSize: 16,
      pollIntervalMs: 1_000,
      embeddingDimensions: 3,
    });

    const secondOutcome = await secondWorker.runOnce();
    expect(secondOutcome).toBe("processed");
    expect(ctx.jobs.find(job.id)?.status).toBe("completed");
    expect(existsSync(job.tempFilePath)).toBe(false);
  });

  it("does not delete the temp file when the lease is lost to another owner mid-processing", async () => {
    // Regression guard for the release/abandon distinction: a job whose
    // fate this worker no longer controls (LeaseLostError) must not have
    // its temp file deleted, since the new owner still needs it.
    const ctx = await setup({ leaseMs: 1 });
    const pdfPath = await createTestPdf(ctx.root, [
      ["MATRÍCULA", "Contenido de prueba con líneas suficientes para indexar."],
    ]);
    const { job } = await enqueueJob(ctx, pdfPath);
    ctx.models.embedDocuments.mockImplementation(async (texts: string[]) => {
      ctx.clock.advance(1_000);
      const otherJobs = new IndexingJobRepository(ctx.database, ctx.clock);
      otherJobs.recoverExpired();
      otherJobs.leaseNext("other-owner", 60_000);
      return texts.map(() => [0.1, 0.2, 0.3]);
    });

    const outcome = await ctx.worker.runOnce();

    expect(outcome).toBe("processed");
    expect(ctx.jobs.find(job.id)?.leaseOwner).toBe("other-owner");
    expect(existsSync(job.tempFilePath)).toBe(true);
  });
});
