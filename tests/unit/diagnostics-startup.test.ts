import { describe, expect, it, vi } from "vitest";

const diagnostics = {
  purgeExpired: vi.fn(async () => 0),
  record: vi.fn(),
  listRecent: vi.fn(),
};

const compositionInstance = {
  indexingService: {},
  jobs: { find: vi.fn() },
  lifecycle: {},
  questionService: {},
  worker: { start: vi.fn(async () => {}) },
  cleanupWorker: { start: vi.fn(async () => {}) },
  database: {},
  diagnostics,
  sweepOrphans: vi.fn(async () => 0),
  recoverExpiredJobs: vi.fn(() => 0),
  recoverExpiredCleanupJobs: vi.fn(() => 0),
  close: vi.fn(),
};

const fakeServer = {
  once: vi.fn(),
  off: vi.fn(),
  close: vi.fn((cb: () => void) => cb?.()),
  listening: false as const,
  closeAllConnections: vi.fn(),
  address: vi.fn(),
};

vi.mock("../../src/documents/indexing.service.js", () => ({
  createIndexingComposition: vi.fn(() => compositionInstance),
}));

vi.mock("../../src/api/app.js", () => ({
  createApp: vi.fn(() => ({
    listen: vi.fn((_port: number, cb: () => void) => {
      // Defer callback to avoid TDZ in server.ts's listen function
      setImmediate(() => cb());
      return fakeServer;
    }),
  })),
}));

describe("startup purge", () => {
  it("calls purgeExpired once at startup", async () => {
    vi.stubEnv("AUTH_TOKEN", "test-auth-token-with-at-least-32-characters");

    const serverModule = await import("../../src/server.js");
    const running = await serverModule.startServer({
      registerSignalHandlers: false,
      shutdownTimeoutMs: 100,
      shutdownAbortGraceMs: 50,
    });

    expect(diagnostics.purgeExpired).toHaveBeenCalledOnce();
    await running.shutdown();
    vi.unstubAllEnvs();
  });
});
