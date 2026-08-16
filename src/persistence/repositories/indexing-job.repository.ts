import {
  PersistenceConflictError,
  PersistenceNotFoundError,
} from "../../documents/document.types.js";
import type { Clock } from "../../shared/clock.js";
import type { DatabaseConnection } from "../database.js";

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

interface IndexingJobRow {
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

function toIndexingJob(row: IndexingJobRow): IndexingJob {
  return {
    id: row.id,
    documentId: row.document_id,
    versionId: row.version_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    contentHash: row.content_hash,
    tempFilePath: row.temp_file_path,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    attempts: row.attempts,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function safeErrorCode(code: string): string {
  return code.replace(/[^A-Z0-9_]/g, "_").slice(0, 100) || "UNKNOWN_ERROR";
}

function safeErrorMessage(message: string): string {
  return Array.from(message, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  })
    .join("")
    .trim()
    .slice(0, 500);
}

export class IndexingJobRepository {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly clock: Clock,
    private readonly maxAttempts = 3,
  ) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new RangeError("maxAttempts must be a positive integer");
    }
  }

  enqueue(input: EnqueueIndexingJobInput): IndexingJob {
    const enqueueJob = this.database.transaction(() => {
      const existing = this.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        if (existing.requestHash !== input.requestHash) {
          throw new PersistenceConflictError(
            `The idempotency key ${input.idempotencyKey} has a different request hash`,
          );
        }
        return existing;
      }
      const version = this.database
        .prepare<[string], { document_id: string }>(
          "SELECT document_id FROM document_versions WHERE id = ?",
        )
        .get(input.versionId);
      if (!version) {
        throw new PersistenceNotFoundError(
          `Version ${input.versionId} was not found`,
        );
      }
      if (version.document_id !== input.documentId) {
        throw new PersistenceConflictError(
          `Version ${input.versionId} belongs to another document`,
        );
      }
      const now = this.clock.now().toISOString();
      this.database
        .prepare(
          `
            INSERT INTO indexing_jobs (
              id, document_id, version_id, idempotency_key, request_hash,
              content_hash, temp_file_path, status, stage, progress, attempts,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', 0, 0, ?, ?)
          `,
        )
        .run(
          input.id,
          input.documentId,
          input.versionId,
          input.idempotencyKey,
          input.requestHash,
          input.contentHash,
          input.tempFilePath,
          now,
          now,
        );
      return this.require(input.id);
    });

    return enqueueJob();
  }

  find(jobId: string): IndexingJob | undefined {
    const row = this.database
      .prepare<[string], IndexingJobRow>(
        "SELECT * FROM indexing_jobs WHERE id = ?",
      )
      .get(jobId);
    return row ? toIndexingJob(row) : undefined;
  }

  leaseNext(owner: string, leaseMs: number): IndexingJob | undefined {
    if (!owner || !Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new RangeError(
        "A lease owner and positive lease duration are required",
      );
    }
    const lease = this.database.transaction(() => {
      const candidate = this.database
        .prepare<[number], { id: string }>(
          `
            SELECT id FROM indexing_jobs
            WHERE status = 'queued' AND attempts < ?
            ORDER BY created_at, id
            LIMIT 1
          `,
        )
        .get(this.maxAttempts);
      if (!candidate) {
        return undefined;
      }
      const nowDate = this.clock.now();
      const now = nowDate.toISOString();
      const leaseUntil = new Date(nowDate.getTime() + leaseMs).toISOString();
      const result = this.database
        .prepare(
          `
            UPDATE indexing_jobs
            SET status = 'processing', attempts = attempts + 1,
                lease_owner = ?, lease_until = ?, updated_at = ?
            WHERE id = ? AND status = 'queued' AND attempts < ?
          `,
        )
        .run(owner, leaseUntil, now, candidate.id, this.maxAttempts);
      return result.changes === 1 ? this.require(candidate.id) : undefined;
    });
    return lease();
  }

  progress(
    jobId: string,
    owner: string,
    stage: string,
    progress: number,
  ): IndexingJob {
    if (
      !stage ||
      !Number.isInteger(progress) ||
      progress < 0 ||
      progress > 99
    ) {
      throw new RangeError("Progress must be an integer between 0 and 99");
    }
    const now = this.clock.now().toISOString();
    const result = this.database
      .prepare(
        `
          UPDATE indexing_jobs SET stage = ?, progress = ?, updated_at = ?
          WHERE id = ? AND status = 'processing' AND lease_owner = ?
            AND lease_until IS NOT NULL AND lease_until > ?
        `,
      )
      .run(stage, progress, now, jobId, owner, now);
    if (result.changes !== 1) {
      throw new LeaseLostError("Indexing", jobId, owner);
    }
    return this.require(jobId);
  }

  complete(jobId: string, owner: string): IndexingJob {
    const now = this.clock.now().toISOString();
    const result = this.database
      .prepare(
        `
          UPDATE indexing_jobs
          SET status = 'completed', stage = 'completed', progress = 100,
              lease_owner = NULL, lease_until = NULL, error_code = NULL,
              error_message = NULL, updated_at = ?, completed_at = ?
          WHERE id = ? AND status = 'processing' AND lease_owner = ?
            AND lease_until IS NOT NULL AND lease_until > ?
        `,
      )
      .run(now, now, jobId, owner, now);
    if (result.changes !== 1) {
      throw new LeaseLostError("Indexing", jobId, owner);
    }
    return this.require(jobId);
  }

  fail(jobId: string, code: string, message: string): IndexingJob {
    const current = this.require(jobId);
    if (current.status === "failed") {
      return current;
    }
    if (current.status === "completed") {
      throw new InvalidJobStateError(jobId, "non-completed");
    }
    const now = this.clock.now().toISOString();
    this.database
      .prepare(
        `
          UPDATE indexing_jobs
          SET status = 'failed', lease_owner = NULL, lease_until = NULL,
              error_code = ?, error_message = ?, updated_at = ?, completed_at = ?
          WHERE id = ?
        `,
      )
      .run(safeErrorCode(code), safeErrorMessage(message), now, now, jobId);
    return this.require(jobId);
  }

  recoverExpired(): number {
    const recover = this.database.transaction(() => {
      const now = this.clock.now().toISOString();
      const expired = this.database
        .prepare<[string], { id: string; attempts: number }>(
          `
            SELECT id, attempts FROM indexing_jobs
            WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?
          `,
        )
        .all(now);
      for (const job of expired) {
        if (job.attempts >= this.maxAttempts) {
          this.database
            .prepare(
              `
                UPDATE indexing_jobs
                SET status = 'failed', lease_owner = NULL, lease_until = NULL,
                    error_code = 'ATTEMPT_LIMIT_EXCEEDED',
                    error_message = 'Se agotaron los intentos de procesamiento.',
                    updated_at = ?, completed_at = ?
                WHERE id = ? AND status = 'processing'
              `,
            )
            .run(now, now, job.id);
        } else {
          this.database
            .prepare(
              `
                UPDATE indexing_jobs
                SET status = 'queued', stage = 'queued', progress = 0,
                    lease_owner = NULL, lease_until = NULL, updated_at = ?
                WHERE id = ? AND status = 'processing'
              `,
            )
            .run(now, job.id);
        }
      }
      return expired.length;
    });
    return recover();
  }

  private findByIdempotencyKey(
    idempotencyKey: string,
  ): IndexingJob | undefined {
    const row = this.database
      .prepare<[string], IndexingJobRow>(
        "SELECT * FROM indexing_jobs WHERE idempotency_key = ?",
      )
      .get(idempotencyKey);
    return row ? toIndexingJob(row) : undefined;
  }

  private require(jobId: string): IndexingJob {
    const job = this.find(jobId);
    if (!job) {
      throw new PersistenceNotFoundError(`Indexing job ${jobId} was not found`);
    }
    return job;
  }
}

class InvalidJobStateError extends Error {
  constructor(jobId: string, expected: string) {
    super(`Indexing job ${jobId} must be ${expected}`);
    this.name = "InvalidJobStateError";
  }
}

class LeaseLostError extends Error {
  constructor(kind: string, jobId: string, owner: string) {
    super(`${kind} job ${jobId} does not have an active lease for ${owner}`);
    this.name = "LeaseLostError";
  }
}
