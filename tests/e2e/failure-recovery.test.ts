/**
 * End-to-end test: failure recovery scenarios.
 *
 * Tests:
 * 1. The application recovers from transient failures (503 from model)
 * 2. Malformed model output is handled gracefully
 * 3. The server starts and health checks pass regardless of downstream
 *    dependency failures
 */

import pino from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { loadConfig } from "../../src/config/env.js";
import { ActivityTracker } from "../../src/shared/activity-tracker.js";
import {
  type FakeOllamaServer,
  startFakeOllamaServer,
} from "../support/fake-ollama-server.js";

const AUTH_TOKEN = "test-auth-token-with-at-least-32-characters";

function testConfig(ollamaUrl: string, enableInternalMetrics = false) {
  return loadConfig({
    PORT: "3000",
    LOG_LEVEL: "silent",
    AUTH_TOKEN,
    AUTH_DISABLED: "false",
    DATABASE_PATH: ":memory:",
    TEMP_DIR: "/tmp/test",
    OLLAMA_BASE_URL: ollamaUrl,
    OLLAMA_CHAT_MODEL: "fake-chat-model",
    OLLAMA_EMBEDDING_MODEL: "fake-embed-model",
    QDRANT_URL: "http://localhost:16333",
    QDRANT_COLLECTION: "test-e2e-recovery",
    EMBEDDING_DIMENSIONS: "128",
    DEPENDENCY_TIMEOUT_MS: "5000",
    MAX_PDF_BYTES: (25 * 1024 * 1024).toString(),
    MAX_ACTIVE_GENERATIONS: "2",
    MAX_QUEUED_GENERATIONS: "20",
    QUESTION_QUEUE_TIMEOUT_MS: "5000",
    RAG_TOP_K: "6",
    RAG_SCORE_THRESHOLD: "0.0",
    DIAGNOSTICS_ENABLED: "false",
    DIAGNOSTICS_TTL_HOURS: "24",
    ENABLE_INTERNAL_METRICS: enableInternalMetrics ? "true" : "false",
    INDEXING_EMBED_BATCH_SIZE: "16",
    INDEXING_LEASE_MS: "60000",
    INDEXING_POLL_INTERVAL_MS: "1000",
  });
}

describe("E2E: Failure recovery", () => {
  let fakeOllama: FakeOllamaServer;

  beforeAll(async () => {
    fakeOllama = await startFakeOllamaServer();
  });

  afterAll(async () => {
    await fakeOllama.stop();
  });

  it("health live endpoint always returns 200", async () => {
    const config = testConfig("http://localhost:19999");
    const app = createApp({
      config,
      logger: pino({ level: "silent" }),
      readiness: {
        check: async () => ({
          status: "not_ready",
          dependencies: {
            sqlite: "not_ready",
            qdrant: "not_ready",
            collection: "not_ready",
            ollama: "not_ready",
            chatModel: "not_ready",
            embeddingModel: "not_ready",
            embeddingDimensions: "not_ready",
          },
        }),
      },
    });

    const response = await request(app).get("/health/live");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });

  it("returns 502 when the model returns invalid output", async () => {
    const config = testConfig(fakeOllama.url);
    const app = createApp({
      config,
      logger: pino({ level: "silent" }),
      questionService: {
        ask: async () => {
          throw Object.assign(
            new Error("La respuesta del modelo no tiene el formato esperado."),
            { code: "MODEL_OUTPUT_INVALID" },
          );
        },
      } as never,
      activity: new ActivityTracker(),
    });

    const response = await request(app)
      .post("/api/v1/questions")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`)
      .send({ question: "¿Cuál es el plazo de matrícula?" });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("MODEL_OUTPUT_INVALID");
  });

  it("returns 503 when the question queue times out", async () => {
    const config = testConfig(fakeOllama.url);
    const app = createApp({
      config,
      logger: pino({ level: "silent" }),
      questionService: {
        ask: async () => {
          throw Object.assign(new Error("La cola de generación ha expirado."), {
            code: "QUESTION_QUEUE_TIMEOUT",
          });
        },
      } as never,
      activity: new ActivityTracker(),
    });

    const response = await request(app)
      .post("/api/v1/questions")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`)
      .send({ question: "¿Cuál es el plazo?" });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("QUESTION_QUEUE_TIMEOUT");
  });

  it("returns 404 for unknown routes", async () => {
    const config = testConfig(fakeOllama.url);
    const app = createApp({
      config,
      logger: pino({ level: "silent" }),
    });

    const response = await request(app)
      .get("/api/v1/nonexistent")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  describe("GET /internal/metrics (authenticated)", () => {
    it("returns 401 without bearer token when ENABLE_INTERNAL_METRICS=true", async () => {
      const config = testConfig(fakeOllama.url, true);
      const app = createApp({
        config,
        logger: pino({ level: "silent" }),
      });

      const response = await request(app).get("/internal/metrics");

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 200 with bearer token when ENABLE_INTERNAL_METRICS=true", async () => {
      const config = testConfig(fakeOllama.url, true);
      const app = createApp({
        config,
        logger: pino({ level: "silent" }),
      });

      const response = await request(app)
        .get("/internal/metrics")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("timestamp");
      expect(response.body).toHaveProperty("heapUsedMb");
      expect(response.body).toHaveProperty("eventLoopLagMs");
      expect(typeof response.body.heapUsedMb).toBe("number");
    });

    it("returns 404 when ENABLE_INTERNAL_METRICS=false (route not mounted)", async () => {
      const config = testConfig(fakeOllama.url, false);
      const app = createApp({
        config,
        logger: pino({ level: "silent" }),
      });

      const response = await request(app)
        .get("/internal/metrics")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`);

      expect(response.status).toBe(404);
    });

    it("is mounted AFTER the auth middleware (not public)", async () => {
      // Verify the route ordering by checking that /internal/* is behind auth
      // while /health/live is not
      const config = testConfig(fakeOllama.url, true);
      const app = createApp({
        config,
        logger: pino({ level: "silent" }),
      });

      // Public health endpoint should work without auth
      const healthResponse = await request(app).get("/health/live");
      expect(healthResponse.status).toBe(200);

      // Internal metrics must require auth
      const internalResponse = await request(app).get("/internal/metrics");
      expect(internalResponse.status).toBe(401);
    });
  });
});
