import type { QdrantClient } from "@qdrant/js-client-rest";
import type { z } from "zod";
import type { ModelProvider } from "../models/models.types.js";
import type { DiagnosticsRecorder } from "../shared/shared.types.js";
import type { answerDecisionSchema } from "./answer.schema.js";

// ── vector-store.ts ──────────────────────────────────────────────────

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

// ── citation.service.ts ─────────────────────────────────────────────

export interface Citation {
  documentId: string;
  versionId: string;
  documentTitle: string;
  page: number;
  section: string | null;
  academicYear: string;
  excerpt: string;
}

// ── generation-gate.ts ──────────────────────────────────────────────

export interface GenerationGateConfig {
  concurrency: number;
  maxQueued: number;
  timeoutMs: number;
}

export interface GenerationGateStats {
  active: number;
  queued: number;
  capacity: number;
}

// ── qdrant-vector-store.ts ──────────────────────────────────────────

export type QdrantClientLike = Pick<
  QdrantClient,
  | "getCollections"
  | "getCollection"
  | "createCollection"
  | "upsert"
  | "query"
  | "delete"
>;

export interface VectorConfiguration {
  size: number;
  distance: string;
}

// ── question.service.ts ─────────────────────────────────────────────

export interface QuestionResponse {
  status: "found" | "not_found" | "ambiguous";
  answer: string | null;
  citations: Citation[];
}

export interface QuestionServiceDependencies {
  model: Pick<ModelProvider, "embedQuery" | "decide">;
  vectorStore: Pick<VectorStore, "search">;
  gate: {
    run<T>(operation: () => Promise<T>): Promise<T>;
  };
  topK: number;
  scoreThreshold: number;
  diagnostics?: DiagnosticsRecorder;
}

// ── answer.schema.ts ────────────────────────────────────────────────

export type AnswerDecision = z.infer<typeof answerDecisionSchema>;
