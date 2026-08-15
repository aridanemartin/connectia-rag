import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { loadConfig } from "../../src/config/env.js";

describe("GET /health/live", () => {
  it("returns liveness without authentication", async () => {
    const app = createApp({
      config: loadConfig({
        AUTH_TOKEN: "test-auth-token-with-at-least-32-characters",
      }),
    });

    const response = await request(app).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});
