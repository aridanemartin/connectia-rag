import type { DocumentVersion } from "./document.types.js";

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

/**
 * Coordinates document-version lifecycle operations (activate, archive) and
 * exposes which versions are allowed for answers and previews, delegating
 * the underlying persistence to a LifecycleServiceReader.
 */
export class LifecycleService implements LifecycleReader {
  constructor(private readonly documents: LifecycleServiceReader) {}

  activate(documentId: string, versionId: string): DocumentVersion {
    return this.documents.activate(documentId, versionId);
  }

  archive(documentId: string, versionId: string): DocumentVersion {
    return this.documents.archive(documentId, versionId);
  }

  allowedActiveVersions(): string[] {
    return this.documents.activeVersionIds();
  }

  allowedActiveVersionsByDocumentIds(documentIds: readonly string[]): string[] {
    return this.documents.activeVersionIdsByDocumentIds(documentIds);
  }

  allowedPreviewVersions(documentId: string, versionId: string): string[] {
    return this.documents.previewVersionIds(documentId, versionId);
  }
}
