import type { DocumentVersion } from "./document.types.js";

export interface LifecycleServiceReader {
  activate(documentId: string, versionId: string): DocumentVersion;
  archive(documentId: string, versionId: string): DocumentVersion;
  activeVersionIds(): string[];
  previewVersionIds(documentId: string, versionId: string): string[];
}

export interface LifecycleReader {
  activate(documentId: string, versionId: string): DocumentVersion;
  archive(documentId: string, versionId: string): DocumentVersion;
  allowedActiveVersions(): string[];
  allowedPreviewVersions(documentId: string, versionId: string): string[];
}

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

  allowedPreviewVersions(documentId: string, versionId: string): string[] {
    return this.documents.previewVersionIds(documentId, versionId);
  }
}
