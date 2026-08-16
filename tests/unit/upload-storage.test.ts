import { mkdtemp, readdir, rm, watch } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { Request } from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  RetryingUploadCleaner,
  SecureUploadStorage,
  secureUploadDirectory,
  UploadCleanupError,
  UploadStorageError,
} from "../../src/documents/upload-storage.js";

const roots: string[] = [];

async function failInputStream(
  directory: string,
  cleaner = new RetryingUploadCleaner(),
): Promise<unknown> {
  secureUploadDirectory(directory);
  const watcher = watch(directory);
  const created = watcher[Symbol.asyncIterator]().next();
  const stream = new PassThrough();
  const file = {
    stream,
  } as unknown as Express.Multer.File;
  const callback = new Promise<unknown>((resolveCallback) => {
    new SecureUploadStorage(directory, cleaner)._handleFile(
      {} as Request,
      file,
      (error) => resolveCallback(error),
    );
  });
  await created;
  stream.destroy(new Error("private input-stream failure"));
  await watcher.return?.();
  return await Promise.race([
    callback,
    delay(500).then(() => {
      throw new Error("The storage callback timed out");
    }),
  ]);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("SecureUploadStorage", () => {
  it("removes a created file and returns a typed storage error on input failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "connectia-storage-unit-"));
    roots.push(root);
    const directory = join(root, "uploads");

    const error = await failInputStream(directory);

    expect(error).toBeInstanceOf(UploadStorageError);
    expect(await readdir(directory)).toEqual([]);
  });

  it("surfaces a typed cleanup error when input-failure cleanup exhausts retries", async () => {
    const root = await mkdtemp(join(tmpdir(), "connectia-storage-unit-"));
    roots.push(root);
    const directory = join(root, "uploads");
    let attempts = 0;
    const cleaner = new RetryingUploadCleaner(async () => {
      attempts += 1;
      throw new Error("private cleanup failure");
    });

    const error = await failInputStream(directory, cleaner);

    expect(error).toBeInstanceOf(UploadCleanupError);
    expect(attempts).toBe(3);
    expect(await readdir(directory)).toHaveLength(1);
  });
});
