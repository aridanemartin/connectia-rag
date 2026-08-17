// ── model-provider.ts ───────────────────────────────────────────────

export interface GroundedPrompt {
  system: string;
  question: string;
  context: ReadonlyArray<{
    chunkId: string;
    text: string;
    documentTitle: string;
    page: number;
    section: string | null;
  }>;
}

export interface ModelHealth {
  ollama: boolean;
  chat: boolean;
  embeddings: boolean;
  dimensions: number;
}

export interface ModelProvider {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  decide(input: GroundedPrompt): Promise<unknown>;
  health(): Promise<ModelHealth>;
}

// ── ollama-provider.ts ──────────────────────────────────────────────

export interface ChatBoundary {
  invoke(input: unknown): Promise<unknown>;
}

export interface EmbeddingsBoundary {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export interface OllamaProviderDependencies {
  fetch: typeof fetch;
  chat: ChatBoundary;
  embeddings: EmbeddingsBoundary;
}
