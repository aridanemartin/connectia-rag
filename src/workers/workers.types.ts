import type { DocumentVersion } from "../documents/document.types.js";
import type { PdfExtractor } from "../documents/pdf-extractor.js";
import type { TextChunker } from "../documents/text-chunker.js";
import type { RetryingUploadCleaner } from "../documents/upload-storage.js";
import type { ModelProvider } from "../models/models.types.js";
import type {
  CleanupJob,
  IndexingJob,
} from "../persistence/persistence.types.js";
import type { VectorStore } from "../rag/rag.types.js";
import type { Clock } from "../shared/shared.types.js";

// ── cleanup.worker.ts ───────────────────────────────────────────────

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface CleanupJobLeaseRepository {
  leaseNext(owner: string, leaseMs: number): CleanupJob | undefined;
  retry(
    jobId: string,
    owner: string,
    code: string,
    message: string,
    delayMs: number,
  ): CleanupJob;
  complete(jobId: string, owner: string): boolean;
  recoverExpired(): number;
}

export interface CleanupVectorStore {
  deleteVersion(versionId: string): Promise<void>;
}

export interface CleanupWorkerDependencies {
  jobs: CleanupJobLeaseRepository;
  vectorStore: CleanupVectorStore;
  clock: Clock;
  owner: string;
  leaseMs: number;
  pollIntervalMs: number;
  sleep?: SleepFn;
}

// ── indexing.worker.ts ──────────────────────────────────────────────

export type ProcessingStage =
  | "extracting"
  | "chunking"
  | "embedding"
  | "storing"
  | "finalizing";

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
