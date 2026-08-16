import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const AUTH_TOKEN = "test-auth-token-with-at-least-32-characters";
const roots: string[] = [];

async function availablePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to allocate a local test port");
  }
  await new Promise<void>((resolveClosed) =>
    probe.close(() => resolveClosed()),
  );
  return address.port;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("server direct entrypoint", () => {
  it("starts when the supported Node entry path is a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "connectia-server-entrypoint-"));
    roots.push(root);
    const linkedEntry = join(root, "linked-server.ts");
    await symlink(resolve("src/server.ts"), linkedEntry, "file");
    const port = await availablePort();
    const child = spawn(process.execPath, ["--import", "tsx", linkedEntry], {
      cwd: resolve("."),
      env: {
        ...process.env,
        AUTH_TOKEN,
        DATABASE_PATH: join(root, "connectia.sqlite"),
        PORT: String(port),
        TEMP_DIR: join(root, "uploads"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", resolveExit);
    });
    const started = new Promise<boolean>((resolveStarted, rejectStarted) => {
      const timer = setTimeout(
        () => rejectStarted(new Error("Symlinked server startup timed out")),
        3_000,
      );
      const finish = (value: boolean) => {
        clearTimeout(timer);
        resolveStarted(value);
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (chunk.includes(`escucha en el puerto ${port}`)) {
          finish(true);
        }
      });
      child.once("exit", () => finish(false));
    });

    const didStart = await started;
    if (didStart) {
      child.kill("SIGTERM");
    }
    const exitCode = await exited;

    expect(didStart).toBe(true);
    expect(exitCode).toBe(0);
  });
});
