import type { AppConfig } from "../config/env.js";
import type { ModelProvider } from "../models/model-provider.js";
import { OllamaProvider } from "../models/ollama-provider.js";
import { closeDatabase, openDatabase } from "../persistence/database.js";
import { QdrantVectorStore } from "../rag/qdrant-vector-store.js";
import type { VectorStore } from "../rag/vector-store.js";

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

interface SqliteHealth {
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

const systemTimer: ReadinessTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const status = (ready: boolean): DependencyStatus =>
  ready ? "ready" : "not_ready";

export class ReadinessService implements Readiness {
  constructor(
    private readonly config: AppConfig,
    private readonly dependencies: ReadinessCheck,
    private readonly timer: ReadinessTimer = systemTimer,
  ) {}

  async check(): Promise<ReadinessResult> {
    const [sqliteResult, vectorResult, modelResult] = await Promise.allSettled([
      this.withDeadline(() => this.dependencies.sqlite.health()),
      this.withDeadline(() => this.dependencies.vectorStore.health()),
      this.withDeadline(() => this.dependencies.modelProvider.health()),
    ]);

    const sqliteReady =
      sqliteResult.status === "fulfilled" && sqliteResult.value === true;
    const vectorHealth =
      vectorResult.status === "fulfilled" ? vectorResult.value : undefined;
    const modelHealth =
      modelResult.status === "fulfilled" ? modelResult.value : undefined;
    const dimensionsReady =
      vectorHealth?.dimensions === this.config.EMBEDDING_DIMENSIONS &&
      modelHealth?.dimensions === this.config.EMBEDDING_DIMENSIONS;

    const dependencies = {
      sqlite: status(sqliteReady),
      qdrant: status(vectorHealth?.qdrant === true),
      collection: status(vectorHealth?.collection === true),
      ollama: status(modelHealth?.ollama === true),
      chatModel: status(modelHealth?.chat === true),
      embeddingModel: status(modelHealth?.embeddings === true),
      embeddingDimensions: status(dimensionsReady),
    };
    const ready = Object.values(dependencies).every(
      (dependency) => dependency === "ready",
    );

    return { status: ready ? "ready" : "not_ready", dependencies };
  }

  private withDeadline<T>(operation: () => PromiseLike<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const timeout = this.timer.setTimeout(() => {
        if (!finished) {
          finished = true;
          reject(new Error("READINESS_DEPENDENCY_TIMEOUT"));
        }
      }, this.config.DEPENDENCY_TIMEOUT_MS);

      Promise.resolve()
        .then(operation)
        .then(
          (value) => {
            if (!finished) {
              finished = true;
              this.timer.clearTimeout(timeout);
              resolve(value);
            }
          },
          (error: unknown) => {
            if (!finished) {
              finished = true;
              this.timer.clearTimeout(timeout);
              reject(error);
            }
          },
        );
    });
  }
}

class SqliteFileHealth implements SqliteHealth {
  constructor(private readonly path: string) {}

  health(): boolean {
    const database = openDatabase(this.path);
    try {
      const result = database.pragma("quick_check", { simple: true });
      return result === "ok";
    } finally {
      closeDatabase(database);
    }
  }
}

export function createDefaultReadiness(config: AppConfig): ReadinessService {
  return new ReadinessService(config, {
    sqlite: new SqliteFileHealth(config.DATABASE_PATH),
    vectorStore: new QdrantVectorStore(config),
    modelProvider: new OllamaProvider(config),
  });
}
