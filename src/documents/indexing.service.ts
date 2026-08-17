import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AppError } from "../api/errors.js";
import type { AppConfig } from "../config/config.types.js";
import { DiagnosticsService } from "../diagnostics/diagnostics.service.js";
import { OllamaProvider } from "../models/ollama-provider.js";
import {
  closeDatabase,
  type DatabaseConnection,
  openDatabase,
} from "../persistence/database.js";
import { migrate } from "../persistence/migrate.js";
import { CleanupRepository } from "../persistence/repositories/cleanup.repository.js";
import { DiagnosticsRepository } from "../persistence/repositories/diagnostics.repository.js";
import { DocumentRepository } from "../persistence/repositories/document.repository.js";
import {
  type IndexingJob,
  IndexingJobRepository,
} from "../persistence/repositories/indexing-job.repository.js";
import { GenerationGate } from "../rag/generation-gate.js";
import { QdrantVectorStore } from "../rag/qdrant-vector-store.js";
import { QuestionService } from "../rag/question.service.js";
import { type Clock, systemClock } from "../shared/clock.js";
import { CleanupWorker } from "../workers/cleanup.worker.js";
import { IndexingWorker } from "../workers/indexing.worker.js";
import {
  type DocumentWriter,
  type IndexingComposition,
  type IndexingDocumentInput,
  type IndexingEnqueuer,
  type IndexingRequest,
  type JobWriter,
  PersistenceConflictError,
} from "./document.types.js";
import { LifecycleService } from "./lifecycle.service.js";
import { PdfExtractor } from "./pdf-extractor.js";
import { TextChunker } from "./text-chunker.js";
import {
  RetryingUploadCleaner,
  sweepOrphanUploads,
  type UploadUnlink,
} from "./upload-storage.js";

export type {
  DocumentWriter,
  IndexingComposition,
  IndexingEnqueuer,
  IndexingRequest,
  JobWriter,
} from "./document.types.js";

function canonicalMetadata(input: IndexingRequest): string {
  return JSON.stringify({
    documentId: input.documentId,
    versionId: input.versionId,
    title: input.title,
    academicYear: input.academicYear,
    description: input.description,
  });
}

function ensureIndexingActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError(
      503,
      "INDEXING_ABORTED",
      "La indexación se ha cancelado.",
    );
  }
}

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const header = Buffer.alloc(5);
  let headerBytes = 0;
  const input = createReadStream(path);
  const onAbort = () => input.destroy();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of input) {
      ensureIndexingActive(signal);
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (headerBytes < header.length) {
        const copied = bytes.copy(
          header,
          headerBytes,
          0,
          Math.min(bytes.length, header.length - headerBytes),
        );
        headerBytes += copied;
      }
      hash.update(bytes);
    }
  } catch {
    ensureIndexingActive(signal);
    throw new AppError(
      500,
      "UPLOAD_PROCESSING_FAILED",
      "No se ha podido preparar el PDF.",
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  ensureIndexingActive(signal);
  if (headerBytes !== header.length || header.toString("ascii") !== "%PDF-") {
    throw new AppError(
      400,
      "PDF_SIGNATURE_INVALID",
      "El archivo no tiene una firma PDF válida.",
    );
  }
  return hash.digest("hex");
}

/**
 * Accepts indexing requests: verifies the PDF signature, computes content
 * and request hashes, and idempotently enqueues an indexing job inside a
 * database transaction. Key method: enqueue(input, signal).
 */
export class IndexingService implements IndexingEnqueuer {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly documents: DocumentWriter,
    private readonly jobs: JobWriter,
  ) {}

  async enqueue(
    input: IndexingRequest,
    signal?: AbortSignal,
  ): Promise<IndexingJob> {
    ensureIndexingActive(signal);
    const contentHash = await hashFile(input.tempFilePath, signal);
    const requestHash = createHash("sha256")
      .update(contentHash + canonicalMetadata(input), "utf8")
      .digest("hex");

    ensureIndexingActive(signal);
    const persist = this.database.transaction(() => {
      const existing = this.jobs.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new AppError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "La clave de idempotencia ya se utilizó con otra solicitud.",
          );
        }
        return existing;
      }

      const document: IndexingDocumentInput = {
        documentId: input.documentId,
        versionId: input.versionId,
        title: input.title,
        academicYear: input.academicYear,
        description: input.description,
        contentHash,
      };
      this.documents.upsertIndexing(document);
      return this.jobs.enqueue({
        id: randomUUID(),
        documentId: input.documentId,
        versionId: input.versionId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        contentHash,
        tempFilePath: input.tempFilePath,
      });
    }).immediate;

    try {
      return persist();
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (error instanceof PersistenceConflictError) {
        throw new AppError(
          409,
          "INDEXING_CONFLICT",
          "Los identificadores ya pertenecen a otro contenido.",
        );
      }
      throw error;
    }
  }
}

export function createIndexingComposition(
  config: AppConfig,
  clock: Clock = systemClock,
  uploadUnlink?: UploadUnlink,
): IndexingComposition {
  if (config.DATABASE_PATH !== ":memory:") {
    mkdirSync(dirname(resolve(config.DATABASE_PATH)), {
      recursive: true,
      mode: 0o700,
    });
  }
  const database = openDatabase(config.DATABASE_PATH);
  try {
    migrate(database);
    const jobs = new IndexingJobRepository(database, clock);
    const documents = new DocumentRepository(database, clock);
    const cleanups = new CleanupRepository(database, clock);
    const indexingService = new IndexingService(database, documents, jobs);
    const lifecycle = new LifecycleService(documents);
    const cleaner = new RetryingUploadCleaner(uploadUnlink);
    const owner = randomUUID();
    const cleanupOwner = randomUUID();
    const extractor = new PdfExtractor();
    const chunker = new TextChunker();
    const models = new OllamaProvider(config);
    const vectorStore = new QdrantVectorStore(config);
    const worker = new IndexingWorker({
      jobs,
      documents,
      extractor,
      chunker,
      models,
      vectorStore,
      cleaner,
      clock,
      owner,
      leaseMs: config.INDEXING_LEASE_MS,
      embedBatchSize: config.INDEXING_EMBED_BATCH_SIZE,
      pollIntervalMs: config.INDEXING_POLL_INTERVAL_MS,
      embeddingDimensions: config.EMBEDDING_DIMENSIONS,
    });
    const cleanupWorker = new CleanupWorker({
      jobs: cleanups,
      vectorStore,
      clock,
      owner: cleanupOwner,
      leaseMs: config.INDEXING_LEASE_MS,
      pollIntervalMs: config.INDEXING_POLL_INTERVAL_MS,
    });
    const diagnosticsRepository = new DiagnosticsRepository(database, clock);
    const diagnostics = new DiagnosticsService({
      repository: diagnosticsRepository,
      enabled: config.DIAGNOSTICS_ENABLED,
      ttlHours: config.DIAGNOSTICS_TTL_HOURS,
      clock,
    });
    const questionService = new QuestionService({
      model: models,
      vectorStore,
      gate: new GenerationGate({
        concurrency: config.MAX_ACTIVE_GENERATIONS,
        maxQueued: config.MAX_QUEUED_GENERATIONS,
        timeoutMs: config.QUESTION_QUEUE_TIMEOUT_MS,
      }),
      topK: config.RAG_TOP_K,
      scoreThreshold: config.RAG_SCORE_THRESHOLD,
      diagnostics,
    });
    return {
      indexingService,
      jobs,
      worker,
      lifecycle,
      cleanupWorker,
      questionService,
      diagnostics,
      database,
      sweepOrphans: () =>
        sweepOrphanUploads(
          config.TEMP_DIR,
          new Set(jobs.liveTempFilePaths()),
          cleaner,
        ),
      recoverExpiredJobs: () => jobs.recoverExpired(),
      recoverExpiredCleanupJobs: () => cleanups.recoverExpired(),
      close: () => closeDatabase(database),
    };
  } catch (error) {
    closeDatabase(database);
    throw error;
  }
}
