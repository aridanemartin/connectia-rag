import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import type { DocumentVersion } from "../documents/document.types.js";
import {
  type PdfExtractor,
  PdfProcessingError,
} from "../documents/pdf-extractor.js";
import {
  type Chunk,
  type TextChunker,
  TextChunkingError,
} from "../documents/text-chunker.js";
import type { RetryingUploadCleaner } from "../documents/upload-storage.js";
import type { ModelProvider } from "../models/model-provider.js";
import type { IndexingJob } from "../persistence/repositories/indexing-job.repository.js";
import { VectorStoreError } from "../rag/qdrant-vector-store.js";
import type { ChunkPayload, VectorStore } from "../rag/vector-store.js";
import type { Clock } from "../shared/clock.js";

export const INDEXING_STAGES = {
  extracting: 15,
  chunking: 35,
  embedding: 55,
  storing: 85,
  finalizing: 95,
  completed: 100,
} as const;

const RETRY_DELAYS_MS = [250, 500, 1000] as const;

type ProcessingStage =
  | "extracting"
  | "chunking"
  | "embedding"
  | "storing"
  | "finalizing";

type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface IndexingJobLeaseRepository {
  leaseNext(owner: string, leaseMs: number): IndexingJob | undefined;
  progress(
    jobId: string,
    owner: string,
    stage: string,
    progress: number,
  ): IndexingJob;
  complete(jobId: string, owner: string): IndexingJob;
  fail(
    jobId: string,
    owner: string,
    code: string,
    message: string,
  ): IndexingJob;
  release(jobId: string, owner: string): IndexingJob;
  recoverExpired(): number;
}

export interface IndexingDocumentStateWriter {
  findVersion(versionId: string): DocumentVersion | undefined;
  markReady(versionId: string): DocumentVersion;
  markFailed(versionId: string): DocumentVersion;
}

export interface IndexingWorkerDependencies {
  jobs: IndexingJobLeaseRepository;
  documents: IndexingDocumentStateWriter;
  extractor: Pick<PdfExtractor, "extract">;
  chunker: Pick<TextChunker, "split">;
  models: Pick<ModelProvider, "embedDocuments">;
  vectorStore: Pick<
    VectorStore,
    "ensureCollection" | "upsert" | "deleteVersion"
  >;
  cleaner: Pick<RetryingUploadCleaner, "remove">;
  clock: Clock;
  owner: string;
  leaseMs: number;
  embedBatchSize: number;
  pollIntervalMs: number;
  embeddingDimensions: number;
  sleep?: SleepFn;
}

/**
 * Classifies a caught error as a typed transient dependency failure eligible
 * for bounded retry. Everything else — including a bare `Error`, any
 * `PdfProcessingError`, `TextChunkingError`, or `VectorStoreError` — is
 * treated as non-transient and must fail immediately on first attempt.
 */
export function isTransientDependencyError(error: unknown): boolean {
  return classifyTransient(error, 0);
}

function classifyTransient(error: unknown, depth: number): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name =
    "name" in error && typeof error.name === "string" ? error.name : undefined;
  if (name === "AbortError" || name === "TimeoutError") {
    return true;
  }
  const code =
    "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (
    code !== undefined &&
    (
      [
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
        "EAI_AGAIN",
        "EPIPE",
        "ENOTFOUND",
      ] as const
    ).includes(code as never)
  ) {
    return true;
  }
  const status =
    "status" in error && typeof error.status === "number"
      ? error.status
      : "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
  if (status !== undefined && (status === 429 || status >= 500)) {
    return true;
  }
  if (
    depth === 0 &&
    "cause" in error &&
    error.cause !== undefined &&
    error.cause !== error
  ) {
    return classifyTransient(error.cause, depth + 1);
  }
  return false;
}

function isLeaseLostError(error: unknown): boolean {
  return error instanceof Error && error.name === "LeaseLostError";
}

function chunkPayload(chunk: Chunk): ChunkPayload {
  return {
    documentId: chunk.documentId,
    versionId: chunk.versionId,
    documentTitle: chunk.documentTitle,
    academicYear: chunk.academicYear,
    page: chunk.page,
    section: chunk.section,
    chunkIndex: chunk.chunkIndex,
    contentHash: chunk.contentHash,
    text: chunk.text,
  };
}

export class IndexingWorker {
  private signal: AbortSignal = new AbortController().signal;

  constructor(private readonly deps: IndexingWorkerDependencies) {}

  async runOnce(): Promise<"processed" | "idle"> {
    const job = this.deps.jobs.leaseNext(this.deps.owner, this.deps.leaseMs);
    if (!job) {
      return "idle";
    }
    try {
      await this.process(job);
    } finally {
      await this.deps.cleaner.remove(job.tempFilePath).catch(() => undefined);
    }
    return "processed";
  }

  async start(signal: AbortSignal): Promise<void> {
    this.signal = signal;
    while (!signal.aborted) {
      let outcome: "processed" | "idle";
      try {
        outcome = await this.runOnce();
      } catch {
        // Defensive: infrastructure errors (e.g. a broken DB) back off
        // instead of crashing the loop.
        outcome = "idle";
      }
      if (signal.aborted) {
        return;
      }
      if (outcome === "idle") {
        await this.abortAwareSleep(this.deps.pollIntervalMs, signal);
      }
    }
  }

  private async process(job: IndexingJob): Promise<void> {
    let stage: ProcessingStage = "extracting";
    try {
      const version = this.deps.documents.findVersion(job.versionId);
      if (!version) {
        throw new Error("La versión del documento no existe.");
      }

      this.deps.jobs.progress(
        job.id,
        this.deps.owner,
        "extracting",
        INDEXING_STAGES.extracting,
      );
      const pages = await this.deps.extractor.extract(job.tempFilePath);

      stage = "chunking";
      this.deps.jobs.progress(
        job.id,
        this.deps.owner,
        "chunking",
        INDEXING_STAGES.chunking,
      );
      const chunks = await this.deps.chunker.split({
        documentId: job.documentId,
        versionId: job.versionId,
        documentTitle: version.title,
        academicYear: version.academicYear,
        pages,
      });

      stage = "embedding";
      this.deps.jobs.progress(
        job.id,
        this.deps.owner,
        "embedding",
        INDEXING_STAGES.embedding,
      );
      const vectors = await this.embedInBatches(chunks);

      stage = "storing";
      this.deps.jobs.progress(
        job.id,
        this.deps.owner,
        "storing",
        INDEXING_STAGES.storing,
      );
      await this.withRetry(
        () =>
          this.deps.vectorStore.ensureCollection(this.deps.embeddingDimensions),
        isTransientDependencyError,
      );
      const points = chunks.map((chunk, index) => ({
        id: chunk.pointId,
        vector: vectors[index] ?? [],
        payload: chunkPayload(chunk),
      }));
      await this.withRetry(
        () => this.deps.vectorStore.upsert(points),
        isTransientDependencyError,
      );

      stage = "finalizing";
      this.deps.jobs.progress(
        job.id,
        this.deps.owner,
        "finalizing",
        INDEXING_STAGES.finalizing,
      );
      this.deps.documents.markReady(job.versionId);

      this.deps.jobs.complete(job.id, this.deps.owner);
    } catch (error) {
      if (isLeaseLostError(error)) {
        // Another owner already reclaimed this job's fate; attempt no
        // further mutation and let recoverExpired() sort it out later.
        return;
      }
      try {
        await this.handleTerminalFailure(job, error, stage);
      } catch {
        // A job we already tried and failed to fail must never crash the
        // loop.
      }
    }
  }

  private async handleTerminalFailure(
    job: IndexingJob,
    error: unknown,
    stage: ProcessingStage,
  ): Promise<void> {
    await this.deps.vectorStore
      .deleteVersion(job.versionId)
      .catch(() => undefined);
    try {
      this.deps.documents.markFailed(job.versionId);
    } catch {
      // Best-effort: the version may have already transitioned or been
      // touched concurrently. This must never block the fail() call below.
    }
    const { code, message } = this.classifyError(error, stage);
    try {
      this.deps.jobs.fail(job.id, this.deps.owner, code, message);
    } catch (failError) {
      if (!isLeaseLostError(failError)) {
        throw failError;
      }
    }
  }

  private classifyError(
    error: unknown,
    stage: ProcessingStage,
  ): { code: string; message: string } {
    if (error instanceof PdfProcessingError) {
      return { code: error.code, message: error.message };
    }
    if (error instanceof TextChunkingError) {
      return { code: error.code, message: error.message };
    }
    if (error instanceof VectorStoreError) {
      return {
        code: error.code,
        message: "No se ha podido almacenar el contenido indexado.",
      };
    }
    if (stage === "embedding") {
      return {
        code: "EMBEDDING_GENERATION_FAILED",
        message: "No se han podido generar los embeddings del documento.",
      };
    }
    if (stage === "storing") {
      return {
        code: "VECTOR_STORE_UNAVAILABLE",
        message: "No se ha podido almacenar el contenido indexado.",
      };
    }
    return {
      code: "INDEXING_FAILED",
      message: "No se ha podido completar la indexación.",
    };
  }

  private async embedInBatches(chunks: readonly Chunk[]): Promise<number[][]> {
    const texts = chunks.map((chunk) => chunk.text);
    const vectors: number[][] = [];
    for (
      let start = 0;
      start < texts.length;
      start += this.deps.embedBatchSize
    ) {
      const batch = texts.slice(start, start + this.deps.embedBatchSize);
      const batchVectors = await this.withRetry(
        () => this.deps.models.embedDocuments(batch),
        isTransientDependencyError,
      );
      vectors.push(...batchVectors);
    }
    return vectors;
  }

  private async withRetry<T>(
    operation: () => Promise<T>,
    isTransient: (error: unknown) => boolean,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!isTransient(error) || attempt === RETRY_DELAYS_MS.length) {
          throw error;
        }
        await this.sleep(RETRY_DELAYS_MS[attempt] ?? 0);
      }
    }
    throw lastError;
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : setTimeoutPromise(ms);
  }

  private async abortAwareSleep(
    ms: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await setTimeoutPromise(ms, undefined, { signal });
    } catch {
      // Resolve immediately on early cancellation instead of throwing.
    }
  }
}
