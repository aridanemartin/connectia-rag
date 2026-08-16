import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { loadConfig } from "../../src/config/env.js";

const AUTH_TOKEN = "test-auth-token-with-at-least-32-characters";

describe("no HTTP diagnostics route", () => {
  it("returns 404 for any diagnostics path", async () => {
    const config = loadConfig({ AUTH_TOKEN });
    const app = createApp({ config });

    const apiResponse = await request(app)
      .get("/api/v1/diagnostics")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`);
    const plainResponse = await request(app)
      .get("/diagnostics")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`);

    expect(apiResponse.status).toBe(404);
    expect(plainResponse.status).toBe(404);
  });
});
