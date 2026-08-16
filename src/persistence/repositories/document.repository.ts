import { randomUUID } from "node:crypto";
import {
  type DocumentVersion,
  type DocumentVersionState,
  type IndexingDocumentInput,
  InvalidStateTransitionError,
  PersistenceConflictError,
  PersistenceNotFoundError,
} from "../../documents/document.types.js";
import type { Clock } from "../../shared/clock.js";
import type { DatabaseConnection } from "../database.js";

interface DocumentVersionRow {
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

const versionSelect = `
  SELECT
    document_versions.id,
    document_versions.document_id,
    documents.title,
    documents.description,
    document_versions.academic_year,
    document_versions.content_hash,
    document_versions.state,
    document_versions.created_at,
    document_versions.updated_at,
    document_versions.ready_at,
    document_versions.activated_at,
    document_versions.archived_at,
    document_versions.failed_at
  FROM document_versions
  JOIN documents ON documents.id = document_versions.document_id
`;

function toDocumentVersion(row: DocumentVersionRow): DocumentVersion {
  return {
    id: row.id,
    documentId: row.document_id,
    title: row.title,
    description: row.description,
    academicYear: row.academic_year,
    contentHash: row.content_hash,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readyAt: row.ready_at,
    activatedAt: row.activated_at,
    archivedAt: row.archived_at,
    failedAt: row.failed_at,
  };
}

export class DocumentRepository {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly clock: Clock,
  ) {}

  upsertIndexing(input: IndexingDocumentInput): DocumentVersion {
    const write = this.database.transaction(() => {
      const now = this.clock.now().toISOString();
      this.database
        .prepare(
          `
            INSERT INTO documents (id, title, description, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              description = excluded.description,
              updated_at = excluded.updated_at
          `,
        )
        .run(
          input.documentId,
          input.title,
          input.description ?? null,
          now,
          now,
        );

      const existing = this.findVersion(input.versionId);
      if (existing) {
        if (existing.documentId !== input.documentId) {
          throw new PersistenceConflictError(
            `Version ${input.versionId} belongs to another document`,
          );
        }
        if (existing.contentHash !== input.contentHash) {
          throw new PersistenceConflictError(
            `Version ${input.versionId} has different content`,
          );
        }
        return existing;
      }

      this.database
        .prepare(
          `
            INSERT INTO document_versions (
              id, document_id, academic_year, content_hash, state,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'INDEXING', ?, ?)
          `,
        )
        .run(
          input.versionId,
          input.documentId,
          input.academicYear,
          input.contentHash,
          now,
          now,
        );
      return this.requireVersion(input.versionId);
    });

    return write();
  }

  findVersion(versionId: string): DocumentVersion | undefined {
    const row = this.database
      .prepare<[string], DocumentVersionRow>(
        `${versionSelect} WHERE document_versions.id = ?`,
      )
      .get(versionId);
    return row ? toDocumentVersion(row) : undefined;
  }

  markReady(versionId: string): DocumentVersion {
    const current = this.requireVersion(versionId);
    if (current.state === "READY") {
      return current;
    }
    if (current.state !== "INDEXING") {
      throw new InvalidStateTransitionError(
        `Version ${versionId} must be INDEXING before it can become READY`,
      );
    }
    const now = this.clock.now().toISOString();
    this.database
      .prepare(
        `
          UPDATE document_versions
          SET state = 'READY', ready_at = ?, updated_at = ?
          WHERE id = ? AND state = 'INDEXING'
        `,
      )
      .run(now, now, versionId);
    return this.requireVersion(versionId);
  }

  markFailed(versionId: string): DocumentVersion {
    const current = this.requireVersion(versionId);
    if (current.state === "FAILED") {
      return current;
    }
    if (current.state !== "INDEXING") {
      throw new InvalidStateTransitionError(
        `Version ${versionId} must be INDEXING before it can become FAILED`,
      );
    }
    const now = this.clock.now().toISOString();
    this.database
      .prepare(
        `
          UPDATE document_versions
          SET state = 'FAILED', failed_at = ?, updated_at = ?
          WHERE id = ? AND state = 'INDEXING'
        `,
      )
      .run(now, now, versionId);
    return this.requireVersion(versionId);
  }

  activate(documentId: string, versionId: string): DocumentVersion {
    const activateVersion = this.database.transaction(() => {
      const target = this.requireOwnedVersion(documentId, versionId);
      if (target.state === "ACTIVE") {
        return target;
      }
      if (target.state !== "READY") {
        throw new InvalidStateTransitionError(
          `Version ${versionId} must be READY before activation`,
        );
      }

      const now = this.clock.now().toISOString();
      const previousVersions = this.database
        .prepare<[string, string], { id: string }>(
          `
            SELECT id FROM document_versions
            WHERE document_id = ? AND state = 'ACTIVE' AND id <> ?
          `,
        )
        .all(documentId, versionId);

      for (const previous of previousVersions) {
        this.database
          .prepare(
            `
              UPDATE document_versions
              SET state = 'ARCHIVED', archived_at = ?, updated_at = ?
              WHERE id = ? AND state = 'ACTIVE'
            `,
          )
          .run(now, now, previous.id);
        this.enqueueCleanup(previous.id, now);
      }

      this.database
        .prepare(
          `
            UPDATE document_versions
            SET state = 'ACTIVE', activated_at = ?, archived_at = NULL,
                updated_at = ?
            WHERE id = ? AND state = 'READY'
          `,
        )
        .run(now, now, versionId);
      return this.requireVersion(versionId);
    });

    return activateVersion();
  }

  archive(documentId: string, versionId: string): DocumentVersion {
    const archiveVersion = this.database.transaction(() => {
      const current = this.requireOwnedVersion(documentId, versionId);
      const now = this.clock.now().toISOString();
      if (current.state !== "ARCHIVED") {
        this.database
          .prepare(
            `
              UPDATE document_versions
              SET state = 'ARCHIVED', archived_at = ?, updated_at = ?
              WHERE id = ?
            `,
          )
          .run(now, now, versionId);
      }
      this.enqueueCleanup(versionId, now);
      return this.requireVersion(versionId);
    });

    return archiveVersion();
  }

  activeVersionIds(): string[] {
    return this.database
      .prepare<[], { id: string }>(
        "SELECT id FROM document_versions WHERE state = 'ACTIVE' ORDER BY id",
      )
      .all()
      .map((row) => row.id);
  }

  previewVersionIds(documentId: string, versionId: string): string[] {
    const candidate = this.requireOwnedVersion(documentId, versionId);
    if (candidate.state !== "READY" && candidate.state !== "ACTIVE") {
      throw new InvalidStateTransitionError(
        `Version ${versionId} must be READY or ACTIVE for preview`,
      );
    }
    const activeOtherDocuments = this.database
      .prepare<[string], { id: string }>(
        `
          SELECT id FROM document_versions
          WHERE state = 'ACTIVE' AND document_id <> ?
        `,
      )
      .all(documentId)
      .map((row) => row.id);
    return [...activeOtherDocuments, versionId].sort();
  }

  private requireVersion(versionId: string): DocumentVersion {
    const version = this.findVersion(versionId);
    if (!version) {
      throw new PersistenceNotFoundError(`Version ${versionId} was not found`);
    }
    return version;
  }

  private requireOwnedVersion(
    documentId: string,
    versionId: string,
  ): DocumentVersion {
    const version = this.requireVersion(versionId);
    if (version.documentId !== documentId) {
      throw new PersistenceNotFoundError(
        `Version ${versionId} was not found for document ${documentId}`,
      );
    }
    return version;
  }

  private enqueueCleanup(versionId: string, now: string): void {
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
  }
}
