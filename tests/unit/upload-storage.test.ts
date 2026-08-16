import { EventEmitter } from "node:events";
import {
  fstatSync,
  type PathLike,
  type WriteStream,
  type WriteStreamOptions,
} from "node:fs";
import { mkdtemp, readdir, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RetryingUploadCleaner,
  SecureUploadStorage,
  secureUploadDirectory,
  UploadCleanupError,
  UploadStorageError,
} from "../../src/documents/upload-storage.js";
import { ActivityTracker } from "../../src/shared/activity-tracker.js";

type OpenCallback = (error: NodeJS.ErrnoException | null, fd: number) => void;
type OpenFile = (
  path: PathLike,
  flags: number,
  mode: number,
  callback: OpenCallback,
) => void;
type OutputFactory = (
  path: PathLike,
  options?: BufferEncoding | WriteStreamOptions,
) => WriteStream;

const fsControls = vi.hoisted(() => ({
  actualOpen: undefined as OpenFile | undefined,
  actualOutputFactory: undefined as OutputFactory | undefined,
  openFile: vi.fn<OpenFile>(),
  outputFactory: vi.fn<OutputFactory>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  fsControls.actualOpen = actual.open as OpenFile;
  fsControls.actualOutputFactory = actual.createWriteStream as OutputFactory;
  return {
    ...actual,
    open: fsControls.openFile,
    createWriteStream: fsControls.outputFactory,
  };
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

function actualOpen(): OpenFile {
  if (!fsControls.actualOpen) {
    throw new Error("The real fs.open implementation was not initialized");
  }
  return fsControls.actualOpen;
}

function actualOutputFactory(): OutputFactory {
  if (!fsControls.actualOutputFactory) {
    throw new Error(
      "The real fs.createWriteStream implementation was not initialized",
    );
  }
  return fsControls.actualOutputFactory;
}

function installDelayedOpen() {
  const opened = deferred<{ fd: number; release(): void }>();
  fsControls.openFile.mockImplementation((path, flags, mode, callback) => {
    actualOpen()(path, flags, mode, (error, fd) => {
      opened.resolve({
        fd,
        release: () => callback(error, fd),
      });
    });
  });
  return opened.promise;
}

function createStorageCall(
  directory: string,
  cleaner = new RetryingUploadCleaner(),
  activity?: ActivityTracker,
) {
  const request = new EventEmitter() as Request;
  const stream = new PassThrough();
  const file = { stream } as unknown as Express.Multer.File;
  let callbackCalls = 0;
  const completed = deferred<{
    error: unknown;
    info: Partial<Express.Multer.File> | undefined;
  }>();
  new SecureUploadStorage(directory, cleaner, activity)._handleFile(
    request,
    file,
    (error, info) => {
      callbackCalls += 1;
      completed.resolve({ error, info });
    },
  );
  return {
    callbackCalls: () => callbackCalls,
    completed: completed.promise,
    file,
    request,
    stream,
  };
}

const roots: string[] = [];

beforeEach(() => {
  fsControls.openFile.mockReset();
  fsControls.outputFactory.mockReset();
  fsControls.openFile.mockImplementation(actualOpen());
  fsControls.outputFactory.mockImplementation(actualOutputFactory());
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("SecureUploadStorage terminal state", () => {
  it("closes and removes a delayed-open file when the request aborts first", async () => {
    const root = await mkdtemp(join(tmpdir(), "connectia-storage-unit-"));
    roots.push(root);
    const directory = secureUploadDirectory(join(root, "uploads"));
    const opened = installDelayedOpen();
    let unlinkCalls = 0;
    const cleaner = new RetryingUploadCleaner(async (path) => {
      unlinkCalls += 1;
      await unlink(path);
    });
    const call = createStorageCall(directory, cleaner);
    const delayed = await opened;

    call.request.emit("aborted");
    delayed.release();
    const unlinkCallsOnRelease = unlinkCalls;
    let descriptorClosed = false;
    try {
      fstatSync(delayed.fd);
    } catch {
      descriptorClosed = true;
    }
    if (unlinkCallsOnRelease === 0) {
      call.stream.destroy(new Error("test cleanup after missed abort"));
    }
    const outcome = await call.completed;

    expect(unlinkCallsOnRelease).toBe(1);
    expect(descriptorClosed).toBe(true);
    expect(outcome.error).toBeInstanceOf(UploadStorageError);
    expect(call.callbackCalls()).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("keeps application activity active until delayed-open abort cleanup settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "connectia-storage-unit-"));
    roots.push(root);
    const directory = secureUploadDirectory(join(root, "uploads"));
    const opened = installDelayedOpen();
    const activity = new ActivityTracker();
    const call = createStorageCall(
      directory,
      new RetryingUploadCleaner(),
      activity,
    );
    const delayed = await opened;

    call.request.emit("aborted");
    let idle = false;
    void activity.waitForIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    const activeBeforeOpenReturns = activity.activeCount;
    const idleBeforeOpenReturns = idle;
    delayed.release();
    await call.completed;
    await activity.waitForIdle();

    expect(activeBeforeOpenReturns).toBe(1);
    expect(idleBeforeOpenReturns).toBe(false);
    expect(idle).toBe(true);
    expect(activity.activeCount).toBe(0);
    expect(await readdir(directory)).toEqual([]);
  });

  it("observes an abort fired after open while the output is being created", async () => {
    const root = await mkdtemp(join(tmpdir(), "connectia-storage-unit-"));
    roots.push(root);
    const directory = secureUploadDirectory(join(root, "uploads"));
    let unlinkCalls = 0;
    const cleaner = new RetryingUploadCleaner(async (path) => {
      unlinkCalls += 1;
      await unlink(path);
    });
    const outputCreated = deferred<void>();
    let request: Request | undefined;
    fsControls.outputFactory.mockImplementation((path, options) => {
      const output = actualOutputFactory()(path, options);
      request?.emit("aborted");
      outputCreated.resolve();
      return output;
    });
    const call = createStorageCall(directory, cleaner);
    request = call.request;
    await outputCreated.promise;
    const unlinkCallsAfterCreation = unlinkCalls;
    if (unlinkCallsAfterCreation === 0) {
      call.stream.destroy(new Error("test cleanup after missed abort"));
    }
    const outcome = await call.completed;

    expect(unlinkCallsAfterCreation).toBe(1);
    expect(outcome.error).toBeInstanceOf(UploadStorageError);
    expect(call.callbackCalls()).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("removes the created file after an input-stream error", async () => {
    const root = await mkdtemp(join(tmpdir(), "connectia-storage-unit-"));
    roots.push(root);
    const directory = secureUploadDirectory(join(root, "uploads"));
    const outputCreated = deferred<void>();
    fsControls.outputFactory.mockImplementation((path, options) => {
      const output = actualOutputFactory()(path, options);
      outputCreated.resolve();
      return output;
    });
    const call = createStorageCall(directory);
    await outputCreated.promise;

    call.stream.destroy(new Error("private input-stream failure"));
    const outcome = await call.completed;

    expect(outcome.error).toBeInstanceOf(UploadStorageError);
    expect(call.callbackCalls()).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("removes the created file after an output-stream error", async () => {
    const root = await mkdtemp(join(tmpdir(), "connectia-storage-unit-"));
    roots.push(root);
    const directory = secureUploadDirectory(join(root, "uploads"));
    const outputCreated = deferred<WriteStream>();
    fsControls.outputFactory.mockImplementation((path, options) => {
      const output = actualOutputFactory()(path, options);
      outputCreated.resolve(output);
      return output;
    });
    const call = createStorageCall(directory);
    const output = await outputCreated.promise;

    output.destroy(new Error("private output-stream failure"));
    const outcome = await call.completed;

    expect(outcome.error).toBeInstanceOf(UploadStorageError);
    expect(call.callbackCalls()).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("settles and unlinks exactly once for repeated terminal events", async () => {
    const root = await mkdtemp(join(tmpdir(), "connectia-storage-unit-"));
    roots.push(root);
    const directory = secureUploadDirectory(join(root, "uploads"));
    const outputCreated = deferred<WriteStream>();
    fsControls.outputFactory.mockImplementation((path, options) => {
      const output = actualOutputFactory()(path, options);
      outputCreated.resolve(output);
      return output;
    });
    let unlinkCalls = 0;
    const cleaner = new RetryingUploadCleaner(async (path) => {
      unlinkCalls += 1;
      await unlink(path);
    });
    const call = createStorageCall(directory, cleaner);
    const output = await outputCreated.promise;

    call.request.emit("aborted");
    call.stream.destroy(new Error("private repeated input failure"));
    output.destroy(new Error("private repeated output failure"));
    const outcome = await call.completed;
    await Promise.resolve();

    expect(outcome.error).toBeInstanceOf(UploadStorageError);
    expect(unlinkCalls).toBe(1);
    expect(call.callbackCalls()).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("surfaces cleanup exhaustion after a pre-open abort without leaking the fd", async () => {
    const root = await mkdtemp(join(tmpdir(), "connectia-storage-unit-"));
    roots.push(root);
    const directory = secureUploadDirectory(join(root, "uploads"));
    const opened = installDelayedOpen();
    let attempts = 0;
    const cleaner = new RetryingUploadCleaner(async () => {
      attempts += 1;
      throw new Error("private cleanup failure");
    });
    const call = createStorageCall(directory, cleaner);
    const delayed = await opened;

    call.request.emit("aborted");
    delayed.release();
    const attemptsOnRelease = attempts;
    let descriptorClosed = false;
    try {
      fstatSync(delayed.fd);
    } catch {
      descriptorClosed = true;
    }
    if (attemptsOnRelease === 0) {
      call.stream.destroy(new Error("test cleanup after missed abort"));
    }
    const outcome = await call.completed;

    expect(attemptsOnRelease).toBe(1);
    expect(attempts).toBe(3);
    expect(descriptorClosed).toBe(true);
    expect(outcome.error).toBeInstanceOf(UploadCleanupError);
    expect(call.callbackCalls()).toBe(1);
    expect(await readdir(directory)).toHaveLength(1);
  });

  it("streams a successful upload once and retains its file", async () => {
    const root = await mkdtemp(join(tmpdir(), "connectia-storage-unit-"));
    roots.push(root);
    const directory = secureUploadDirectory(join(root, "uploads"));
    const call = createStorageCall(directory);

    call.stream.end("%PDF-success");
    const outcome = await call.completed;

    expect(outcome.error).toBeUndefined();
    expect(outcome.info?.size).toBe(12);
    expect(call.callbackCalls()).toBe(1);
    expect(await readFile(outcome.info?.path ?? "", "utf8")).toBe(
      "%PDF-success",
    );
  });
});
