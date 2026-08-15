import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/api/app.js", () => ({
  createApp: () => ({
    listen: (_port: number, onListening: () => void) => onListening(),
  }),
}));

describe("server startup", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("informa en español el puerto de escucha", async () => {
    vi.stubEnv("AUTH_TOKEN", "test-auth-token-with-at-least-32-characters");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await import("../../src/server.js");

    expect(log).toHaveBeenCalledWith(
      "La API RAG de Connectia escucha en el puerto 3000",
    );
  });
});
