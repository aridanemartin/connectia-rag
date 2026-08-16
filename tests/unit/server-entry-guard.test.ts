import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isDirectExecution } from "../../src/server.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function entryFiles() {
  const root = await mkdtemp(join(tmpdir(), "connectia-entry-guard-"));
  roots.push(root);
  const modulePath = join(root, "server.js");
  const unrelatedPath = join(root, "worker.js");
  const symlinkPath = join(root, "linked-server.js");
  await writeFile(modulePath, "export {};\n");
  await writeFile(unrelatedPath, "export {};\n");
  await symlink(modulePath, symlinkPath);
  return {
    modulePath,
    moduleUrl: pathToFileURL(modulePath).href,
    symlinkPath,
    unrelatedPath,
  };
}

describe("server direct-execution guard", () => {
  it("trusts import.meta.main when the current runtime provides it", () => {
    expect(
      isDirectExecution({
        importMetaMain: true,
        moduleUrl: "file:///not-read.js",
        argvEntry: undefined,
      }),
    ).toBe(true);
  });

  it("falls back to the real argv entry when import.meta.main is unavailable", async () => {
    const files = await entryFiles();

    expect(
      isDirectExecution({
        importMetaMain: undefined,
        moduleUrl: files.moduleUrl,
        argvEntry: files.modulePath,
      }),
    ).toBe(true);
  });

  it("recognizes a symlinked direct entry through the realpath fallback", async () => {
    const files = await entryFiles();

    expect(
      isDirectExecution({
        importMetaMain: false,
        moduleUrl: files.moduleUrl,
        argvEntry: files.symlinkPath,
      }),
    ).toBe(true);
  });

  it("does not start when another entry point merely imports the server", async () => {
    const files = await entryFiles();

    expect(
      isDirectExecution({
        importMetaMain: undefined,
        moduleUrl: files.moduleUrl,
        argvEntry: files.unrelatedPath,
      }),
    ).toBe(false);
  });

  it("does not start without an argv entry when import.meta.main is unavailable", async () => {
    const files = await entryFiles();

    expect(
      isDirectExecution({
        importMetaMain: undefined,
        moduleUrl: files.moduleUrl,
        argvEntry: undefined,
      }),
    ).toBe(false);
  });
});
