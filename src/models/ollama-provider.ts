import { ChatOllama, OllamaEmbeddings } from "@langchain/ollama";
import type { AppConfig } from "../config/env.js";
import type {
  GroundedPrompt,
  ModelHealth,
  ModelProvider,
} from "./model-provider.js";

interface ChatBoundary {
  invoke(input: unknown): Promise<unknown>;
}

interface EmbeddingsBoundary {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export interface OllamaProviderDependencies {
  fetch: typeof fetch;
  chat: ChatBoundary;
  embeddings: EmbeddingsBoundary;
}

function unavailableHealth(): ModelHealth {
  return {
    ollama: false,
    chat: false,
    embeddings: false,
    dimensions: 0,
  };
}

function withTimeout(baseFetch: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const timeoutController = new AbortController();
    const inputSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = inputSignal
      ? AbortSignal.any([inputSignal, timeoutController.signal])
      : timeoutController.signal;
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);

    try {
      return await baseFetch(input, { ...init, signal });
    } finally {
      clearTimeout(timeout);
    }
  };
}

function readModelTags(value: unknown): Set<string> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("models" in value) ||
    !Array.isArray(value.models)
  ) {
    return undefined;
  }

  const tags = new Set<string>();
  for (const model of value.models) {
    if (typeof model !== "object" || model === null) {
      return undefined;
    }
    if ("name" in model && typeof model.name === "string") {
      tags.add(model.name);
    }
    if ("model" in model && typeof model.model === "string") {
      tags.add(model.model);
    }
  }
  return tags;
}

export class OllamaProvider implements ModelProvider {
  private readonly deps: OllamaProviderDependencies;

  constructor(
    private readonly config: AppConfig,
    deps?: OllamaProviderDependencies,
  ) {
    const boundedFetch = withTimeout(
      deps?.fetch ?? fetch,
      config.DEPENDENCY_TIMEOUT_MS,
    );
    this.deps = deps
      ? { ...deps, fetch: boundedFetch }
      : ({
          fetch: boundedFetch,
          chat: new ChatOllama({
            baseUrl: config.OLLAMA_BASE_URL,
            model: config.OLLAMA_CHAT_MODEL,
            fetch: boundedFetch,
          }) as ChatBoundary,
          embeddings: new OllamaEmbeddings({
            baseUrl: config.OLLAMA_BASE_URL,
            model: config.OLLAMA_EMBEDDING_MODEL,
            dimensions: config.EMBEDDING_DIMENSIONS,
            fetch: boundedFetch,
          }),
        } satisfies OllamaProviderDependencies);
  }

  embedDocuments(texts: string[]): Promise<number[][]> {
    return this.deps.embeddings.embedDocuments(texts);
  }

  embedQuery(text: string): Promise<number[]> {
    return this.deps.embeddings.embedQuery(text);
  }

  async decide(input: GroundedPrompt): Promise<unknown> {
    const result = await this.deps.chat.invoke([
      ["system", input.system],
      [
        "human",
        JSON.stringify({ question: input.question, context: input.context }),
      ],
    ]);

    if (typeof result === "object" && result !== null && "content" in result) {
      return result.content;
    }
    return result;
  }

  async health(): Promise<ModelHealth> {
    try {
      const response = await this.deps.fetch(
        `${this.config.OLLAMA_BASE_URL.replace(/\/$/, "")}/api/tags`,
      );
      if (!response.ok) {
        return unavailableHealth();
      }

      const tags = readModelTags(await response.json());
      if (!tags) {
        return unavailableHealth();
      }

      const chat = tags.has(this.config.OLLAMA_CHAT_MODEL);
      const embeddingTag = tags.has(this.config.OLLAMA_EMBEDDING_MODEL);
      if (!embeddingTag) {
        return { ollama: true, chat, embeddings: false, dimensions: 0 };
      }

      try {
        const probe = await this.deps.embeddings.embedQuery("health");
        return {
          ollama: true,
          chat,
          embeddings: true,
          dimensions: probe.length,
        };
      } catch {
        return { ollama: true, chat, embeddings: false, dimensions: 0 };
      }
    } catch {
      return unavailableHealth();
    }
  }
}
