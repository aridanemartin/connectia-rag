import { QdrantClient } from "@qdrant/js-client-rest";
import type { AppConfig } from "../config/env.js";
import type {
  ChunkPayload,
  SearchHit,
  VectorPoint,
  VectorStore,
  VectorStoreHealth,
} from "./vector-store.js";

export type QdrantClientLike = Pick<
  QdrantClient,
  | "getCollections"
  | "getCollection"
  | "createCollection"
  | "upsert"
  | "query"
  | "delete"
>;

export class VectorStoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "VectorStoreError";
  }
}

interface VectorConfiguration {
  size: number;
  distance: string;
}

function readUnnamedVectorConfiguration(
  value: unknown,
): VectorConfiguration | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("size" in value) ||
    typeof value.size !== "number" ||
    !("distance" in value) ||
    typeof value.distance !== "string"
  ) {
    return null;
  }
  return { size: value.size, distance: value.distance };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseChunkPayload(value: unknown): ChunkPayload {
  if (
    typeof value !== "object" ||
    value === null ||
    !("documentId" in value) ||
    !isNonEmptyString(value.documentId) ||
    !("versionId" in value) ||
    !isNonEmptyString(value.versionId) ||
    !("documentTitle" in value) ||
    !isNonEmptyString(value.documentTitle) ||
    !("academicYear" in value) ||
    !isNonEmptyString(value.academicYear) ||
    !("page" in value) ||
    !Number.isInteger(value.page) ||
    typeof value.page !== "number" ||
    value.page < 1 ||
    !("section" in value) ||
    !(value.section === null || typeof value.section === "string") ||
    !("chunkIndex" in value) ||
    !Number.isInteger(value.chunkIndex) ||
    typeof value.chunkIndex !== "number" ||
    value.chunkIndex < 0 ||
    !("contentHash" in value) ||
    !isNonEmptyString(value.contentHash) ||
    !("text" in value) ||
    !isNonEmptyString(value.text)
  ) {
    throw new VectorStoreError("VECTOR_PAYLOAD_INVALID");
  }

  return {
    documentId: value.documentId,
    versionId: value.versionId,
    documentTitle: value.documentTitle,
    academicYear: value.academicYear,
    page: value.page,
    section: value.section,
    chunkIndex: value.chunkIndex,
    contentHash: value.contentHash,
    text: value.text,
  };
}

export class QdrantVectorStore implements VectorStore {
  private readonly client: QdrantClientLike;

  constructor(
    private readonly config: AppConfig,
    client?: QdrantClientLike,
  ) {
    this.client =
      client ??
      new QdrantClient({
        url: config.QDRANT_URL,
        checkCompatibility: false,
      });
  }

  async ensureCollection(dimensions: number): Promise<void> {
    const collections = await this.client.getCollections();
    const exists = collections.collections.some(
      ({ name }) => name === this.config.QDRANT_COLLECTION,
    );
    if (!exists) {
      await this.client.createCollection(this.config.QDRANT_COLLECTION, {
        vectors: { size: dimensions, distance: "Cosine" },
      });
      return;
    }

    const collection = await this.client.getCollection(
      this.config.QDRANT_COLLECTION,
    );
    const vectors = readUnnamedVectorConfiguration(
      collection.config.params.vectors,
    );
    if (
      !vectors ||
      vectors.size !== dimensions ||
      vectors.distance !== "Cosine"
    ) {
      throw new VectorStoreError("VECTOR_DIMENSION_MISMATCH");
    }
  }

  async upsert(points: VectorPoint[]): Promise<void> {
    await this.client.upsert(this.config.QDRANT_COLLECTION, {
      wait: true,
      points: points.map((point) => ({
        id: point.id,
        vector: point.vector,
        payload: { ...point.payload },
      })),
    });
  }

  async search(
    vector: number[],
    allowedVersionIds: string[],
    limit: number,
    scoreThreshold: number,
  ): Promise<SearchHit[]> {
    if (allowedVersionIds.length === 0) {
      return [];
    }

    const result = await this.client.query(this.config.QDRANT_COLLECTION, {
      query: vector,
      filter: {
        must: [
          {
            key: "versionId",
            match: { any: allowedVersionIds },
          },
        ],
      },
      score_threshold: scoreThreshold,
      limit,
      with_payload: true,
    });

    return result.points.map((point) => {
      if (typeof point.id !== "string") {
        throw new VectorStoreError("VECTOR_PAYLOAD_INVALID");
      }
      return {
        id: point.id,
        score: point.score,
        payload: parseChunkPayload(point.payload),
      };
    });
  }

  async deleteVersion(versionId: string): Promise<void> {
    await this.client.delete(this.config.QDRANT_COLLECTION, {
      wait: true,
      filter: {
        must: [{ key: "versionId", match: { value: versionId } }],
      },
    });
  }

  async health(): Promise<VectorStoreHealth> {
    try {
      const collections = await this.client.getCollections();
      const exists = collections.collections.some(
        ({ name }) => name === this.config.QDRANT_COLLECTION,
      );
      if (!exists) {
        return { qdrant: true, collection: false, dimensions: 0 };
      }

      try {
        const collection = await this.client.getCollection(
          this.config.QDRANT_COLLECTION,
        );
        const vectors = readUnnamedVectorConfiguration(
          collection.config.params.vectors,
        );
        return {
          qdrant: true,
          collection:
            collection.status !== "red" &&
            vectors !== null &&
            vectors.distance === "Cosine" &&
            vectors.size === this.config.EMBEDDING_DIMENSIONS,
          dimensions: vectors?.size ?? 0,
        };
      } catch {
        return { qdrant: true, collection: false, dimensions: 0 };
      }
    } catch {
      return { qdrant: false, collection: false, dimensions: 0 };
    }
  }
}
