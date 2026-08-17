import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { OllamaProvider } from "../../src/models/ollama-provider.js";
import {
  type QdrantClientLike,
  QdrantVectorStore,
} from "../../src/rag/qdrant-vector-store.js";
import type { ChunkPayload } from "../../src/rag/vector-store.js";

const qdrantConstructor = vi.hoisted(() => vi.fn());

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: class {
    constructor(options: unknown) {
      qdrantConstructor(options);
    }
  },
}));

const config = loadConfig({
  AUTH_TOKEN: "test-auth-token-with-at-least-32-characters",
  QDRANT_COLLECTION: "connectia_chunks",
  EMBEDDING_DIMENSIONS: "2",
  OLLAMA_CHAT_MODEL: "gemma3:12b",
  OLLAMA_EMBEDDING_MODEL: "qwen3-embedding:0.6b",
});

const payload: ChunkPayload = {
  documentId: "document-a",
  versionId: "version-a",
  documentTitle: "Horario",
  academicYear: "2026-2027",
  page: 2,
  section: "Tutoría",
  chunkIndex: 3,
  contentHash: "sha256-content",
  text: "Las tutorías son los martes.",
};

function collectionInfo(size: number, distance = "Cosine") {
  return {
    status: "green",
    optimizer_status: "ok",
    segments_count: 1,
    config: {
      params: { vectors: { size, distance } },
      hnsw_config: {},
      optimizer_config: {},
    },
    payload_schema: {},
  };
}

function fakeQdrant(overrides: Record<string, unknown> = {}) {
  return {
    getCollections: vi.fn().mockResolvedValue({
      collections: [{ name: config.QDRANT_COLLECTION }],
    }),
    getCollection: vi.fn().mockResolvedValue(collectionInfo(2)),
    createCollection: vi.fn().mockResolvedValue(true),
    upsert: vi.fn().mockResolvedValue({ status: "completed" }),
    query: vi.fn().mockResolvedValue({
      points: [{ id: "point-a", version: 1, score: 0.91, payload }],
    }),
    delete: vi.fn().mockResolvedValue({ status: "completed" }),
    ...overrides,
  } as unknown as QdrantClientLike;
}

function ollamaTags(models: string[]): Response {
  return new Response(
    JSON.stringify({
      models: models.map((name) => ({
        name,
        model: name,
        modified_at: "2026-08-15T00:00:00.000Z",
        size: 1024,
        digest: `digest-${name}`,
        details: {
          parent_model: "",
          format: "gguf",
          family: "test",
          families: ["test"],
          parameter_size: "test",
          quantization_level: "test",
        },
      })),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("QdrantVectorStore", () => {
  it("configures the default client with the dependency deadline", () => {
    const timeoutConfig = loadConfig({
      AUTH_TOKEN: "test-auth-token-with-at-least-32-characters",
      QDRANT_URL: "http://qdrant.internal:6333",
      DEPENDENCY_TIMEOUT_MS: "25",
    });
    qdrantConstructor.mockClear();

    new QdrantVectorStore(timeoutConfig);

    expect(qdrantConstructor).toHaveBeenCalledWith({
      url: "http://qdrant.internal:6333",
      checkCompatibility: false,
      timeout: 25,
    });
  });

  it("creates an absent collection with unnamed cosine vectors", async () => {
    const client = fakeQdrant({
      getCollections: vi.fn().mockResolvedValue({ collections: [] }),
    });
    const store = new QdrantVectorStore(config, client);

    await store.ensureCollection(2);

    expect(client.createCollection).toHaveBeenCalledWith("connectia_chunks", {
      vectors: { size: 2, distance: "Cosine" },
    });
    expect(client.getCollection).not.toHaveBeenCalled();
  });

  it("keeps an existing compatible collection", async () => {
    const client = fakeQdrant();
    const store = new QdrantVectorStore(config, client);

    await store.ensureCollection(2);

    expect(client.createCollection).not.toHaveBeenCalled();
  });

  it("raises a typed error instead of recreating a mismatched collection", async () => {
    const client = fakeQdrant({
      getCollection: vi.fn().mockResolvedValue(collectionInfo(3)),
    });
    const store = new QdrantVectorStore(config, client);

    await expect(store.ensureCollection(2)).rejects.toMatchObject({
      code: "VECTOR_DIMENSION_MISMATCH",
    });
    expect(client.createCollection).not.toHaveBeenCalled();
  });

  it("upserts application-owned point IDs and payloads", async () => {
    const client = fakeQdrant();
    const store = new QdrantVectorStore(config, client);

    await store.upsert([{ id: "point-a", vector: [0.1, 0.2], payload }]);

    expect(client.upsert).toHaveBeenCalledWith("connectia_chunks", {
      wait: true,
      points: [{ id: "point-a", vector: [0.1, 0.2], payload }],
    });
  });

  it("filters every search to the allowed version IDs", async () => {
    const client = fakeQdrant();
    const store = new QdrantVectorStore(config, client);

    const hits = await store.search(
      [0.1, 0.2],
      ["version-a", "version-b"],
      6,
      0.55,
    );

    expect(client.query).toHaveBeenCalledWith("connectia_chunks", {
      query: [0.1, 0.2],
      filter: {
        must: [
          {
            key: "versionId",
            match: { any: ["version-a", "version-b"] },
          },
        ],
      },
      score_threshold: 0.55,
      limit: 6,
      with_payload: true,
    });
    expect(hits).toEqual([{ id: "point-a", score: 0.91, payload }]);
  });

  it("returns no hits without issuing an unfiltered query", async () => {
    const client = fakeQdrant();
    const store = new QdrantVectorStore(config, client);

    await expect(store.search([0.1, 0.2], [], 6, 0.55)).resolves.toEqual([]);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("rejects search results whose trusted source payload is missing", async () => {
    const client = fakeQdrant({
      query: vi.fn().mockResolvedValue({
        points: [{ id: "point-a", version: 1, score: 0.91 }],
      }),
    });
    const store = new QdrantVectorStore(config, client);

    await expect(
      store.search([0.1, 0.2], ["version-a"], 6, 0.55),
    ).rejects.toMatchObject({ code: "VECTOR_PAYLOAD_INVALID" });
  });

  it("rejects malformed search payload fields", async () => {
    const client = fakeQdrant({
      query: vi.fn().mockResolvedValue({
        points: [
          {
            id: "point-a",
            version: 1,
            score: 0.91,
            payload: { ...payload, page: "2" },
          },
        ],
      }),
    });
    const store = new QdrantVectorStore(config, client);

    await expect(
      store.search([0.1, 0.2], ["version-a"], 6, 0.55),
    ).rejects.toMatchObject({ code: "VECTOR_PAYLOAD_INVALID" });
  });

  it("deletes points only through a version payload filter", async () => {
    const client = fakeQdrant();
    const store = new QdrantVectorStore(config, client);

    await store.deleteVersion("version-a");

    expect(client.delete).toHaveBeenCalledWith("connectia_chunks", {
      wait: true,
      filter: {
        must: [{ key: "versionId", match: { value: "version-a" } }],
      },
    });
  });
});

describe("OllamaProvider", () => {
  it("aborts a stalled tag request at the dependency deadline", async () => {
    vi.useFakeTimers();
    const timeoutConfig = loadConfig({
      AUTH_TOKEN: "test-auth-token-with-at-least-32-characters",
      DEPENDENCY_TIMEOUT_MS: "25",
    });
    const stalledFetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("http://ollama:11434?token=secret"));
          });
        }),
    );
    const provider = new OllamaProvider(timeoutConfig, {
      fetch: stalledFetch,
      chat: { invoke: vi.fn() },
      embeddings: {
        embedDocuments: vi.fn(),
        embedQuery: vi.fn(),
      },
    });

    try {
      let health: Awaited<ReturnType<OllamaProvider["health"]>> | undefined;
      const check = provider.health().then((value) => {
        health = value;
      });

      await vi.advanceTimersByTimeAsync(25);

      expect(health).toEqual({
        ollama: false,
        chat: false,
        embeddings: false,
        dimensions: 0,
      });
      expect(JSON.stringify(health)).not.toContain("token=secret");
      await check;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the abort deadline active while the response body is consumed", async () => {
    vi.useFakeTimers();
    const timeoutConfig = loadConfig({
      AUTH_TOKEN: "test-auth-token-with-at-least-32-characters",
      DEPENDENCY_TIMEOUT_MS: "25",
    });
    let ollamaSignal: AbortSignal | undefined;
    const headersFirstFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        ollamaSignal = init?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            ollamaSignal?.addEventListener("abort", () => {
              queueMicrotask(() => {
                controller.error(
                  new Error("http://ollama:11434?token=secret body failure"),
                );
              });
            });
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    const provider = new OllamaProvider(timeoutConfig, {
      fetch: headersFirstFetch,
      chat: { invoke: vi.fn() },
      embeddings: {
        embedDocuments: vi.fn(),
        embedQuery: vi.fn(),
      },
    });

    try {
      let health: Awaited<ReturnType<OllamaProvider["health"]>> | undefined;
      const check = provider.health().then((value) => {
        health = value;
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(ollamaSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(25);

      expect(ollamaSignal?.aborted).toBe(true);
      expect(health).toEqual({
        ollama: false,
        chat: false,
        embeddings: false,
        dimensions: 0,
      });
      expect(JSON.stringify(health)).not.toContain("token=secret");
      await check;
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses exact Ollama tags and reports the observed embedding dimensions", async () => {
    const embeddings = {
      embedDocuments: vi.fn(),
      embedQuery: vi.fn().mockResolvedValue([0.1, 0.2]),
    };
    const provider = new OllamaProvider(config, {
      fetch: vi
        .fn()
        .mockResolvedValue(ollamaTags(["gemma3:12b", "qwen3-embedding:0.6b"])),
      chat: { invoke: vi.fn() },
      embeddings,
    });

    await expect(provider.health()).resolves.toEqual({
      ollama: true,
      chat: true,
      embeddings: true,
      dimensions: 2,
    });
    expect(embeddings.embedQuery).toHaveBeenCalledOnce();
  });

  it("does not accept a near-match for a required model tag", async () => {
    const provider = new OllamaProvider(config, {
      fetch: vi
        .fn()
        .mockResolvedValue(
          ollamaTags(["gemma3:12b", "qwen3-embedding:0.6b-latest"]),
        ),
      chat: { invoke: vi.fn() },
      embeddings: {
        embedDocuments: vi.fn(),
        embedQuery: vi.fn(),
      },
    });

    await expect(provider.health()).resolves.toEqual({
      ollama: true,
      chat: true,
      embeddings: false,
      dimensions: 0,
    });
  });

  it("reports Ollama unavailable without exposing dependency errors", async () => {
    const provider = new OllamaProvider(config, {
      fetch: vi.fn().mockRejectedValue(new Error("secret URL and token")),
      chat: { invoke: vi.fn() },
      embeddings: {
        embedDocuments: vi.fn(),
        embedQuery: vi.fn(),
      },
    });

    const health = await provider.health();

    expect(health).toEqual({
      ollama: false,
      chat: false,
      embeddings: false,
      dimensions: 0,
    });
    expect(JSON.stringify(health)).not.toContain("secret");
  });

  it("parses a clean JSON decision returned as chat message text", async () => {
    const provider = new OllamaProvider(config, {
      fetch: vi.fn(),
      chat: {
        invoke: vi.fn().mockResolvedValue({
          content:
            '{"status":"found","answer":"Del 1 al 15 de septiembre.","citedChunkIds":["chunk-1"]}',
        }),
      },
      embeddings: { embedDocuments: vi.fn(), embedQuery: vi.fn() },
    });

    const decision = await provider.decide({
      system: "system prompt",
      question: "¿Cuál es el plazo?",
      context: [],
    });

    expect(decision).toEqual({
      status: "found",
      answer: "Del 1 al 15 de septiembre.",
      citedChunkIds: ["chunk-1"],
    });
  });

  it("parses a JSON decision wrapped in a Markdown code fence", async () => {
    const provider = new OllamaProvider(config, {
      fetch: vi.fn(),
      chat: {
        invoke: vi.fn().mockResolvedValue({
          content:
            '```json\n{"status":"not_found","answer":null,"citedChunkIds":[]}\n```',
        }),
      },
      embeddings: { embedDocuments: vi.fn(), embedQuery: vi.fn() },
    });

    const decision = await provider.decide({
      system: "system prompt",
      question: "¿Cuál es el plazo?",
      context: [],
    });

    expect(decision).toEqual({
      status: "not_found",
      answer: null,
      citedChunkIds: [],
    });
  });

  it("parses a JSON decision wrapped in an unlabeled code fence", async () => {
    const provider = new OllamaProvider(config, {
      fetch: vi.fn(),
      chat: {
        invoke: vi.fn().mockResolvedValue({
          content:
            '```\n{"status":"ambiguous","answer":null,"citedChunkIds":[]}\n```',
        }),
      },
      embeddings: { embedDocuments: vi.fn(), embedQuery: vi.fn() },
    });

    const decision = await provider.decide({
      system: "system prompt",
      question: "¿Cuál es el plazo?",
      context: [],
    });

    expect(decision).toEqual({
      status: "ambiguous",
      answer: null,
      citedChunkIds: [],
    });
  });

  it("returns the raw text unchanged when the model does not return valid JSON", async () => {
    const provider = new OllamaProvider(config, {
      fetch: vi.fn(),
      chat: {
        invoke: vi.fn().mockResolvedValue({
          content: "Lo siento, no puedo responder a esa pregunta.",
        }),
      },
      embeddings: { embedDocuments: vi.fn(), embedQuery: vi.fn() },
    });

    const decision = await provider.decide({
      system: "system prompt",
      question: "¿Cuál es el plazo?",
      context: [],
    });

    expect(decision).toBe("Lo siento, no puedo responder a esa pregunta.");
  });
});
