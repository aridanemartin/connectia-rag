import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { loadConfig } from "../../src/config/env.js";

const AUTH_TOKEN = "test-auth-token-with-at-least-32-characters";
const config = loadConfig({ AUTH_TOKEN });
const silentLogger = pino({ level: "silent" });

function buildApp() {
  return createApp({ config, logger: silentLogger });
}

describe("HTTP boundary", () => {
  it("rejects a protected route without a bearer token", async () => {
    const response = await request(buildApp()).get("/api/v1/test-protected");

    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({
      code: "UNAUTHORIZED",
      message: "No autorizado.",
    });
    expect(response.body.error.requestId).toBe(
      response.headers["x-request-id"],
    );
  });

  it("accepts the configured bearer token and rejects a wrong token", async () => {
    const wrongResponse = await request(buildApp())
      .get("/openapi.json")
      .set("Authorization", `Bearer ${"x".repeat(AUTH_TOKEN.length)}`);
    const validResponse = await request(buildApp())
      .get("/openapi.json")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`);

    expect(wrongResponse.status).toBe(401);
    expect(wrongResponse.body.error.code).toBe("UNAUTHORIZED");
    expect(validResponse.status).toBe(200);
  });

  it("keeps liveness public while protecting documentation", async () => {
    const healthResponse = await request(buildApp()).get("/health/live");
    const documentResponse = await request(buildApp()).get("/openapi.json");
    const docsResponse = await request(buildApp()).get("/docs/");

    expect(healthResponse.status).toBe(200);
    expect(documentResponse.status).toBe(401);
    expect(docsResponse.status).toBe(401);
  });

  it("publishes the canonical OpenAPI document to authenticated callers", async () => {
    const response = await request(buildApp())
      .get("/openapi.json")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body.info.title).toBe("Connectia RAG API");
    expect(response.body.components.securitySchemes.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
    });
  });

  it("serves authenticated Swagger UI", async () => {
    const response = await request(buildApp())
      .get("/docs/")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.type).toBe("text/html");
  });

  it("echoes a valid request ID", async () => {
    const requestId = randomUUID();

    const response = await request(buildApp())
      .get("/api/v1/test-protected")
      .set("X-Request-Id", requestId);

    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.body.error.requestId).toBe(requestId);
  });

  it("replaces an invalid request ID with a generated UUID", async () => {
    const response = await request(buildApp())
      .get("/api/v1/test-protected")
      .set("X-Request-Id", "not-a-uuid");

    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(response.body.error.requestId).toBe(
      response.headers["x-request-id"],
    );
  });

  it("does not write authorization headers or tokens to request logs", async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = pino(stream);

    await request(createApp({ config, logger }))
      .get("/openapi.json")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`);

    const logs = chunks.join("");
    expect(logs).not.toContain(AUTH_TOKEN);
    expect(logs.toLowerCase()).not.toContain("authorization");
  });

  it("returns safe AppError details through the HTTP envelope", async () => {
    const [{ AppError }, { errorHandler }, { requestId }] = await Promise.all([
      import("../../src/api/errors.js"),
      import("../../src/api/middleware/error-handler.js"),
      import("../../src/api/middleware/request-id.js"),
    ]);
    const app = express();
    app.use(requestId);
    app.get("/validation-error", () => {
      throw new AppError(422, "VALIDATION_ERROR", "Solicitud no válida.", [
        { field: "question" },
      ]);
    });
    app.use(errorHandler);

    const response = await request(app).get("/validation-error");

    expect(response.status).toBe(422);
    expect(response.body.error).toEqual({
      code: "VALIDATION_ERROR",
      message: "Solicitud no válida.",
      requestId: response.headers["x-request-id"],
      details: [{ field: "question" }],
    });
  });

  it("sanitizes unexpected errors without exposing stack traces", async () => {
    const [{ errorHandler }, { requestId }] = await Promise.all([
      import("../../src/api/middleware/error-handler.js"),
      import("../../src/api/middleware/request-id.js"),
    ]);
    const app = express();
    app.use(requestId);
    app.get("/unexpected-error", () => {
      throw new Error("sensitive implementation detail");
    });
    app.use(errorHandler);

    const response = await request(app).get("/unexpected-error");

    expect(response.status).toBe(500);
    expect(response.body.error).toEqual({
      code: "INTERNAL_ERROR",
      message: "Ha ocurrido un error interno.",
      requestId: response.headers["x-request-id"],
    });
    expect(JSON.stringify(response.body)).not.toContain(
      "sensitive implementation detail",
    );
    expect(JSON.stringify(response.body)).not.toContain("stack");
  });
});
