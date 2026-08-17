import type Database from "better-sqlite3";
import type { DocumentVersionState } from "../documents/document.types.js";

// ── database.ts ─────────────────────────────────────────────────────

export type DatabaseConnection = Database.Database;

// ── migrate.ts ──────────────────────────────────────────────────────

export interface Migration {
  id: string;
  sql: string;
}

export interface AppliedMigrationRow {
  checksum: string;
}

// ── repositories/cleanup.repository.ts ──────────────────────────────

export type CleanupJobStatus = "queued" | "processing";

export interface CleanupJob {
  id: string;
  versionId: string;
  status: CleanupJobStatus;
  attempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseUntil: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CleanupJobRow {
  id: string;
  version_id: string;
  status: CleanupJobStatus;
  attempts: number;
  available_at: string;
  lease_owner: string | null;
  lease_until: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

// ── repositories/document.repository.ts ─────────────────────────────

export interface DocumentVersionRow {
  id: string;
  document_id: string;
  title: string;
  description: string | null;
  academic_year: string;
  content_hash: string;
  state: DocumentVersionState;
  created_at: string;
  updated_at: string;
  ready_at: string | null;
  activated_at: string | null;
  archived_at: string | null;
  failed_at: string | null;
}

// ── repositories/diagnostics.repository.ts ──────────────────────────

export interface DiagnosticInput {
  id: string;
  requestId: string;
  question: string;
  answer: string | null;
  retrievedChunkIds: string[];
  expiresAt: string | Date;
}

export interface DiagnosticEntry {
  id: string;
  requestId: string;
  question: string;
  answer: string | null;
  retrievedChunkIds: string[];
  expiresAt: string;
  createdAt: string;
}

export interface DiagnosticRow {
  id: string;
  request_id: string;
  question: string;
  answer: string | null;
  retrieved_chunk_ids: string;
  expires_at: string;
  created_at: string;
}

// ── repositories/indexing-job.repository.ts ─────────────────────────

export const indexingJobStatuses = [
  "queued",
  "processing",
  "completed",
  "failed",
] as const;

export type IndexingJobStatus = (typeof indexingJobStatuses)[number];

export interface EnqueueIndexingJobInput {
  id: string;
  documentId: string;
  versionId: string;
  idempotencyKey: string;
  requestHash: string;
  contentHash: string;
  tempFilePath: string;
}

export interface IndexingJob extends EnqueueIndexingJobInput {
  status: IndexingJobStatus;
  stage: string;
  progress: number;
  attempts: number;
  leaseOwner: string | null;
  leaseUntil: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface IndexingJobRow {
  id: string;
  document_id: string;
  version_id: string;
  idempotency_key: string;
  request_hash: string;
  content_hash: string;
  temp_file_path: string;
  status: IndexingJobStatus;
  stage: string;
  progress: number;
  attempts: number;
  lease_owner: string | null;
  lease_until: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
