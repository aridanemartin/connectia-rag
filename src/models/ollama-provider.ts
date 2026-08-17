import { ChatOllama, OllamaEmbeddings } from "@langchain/ollama";
import type { AppConfig } from "../config/config.types.js";
import type {
  ChatBoundary,
  EmbeddingsBoundary,
  GroundedPrompt,
  ModelHealth,
  ModelProvider,
  OllamaProviderDependencies,
} from "./models.types.js";

export type { ChatBoundary, EmbeddingsBoundary, OllamaProviderDependencies };

/**
 * Extracts a JSON value from a chat model's raw text response.
 *
 * Chat models routinely wrap JSON in a Markdown code fence (```json ... ```)
 * even when instructed to return only the JSON body. Strips a single
 * surrounding fence if present, then parses. Returns the original string
 * unchanged when it isn't valid JSON, so the caller's schema validation
 * fails with its own typed error instead of a raw SyntaxError.
 */
function parseModelJson(content: string): unknown {
  const fenced = content.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1] : content.trim();
  try {
    return JSON.parse(candidate);
  } catch {
    return content;
  }
}

function unavailableHealth(): ModelHealth {
  return {
    ollama: false,
    chat: false,
    embeddings: false,
    dimensions: 0,
  };
}

function withTrackedBody(response: Response, finish: () => void): Response {
  if (!response.body) {
    finish();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
  const tracked = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(tracked, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  });
  return tracked;
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
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        clearTimeout(timeout);
      }
    };

    try {
      const response = await baseFetch(input, { ...init, signal });
      return withTrackedBody(response, finish);
    } catch (error) {
      finish();
      throw error;
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

/**
 * ModelProvider backed by Ollama: embeds documents and queries, runs chat
 * decisions with a timeout-bounded fetch, and probes model health. Key
 * methods: embedDocuments, embedQuery, decide, health.
 */
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
      const { content } = result;
      return typeof content === "string" ? parseModelJson(content) : content;
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
