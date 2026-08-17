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
