import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { loadConfig } from "../../src/config/env.js";
import {
  type ReadinessCheck,
  ReadinessService,
} from "../../src/health/readiness.service.js";

const config = loadConfig({
  AUTH_TOKEN: "test-auth-token-with-at-least-32-characters",
  EMBEDDING_DIMENSIONS: "2",
});

function readyService(
  overrides: Partial<ReadinessCheck> = {},
  readinessConfig = config,
) {
  return new ReadinessService(readinessConfig, {
    sqlite: { health: vi.fn().mockResolvedValue(true) },
    vectorStore: {
      ensureCollection: vi.fn(),
      upsert: vi.fn(),
      search: vi.fn(),
      deleteVersion: vi.fn(),
      health: vi.fn().mockResolvedValue({
        qdrant: true,
        collection: true,
        dimensions: 2,
      }),
    },
    modelProvider: {
      embedDocuments: vi.fn(),
      embedQuery: vi.fn(),
      decide: vi.fn(),
      health: vi.fn().mockResolvedValue({
        ollama: true,
        chat: true,
        embeddings: true,
        dimensions: 2,
      }),
    },
    ...overrides,
  });
}

describe("ReadinessService", () => {
  it("reports ready only when every dependency and dimension agrees", async () => {
    await expect(readyService().check()).resolves.toEqual({
      status: "ready",
      dependencies: {
        sqlite: "ready",
        qdrant: "ready",
        collection: "ready",
        ollama: "ready",
        chatModel: "ready",
        embeddingModel: "ready",
        embeddingDimensions: "ready",
      },
    });
  });

  it("aggregates safe failures and reports an embedding dimension mismatch", async () => {
    const sqliteHealth = vi.fn().mockImplementation(() => {
      throw new Error("sqlite path /private/data.sqlite");
    });
    const vectorHealth = vi.fn().mockImplementation(() => {
      throw new Error("qdrant URL with token=secret");
    });
    const readiness = readyService({
      sqlite: { health: sqliteHealth },
      vectorStore: {
        ensureCollection: vi.fn(),
        upsert: vi.fn(),
        search: vi.fn(),
        deleteVersion: vi.fn(),
        health: vectorHealth,
      },
      modelProvider: {
        embedDocuments: vi.fn(),
        embedQuery: vi.fn(),
        decide: vi.fn(),
        health: vi.fn().mockResolvedValue({
          ollama: true,
          chat: true,
          embeddings: true,
          dimensions: 3,
        }),
      },
    });

    const result = await readiness.check();

    expect(sqliteHealth).toHaveBeenCalledOnce();
    expect(vectorHealth).toHaveBeenCalledOnce();
    expect(result).toEqual({
      status: "not_ready",
      dependencies: {
        sqlite: "not_ready",
        qdrant: "not_ready",
        collection: "not_ready",
        ollama: "ready",
        chatModel: "ready",
        embeddingModel: "ready",
        embeddingDimensions: "not_ready",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("finishes stalled dependency checks at the configured safe deadline", async () => {
    vi.useFakeTimers();
    const lateVectorFailure = Promise.withResolvers<never>();
    const stalledModelHealth = new Promise<never>(() => {});
    const timeoutConfig = loadConfig({
      AUTH_TOKEN: "test-auth-token-with-at-least-32-characters",
      EMBEDDING_DIMENSIONS: "2",
      DEPENDENCY_TIMEOUT_MS: "25",
    });
    const readiness = readyService(
      {
        vectorStore: {
          ensureCollection: vi.fn(),
          upsert: vi.fn(),
          search: vi.fn(),
          deleteVersion: vi.fn(),
          health: () => lateVectorFailure.promise,
        },
        modelProvider: {
          embedDocuments: vi.fn(),
          embedQuery: vi.fn(),
          decide: vi.fn(),
          health: () => stalledModelHealth,
        },
      },
      timeoutConfig,
    );

    try {
      let result: Awaited<ReturnType<ReadinessService["check"]>> | undefined;
      const check = readiness.check().then((value) => {
        result = value;
      });

      await vi.advanceTimersByTimeAsync(25);

      expect(result).toEqual({
        status: "not_ready",
        dependencies: {
          sqlite: "ready",
          qdrant: "not_ready",
          collection: "not_ready",
          ollama: "not_ready",
          chatModel: "not_ready",
          embeddingModel: "not_ready",
          embeddingDimensions: "not_ready",
        },
      });
      expect(JSON.stringify(result)).not.toContain("token=secret");
      lateVectorFailure.reject(
        new Error("http://qdrant:6333?token=secret should stay private"),
      );
      await check;
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GET /health/ready", () => {
  it("is public, retains request IDs, and returns 200 when ready", async () => {
    const app = createApp({
      config,
      logger: pino({ level: "silent" }),
      readiness: readyService(),
    });

    const response = await request(app)
      .get("/health/ready")
      .set("X-Request-Id", "74bd95cc-a950-46a1-a66a-15ca04eae1d7");

    expect(response.status).toBe(200);
    expect(response.headers["x-request-id"]).toBe(
      "74bd95cc-a950-46a1-a66a-15ca04eae1d7",
    );
    expect(response.body.status).toBe("ready");
  });

  it("returns 503 with safe dependency statuses when not ready", async () => {
    const readiness = {
      check: vi.fn().mockResolvedValue({
        status: "not_ready" as const,
        dependencies: {
          sqlite: "ready" as const,
          qdrant: "not_ready" as const,
          collection: "not_ready" as const,
          ollama: "ready" as const,
          chatModel: "ready" as const,
          embeddingModel: "ready" as const,
          embeddingDimensions: "ready" as const,
        },
      }),
    };
    const app = createApp({
      config,
      logger: pino({ level: "silent" }),
      readiness,
    });

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual(await readiness.check.mock.results[0].value);
  });
});
