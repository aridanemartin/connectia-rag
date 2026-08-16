import { randomUUID } from "node:crypto";
import { PersistenceNotFoundError } from "../../documents/document.types.js";
import type { Clock } from "../../shared/clock.js";
import type { DatabaseConnection } from "../database.js";

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

interface CleanupJobRow {
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

function toCleanupJob(row: CleanupJobRow): CleanupJob {
  return {
    id: row.id,
    versionId: row.version_id,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

export class CleanupRepository {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly clock: Clock,
  ) {}

  enqueue(versionId: string): CleanupJob {
    const now = this.clock.now().toISOString();
    this.database
      .prepare(
        `
          INSERT INTO vector_cleanup_jobs (
            id, version_id, status, attempts, available_at, created_at, updated_at
          ) VALUES (?, ?, 'queued', 0, ?, ?, ?)
          ON CONFLICT(version_id) DO NOTHING
        `,
      )
      .run(randomUUID(), versionId, now, now, now);
    return this.findByVersion(versionId) as CleanupJob;
  }

  find(jobId: string): CleanupJob | undefined {
    const row = this.database
      .prepare<[string], CleanupJobRow>(
        "SELECT * FROM vector_cleanup_jobs WHERE id = ?",
      )
      .get(jobId);
    return row ? toCleanupJob(row) : undefined;
  }

  findByVersion(versionId: string): CleanupJob | undefined {
    const row = this.database
      .prepare<[string], CleanupJobRow>(
        "SELECT * FROM vector_cleanup_jobs WHERE version_id = ?",
      )
      .get(versionId);
    return row ? toCleanupJob(row) : undefined;
  }

  list(): CleanupJob[] {
    return this.database
      .prepare<[], CleanupJobRow>(
        "SELECT * FROM vector_cleanup_jobs ORDER BY created_at, id",
      )
      .all()
      .map(toCleanupJob);
  }

  leaseNext(owner: string, leaseMs: number): CleanupJob | undefined {
    if (!owner || !Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new RangeError(
        "A lease owner and positive lease duration are required",
      );
    }
    const lease = this.database.transaction(() => {
      const nowDate = this.clock.now();
      const now = nowDate.toISOString();
      const candidate = this.database
        .prepare<[string], { id: string }>(
          `
            SELECT id FROM vector_cleanup_jobs
            WHERE status = 'queued' AND available_at <= ?
            ORDER BY available_at, created_at, id
            LIMIT 1
          `,
        )
        .get(now);
      if (!candidate) {
        return undefined;
      }
      const leaseUntil = new Date(nowDate.getTime() + leaseMs).toISOString();
      const result = this.database
        .prepare(
          `
            UPDATE vector_cleanup_jobs
            SET status = 'processing', attempts = attempts + 1,
                lease_owner = ?, lease_until = ?, updated_at = ?
            WHERE id = ? AND status = 'queued'
          `,
        )
        .run(owner, leaseUntil, now, candidate.id);
      return result.changes === 1 ? this.require(candidate.id) : undefined;
    });
    return lease();
  }

  retry(
    jobId: string,
    owner: string,
    code: string,
    message: string,
    delayMs: number,
  ): CleanupJob {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError("Retry delay must be non-negative");
    }
    const nowDate = this.clock.now();
    const now = nowDate.toISOString();
    const availableAt = new Date(nowDate.getTime() + delayMs).toISOString();
    const result = this.database
      .prepare(
        `
          UPDATE vector_cleanup_jobs
          SET status = 'queued', available_at = ?, lease_owner = NULL,
              lease_until = NULL, error_code = ?, error_message = ?, updated_at = ?
          WHERE id = ? AND status = 'processing' AND lease_owner = ?
            AND lease_until IS NOT NULL AND lease_until > ?
        `,
      )
      .run(
        availableAt,
        safeErrorCode(code),
        safeErrorMessage(message),
        now,
        jobId,
        owner,
        now,
      );
    if (result.changes !== 1) {
      throw new LeaseLostError(jobId, owner);
    }
    return this.require(jobId);
  }

  complete(jobId: string, owner: string): boolean {
    const result = this.database
      .prepare(
        `
          DELETE FROM vector_cleanup_jobs
          WHERE id = ? AND status = 'processing' AND lease_owner = ?
            AND lease_until IS NOT NULL AND lease_until > ?
        `,
      )
      .run(jobId, owner, this.clock.now().toISOString());
    if (result.changes !== 1) {
      throw new LeaseLostError(jobId, owner);
    }
    return true;
  }

  recoverExpired(): number {
    const now = this.clock.now().toISOString();
    return this.database
      .prepare(
        `
          UPDATE vector_cleanup_jobs
          SET status = 'queued', available_at = ?, lease_owner = NULL,
              lease_until = NULL, updated_at = ?
          WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?
        `,
      )
      .run(now, now, now).changes;
  }

  private require(jobId: string): CleanupJob {
    const job = this.find(jobId);
    if (!job) {
      throw new PersistenceNotFoundError(`Cleanup job ${jobId} was not found`);
    }
    return job;
  }
}

class LeaseLostError extends Error {
  constructor(jobId: string, owner: string) {
    super(`Cleanup job ${jobId} does not have an active lease for ${owner}`);
    this.name = "LeaseLostError";
  }
}
