import type { ModelProvider } from "../models/models.types.js";
import type { VectorStore } from "../rag/rag.types.js";

export type DependencyStatus = "ready" | "not_ready";

export interface ReadinessResult {
  status: "ready" | "not_ready";
  dependencies: {
    sqlite: DependencyStatus;
    qdrant: DependencyStatus;
    collection: DependencyStatus;
    ollama: DependencyStatus;
    chatModel: DependencyStatus;
    embeddingModel: DependencyStatus;
    embeddingDimensions: DependencyStatus;
  };
}

export interface SqliteHealth {
  health(): Promise<boolean> | boolean;
}

export interface ReadinessCheck {
  sqlite: SqliteHealth;
  vectorStore: VectorStore;
  modelProvider: ModelProvider;
}

export interface Readiness {
  check(): Promise<ReadinessResult>;
}

export interface ReadinessTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
