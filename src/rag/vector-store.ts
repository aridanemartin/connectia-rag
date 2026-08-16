export interface ChunkPayload {
  documentId: string;
  versionId: string;
  documentTitle: string;
  academicYear: string;
  page: number;
  section: string | null;
  chunkIndex: number;
  contentHash: string;
  text: string;
}

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: ChunkPayload;
}

export interface SearchHit {
  id: string;
  score: number;
  payload: ChunkPayload;
}

export interface VectorStoreHealth {
  qdrant: boolean;
  collection: boolean;
  dimensions: number;
}

export interface VectorStore {
  ensureCollection(dimensions: number): Promise<void>;
  upsert(points: VectorPoint[]): Promise<void>;
  search(
    vector: number[],
    allowedVersionIds: string[],
    limit: number,
    scoreThreshold: number,
  ): Promise<SearchHit[]>;
  deleteVersion(versionId: string): Promise<void>;
  health(): Promise<VectorStoreHealth>;
}
