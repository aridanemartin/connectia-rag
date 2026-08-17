import type { DiagnosticsService } from "../diagnostics/diagnostics.service.js";
import type {
  DatabaseConnection,
  IndexingJob,
} from "../persistence/persistence.types.js";
import type { DocumentRepository } from "../persistence/repositories/document.repository.js";
import type { IndexingJobRepository } from "../persistence/repositories/indexing-job.repository.js";
import type { QuestionService } from "../rag/question.service.js";
import type { ChunkPayload } from "../rag/rag.types.js";
import type { CleanupWorker } from "../workers/cleanup.worker.js";
import type { IndexingWorker } from "../workers/indexing.worker.js";
import type { IndexingService } from "./indexing.service.js";
import type { LifecycleService } from "./lifecycle.service.js";

export const documentVersionStates = [
  "INDEXING",
  "READY",
  "ACTIVE",
  "FAILED",
  "ARCHIVED",
] as const;

export type DocumentVersionState = (typeof documentVersionStates)[number];

export interface IndexingDocumentInput {
  documentId: string;
  versionId: string;
  title: string;
  academicYear: string;
  description?: string | null;
  contentHash: string;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  title: string;
  description: string | null;
  academicYear: string;
  contentHash: string;
  state: DocumentVersionState;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  activatedAt: string | null;
  archivedAt: string | null;
  failedAt: string | null;
}

// ── indexing.service.ts ─────────────────────────────────────────────

export interface IndexingRequest {
  idempotencyKey: string;
  documentId: string;
  versionId: string;
  title: string;
  academicYear: string;
  description: string | null;
  tempFilePath: string;
}

export interface IndexingEnqueuer {
  enqueue(input: IndexingRequest, signal?: AbortSignal): Promise<IndexingJob>;
}

export type DocumentWriter = Pick<DocumentRepository, "upsertIndexing">;

export type JobWriter = Pick<
  IndexingJobRepository,
  "enqueue" | "findByIdempotencyKey"
>;

export interface IndexingComposition {
  indexingService: IndexingService;
  jobs: Pick<IndexingJobRepository, "find">;
  worker: IndexingWorker;
  lifecycle: LifecycleService;
  cleanupWorker: CleanupWorker;
  questionService: QuestionService;
  diagnostics: DiagnosticsService;
  database: DatabaseConnection;
  sweepOrphans(): Promise<number>;
  recoverExpiredJobs(): number;
  recoverExpiredCleanupJobs(): number;
  close(): void;
}

// ── lifecycle.service.ts ────────────────────────────────────────────

export interface LifecycleServiceReader {
  activate(documentId: string, versionId: string): DocumentVersion;
  archive(documentId: string, versionId: string): DocumentVersion;
  activeVersionIds(): string[];
  activeVersionIdsByDocumentIds(documentIds: readonly string[]): string[];
  previewVersionIds(documentId: string, versionId: string): string[];
}

export interface LifecycleReader {
  activate(documentId: string, versionId: string): DocumentVersion;
  archive(documentId: string, versionId: string): DocumentVersion;
  allowedActiveVersions(): string[];
  allowedActiveVersionsByDocumentIds(documentIds: readonly string[]): string[];
  allowedPreviewVersions(documentId: string, versionId: string): string[];
}

// ── pdf-extractor.ts ────────────────────────────────────────────────

export interface ExtractedPage {
  page: number;
  text: string;
}

export interface LoadedPdfDocument {
  pageContent: unknown;
  metadata: unknown;
}

export interface PdfDocumentLoader {
  load(): Promise<readonly LoadedPdfDocument[]>;
}

export type PdfLoaderFactory = (path: string) => PdfDocumentLoader;

export type PdfProcessingErrorCode =
  | "PDF_SIGNATURE_INVALID"
  | "PDF_CORRUPT"
  | "PDF_ENCRYPTED"
  | "PDF_PARSE_FAILED"
  | "PDF_METADATA_INVALID"
  | "PDF_TEXT_NOT_FOUND";

// ── text-chunker.ts ─────────────────────────────────────────────────

export interface ChunkInput {
  documentId: string;
  versionId: string;
  documentTitle: string;
  academicYear: string;
  pages: readonly ExtractedPage[];
}

export interface Chunk extends ChunkPayload {
  pointId: string;
}

export type TextChunkingErrorCode =
  | "PDF_PAGE_METADATA_INVALID"
  | "PDF_CHUNK_EMPTY";

export interface PageSection {
  section: string | null;
  text: string;
}

// ── upload-storage.ts ───────────────────────────────────────────────

export type UploadUnlink = (path: string) => Promise<void>;

export interface UploadFailureReport {
  code: "UPLOAD_CLEANUP_FAILED";
  phase: "terminal_cleanup";
}

export type UploadFailureReporter = (
  report: Readonly<UploadFailureReport>,
) => void | Promise<void>;

/**
 * Thrown when a persistence write conflicts with existing data (e.g. an
 * idempotency key reused with different content).
 */
export class PersistenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceConflictError";
  }
}

/**
 * Thrown when a requested entity is not found in the database.
 */
export class PersistenceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceNotFoundError";
  }
}

/**
 * Thrown when a document version state transition is not allowed (e.g.
 * trying to activate a version that is not READY).
 */
export class InvalidStateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStateTransitionError";
  }
}
