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

export class PersistenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceConflictError";
  }
}

export class PersistenceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceNotFoundError";
  }
}

export class InvalidStateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStateTransitionError";
  }
}
