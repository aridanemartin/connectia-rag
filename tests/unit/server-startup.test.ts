import { afterEach, describe, expect, it, vi } from "vitest";

const serverMocks = vi.hoisted(() => ({
  createApp: vi.fn(() => ({
    listen: vi.fn(),
  })),
  createIndexingComposition: vi.fn(),
}));

vi.mock("../../src/api/app.js", () => ({
  createApp: serverMocks.createApp,
}));

vi.mock("../../src/documents/indexing.service.js", () => ({
  createIndexingComposition: serverMocks.createIndexingComposition,
}));

describe("server startup", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("no crea recursos ni escucha como efecto secundario al importarse", async () => {
    vi.stubEnv("AUTH_TOKEN", "test-auth-token-with-at-least-32-characters");

    const serverModule = await import("../../src/server.js");

    expect(serverModule.startServer).toBeTypeOf("function");
    expect(serverMocks.createIndexingComposition).not.toHaveBeenCalled();
    expect(serverMocks.createApp).not.toHaveBeenCalled();
  });
});
