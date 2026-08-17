import type {
  DocumentVersion,
  LifecycleReader,
  LifecycleServiceReader,
} from "./document.types.js";

export type {
  LifecycleReader,
  LifecycleServiceReader,
} from "./document.types.js";

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
