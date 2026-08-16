import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { PathLike } from "node:fs";
import { mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { loadConfig } from "../../src/config/env.js";
import {
  RetryingUploadCleaner,
  SERVER_UPLOAD_FILENAME_PATTERN,
  secureUploadDirectory,
  sweepOrphanUploads,
} from "../../src/documents/upload-storage.js";
import { ActivityTracker } from "../../src/shared/activity-tracker.js";

type OpenCallback = (error: NodeJS.ErrnoException | null, fd: number) => void;
type OpenFile = (
  path: PathLike,
  flags: number,
  mode: number,
  callback: OpenCallback,
) => void;

const fsControls = vi.hoisted(() => ({
  actualOpen: undefined as OpenFile | undefined,
  openFile: vi.fn<OpenFile>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  fsControls.actualOpen = actual.open as OpenFile;
  return { ...actual, open: fsControls.openFile };
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  return {
    promise: new Promise<T>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve: (value) => resolvePromise?.(value),
  };
}

function realOpen(): OpenFile {
  if (!fsControls.actualOpen) {
    throw new Error("Real fs.open was not initialized");
  }
  return fsControls.actualOpen;
}

function installDelayedOpen() {
  const opened = deferred<{ fd: number; release(): void }>();
  fsControls.openFile.mockImplementation((path, flags, mode, callback) => {
    realOpen()(path, flags, mode, (error, fd) => {
      opened.resolve({ fd, release: () => callback(error, fd) });
    });
  });
  return opened.promise;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

class ObservableActivityTracker extends ActivityTracker {
  private readonly routeCompleted = deferred<void>();

  override begin(): () => void {
    const finish = super.begin();
    return () => {
      finish();
      if (this.activeCount === 1) {
        this.routeCompleted.resolve();
      }
    };
  }

  waitForRouteCompletionWhileStorageIsPending(): Promise<void> {
    return this.routeCompleted.promise;
  }
}

async function abortMultipartUpload(server: Server): Promise<void> {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server has no TCP address");
  }
  const boundary = "connectia-controlled-abort";
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="private.pdf"',
    "Content-Type: application/pdf",
    "",
    "%PDF-private-request-content",
  ].join("\r\n");
  const socket = createConnection({ host: "127.0.0.1", port: address.port });
  socket.on("error", () => undefined);
  await once(socket, "connect");
  socket.write(
    [
      "POST /api/v1/indexing/jobs HTTP/1.1",
      "Host: 127.0.0.1",
      "Authorization: Bearer test-auth-token-with-at-least-32-characters",
      "Idempotency-Key: controlled-abort",
      `Content-Type: multipart/form-data; boundary=${boundary}`,
      `Content-Length: ${Buffer.byteLength(body) + 10_000}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n"),
  );
  socket.destroy();
  await once(socket, "close");
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const roots: string[] = [];
const servers: Server[] = [];

beforeEach(() => {
  fsControls.openFile.mockReset();
  fsControls.openFile.mockImplementation(realOpen());
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("late upload cleanup reporting", () => {
  it("reports one sanitized late failure and leaves a sweep-recoverable orphan after a real client abort", async () => {
    const root = await mkdtemp(join(tmpdir(), "connectia-late-cleanup-"));
    roots.push(root);
    const uploadDirectory = join(root, "uploads");
    const config = loadConfig({
      AUTH_TOKEN: "test-auth-token-with-at-least-32-characters",
      DATABASE_PATH: join(root, "database.sqlite"),
      TEMP_DIR: uploadDirectory,
      PORT: "3000",
    });
    const activity = new ObservableActivityTracker();
    const reports: unknown[] = [];
    let unlinkAttempts = 0;
    const opened = installDelayedOpen();
    const app = createApp({
      activity,
      config,
      logger: pino({ level: "silent" }),
      indexingService: {
        enqueue: async () => {
          throw new Error("enqueue must not run for an aborted upload");
        },
      },
      uploadFailureReporter: (report) => {
        reports.push(report);
      },
      uploadUnlink: async () => {
        unlinkAttempts += 1;
        throw new Error("private unlink failure");
      },
    });
    const server = app.listen(0);
    servers.push(server);
    await once(server, "listening");

    const abort = abortMultipartUpload(server);
    const delayed = await opened;
    await abort;
    await activity.waitForRouteCompletionWhileStorageIsPending();
    expect(activity.activeCount).toBe(1);
    delayed.release();
    await activity.waitForIdle();

    expect(unlinkAttempts).toBe(3);
    expect(reports).toEqual([
      {
        code: "UPLOAD_CLEANUP_FAILED",
        phase: "terminal_cleanup",
      },
    ]);
    const serializedReport = JSON.stringify(reports);
    expect(serializedReport).not.toContain(root);
    expect(serializedReport).not.toContain("private.pdf");
    expect(serializedReport).not.toContain("private-request-content");
    expect(serializedReport).not.toContain("unlink");

    const [orphanName] = await readdir(uploadDirectory);
    expect(orphanName).toMatch(SERVER_UPLOAD_FILENAME_PATTERN);
    const unrelatedPath = join(uploadDirectory, "unrelated.txt");
    const liveName = `connectia-upload-${randomUUID()}.pdf`;
    const livePath = join(secureUploadDirectory(uploadDirectory), liveName);
    await writeFile(unrelatedPath, "keep");
    await writeFile(livePath, "%PDF-live");

    const removed = await sweepOrphanUploads(
      uploadDirectory,
      new Set([livePath]),
      new RetryingUploadCleaner(unlink),
    );

    expect(removed).toBe(1);
    expect((await readdir(uploadDirectory)).sort()).toEqual(
      ["unrelated.txt", liveName].sort(),
    );
  });
});
