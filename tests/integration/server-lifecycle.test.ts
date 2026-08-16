import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AppDependencies, createApp } from "../../src/api/app.js";
import { loadConfig } from "../../src/config/env.js";
import {
  createIndexingComposition,
  type IndexingComposition,
} from "../../src/documents/indexing.service.js";
import { startServer } from "../../src/server.js";

const AUTH_TOKEN = "test-auth-token-with-at-least-32-characters";
const roots: string[] = [];

describe("production server lifecycle", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("migrates, sweeps, injects one composition and closes it exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "connectia-server-lifecycle-"));
    roots.push(root);
    const uploadDirectory = join(root, "uploads");
    const orphan = join(
      uploadDirectory,
      `connectia-upload-${randomUUID()}.pdf`,
    );
    const config = {
      ...loadConfig({
        AUTH_TOKEN,
        DATABASE_PATH: join(root, "connectia.sqlite"),
        TEMP_DIR: uploadDirectory,
      }),
      PORT: 0,
    };
    let factoryCalls = 0;
    let closeCalls = 0;
    let composition: IndexingComposition | undefined;
    let appDependencies: Partial<AppDependencies> | undefined;
    const createComposition = (productionConfig: typeof config) => {
      factoryCalls += 1;
      const owned = createIndexingComposition(productionConfig);
      mkdirSync(uploadDirectory, { recursive: true });
      writeFileSync(orphan, "%PDF-orphan");
      const close = owned.close.bind(owned);
      composition = {
        ...owned,
        close: () => {
          closeCalls += 1;
          close();
        },
      };
      return composition;
    };
    const createApplication = (dependencies: Partial<AppDependencies>) => {
      appDependencies = dependencies;
      expect(composition).toBeDefined();
      expect(
        composition?.database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'indexing_jobs'",
          )
          .get(),
      ).toEqual({ name: "indexing_jobs" });
      return createApp({
        ...dependencies,
        logger: pino({ level: "silent" }),
      });
    };
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const runtime = await startServer({
      config,
      createComposition,
      createApplication,
      registerSignalHandlers: false,
      shutdownTimeoutMs: 250,
    });
    try {
      expect(factoryCalls).toBe(1);
      expect(appDependencies?.indexingService).toBe(
        composition?.indexingService,
      );
      expect(runtime.composition).toBe(composition);
      expect(runtime.server.listening).toBe(true);
      await expect(access(orphan)).rejects.toMatchObject({ code: "ENOENT" });

      const address = runtime.server.address() as AddressInfo;
      const activeSocket = createConnection({
        host: "127.0.0.1",
        port: address.port,
      });
      await once(activeSocket, "connect");
      activeSocket.write(
        "POST /api/v1/indexing/jobs HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nx",
      );
      const shutdownStartedAt = Date.now();
      await Promise.all([runtime.shutdown(), runtime.shutdown()]);

      expect(Date.now() - shutdownStartedAt).toBeLessThan(1_000);
      expect(closeCalls).toBe(1);
      expect(() => composition?.database.prepare("SELECT 1").get()).toThrow();
      activeSocket.destroy();
    } finally {
      await runtime.shutdown();
    }
  });
});
