import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { AppError } from "../../src/api/errors.js";
import { loadConfig } from "../../src/config/env.js";
import {
  createIndexingComposition,
  type IndexingComposition,
  type IndexingRequest,
} from "../../src/documents/indexing.service.js";
import type { IndexingJob } from "../../src/persistence/repositories/indexing-job.repository.js";
import { startServer } from "../../src/server.js";
import { createTestPdf } from "../support/create-test-pdf.js";

const AUTH_TOKEN = "test-auth-token-with-at-least-32-characters";
const roots: string[] = [];

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

type AbortAwareEnqueue = (
  input: IndexingRequest,
  signal?: AbortSignal,
) => Promise<IndexingJob>;

function queuedJob(input: IndexingRequest): IndexingJob {
  return {
    id: randomUUID(),
    documentId: input.documentId,
    versionId: input.versionId,
    idempotencyKey: input.idempotencyKey,
    requestHash: "request-hash",
    contentHash: "content-hash",
    tempFilePath: input.tempFilePath,
    status: "queued",
    stage: "queued",
    progress: 0,
    attempts: 0,
    leaseOwner: null,
    leaseUntil: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    completedAt: null,
  };
}

async function startActivityServer(
  enqueue: AbortAwareEnqueue,
  options: {
    shutdownTimeoutMs: number;
    shutdownAbortGraceMs: number;
  },
) {
  const root = await mkdtemp(join(tmpdir(), "connectia-server-activity-"));
  roots.push(root);
  const uploadDirectory = join(root, "uploads");
  const config = {
    ...loadConfig({
      AUTH_TOKEN,
      DATABASE_PATH: join(root, "connectia.sqlite"),
      TEMP_DIR: uploadDirectory,
    }),
    PORT: 0,
  };
  const owned = createIndexingComposition(config);
  let closeCalls = 0;
  const closed = deferred<void>();
  const composition: IndexingComposition = {
    ...owned,
    indexingService: { enqueue } as IndexingComposition["indexingService"],
    close: () => {
      closeCalls += 1;
      owned.close();
      closed.resolve();
    },
  };
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const runtime = await startServer({
    config,
    createComposition: () => composition,
    createApplication: (dependencies) =>
      createApp({
        ...dependencies,
        logger: pino({ level: "silent" }),
      }),
    registerSignalHandlers: false,
    ...options,
  });
  const pdfPath = await createTestPdf(root, [
    ["MATRÍCULA", "Contenido de actividad durante apagado."],
  ]);
  const send = () =>
    request(runtime.server)
      .post("/api/v1/indexing/jobs")
      .set("Authorization", `Bearer ${AUTH_TOKEN}`)
      .set("Idempotency-Key", `activity-${randomUUID()}`)
      .field("documentId", randomUUID())
      .field("versionId", randomUUID())
      .field("title", "Matrícula 2026-2027")
      .field("academicYear", "2026-2027")
      .attach("file", pdfPath, {
        filename: "matricula.pdf",
        contentType: "application/pdf",
      });
  return {
    closeCalls: () => closeCalls,
    closed: closed.promise,
    composition,
    runtime,
    send,
    uploadDirectory,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("production indexing activity shutdown", () => {
  it("drains ordinary route work before closing without aborting it", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let receivedSignal: AbortSignal | undefined;
    const context = await startActivityServer(
      async (input, signal) => {
        receivedSignal = signal;
        entered.resolve();
        await release.promise;
        return queuedJob(input);
      },
      { shutdownTimeoutMs: 500, shutdownAbortGraceMs: 500 },
    );
    const response = context.send();
    const responseOutcome = response.then(
      (value) => value,
      (error: unknown) => error,
    );
    await entered.promise;

    const firstShutdown = context.runtime.shutdown();
    const repeatedShutdown = context.runtime.shutdown();
    expect(context.closeCalls()).toBe(0);
    release.resolve();
    const accepted = await responseOutcome;
    await Promise.all([firstShutdown, repeatedShutdown]);

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(false);
    expect(accepted).toMatchObject({ status: 202 });
    expect(context.closeCalls()).toBe(1);
  });

  it("aborts at the deadline but closes only after the route settles and cleans", async () => {
    const entered = deferred<void>();
    const abortObserved = deferred<void>();
    const fallbackRelease = deferred<void>();
    const settle = deferred<void>();
    let receivedSignal: AbortSignal | undefined;
    const context = await startActivityServer(
      async (_input, signal) => {
        receivedSignal = signal;
        entered.resolve();
        if (signal) {
          if (!signal.aborted) {
            await new Promise<void>((resolveAbort) => {
              signal.addEventListener("abort", () => resolveAbort(), {
                once: true,
              });
            });
          }
          abortObserved.resolve();
        } else {
          await fallbackRelease.promise;
        }
        await settle.promise;
        throw new AppError(
          503,
          "INDEXING_ABORTED",
          "La indexación se ha cancelado.",
        );
      },
      { shutdownTimeoutMs: 10, shutdownAbortGraceMs: 500 },
    );
    const responseOutcome = context.send().then(
      (value) => value,
      (error: unknown) => error,
    );
    await entered.promise;

    const shutdown = context.runtime.shutdown();
    const firstOutcome = await Promise.race([
      abortObserved.promise.then(() => "aborted" as const),
      shutdown.then(() => "shutdown" as const),
    ]);
    const closeCallsWhileActive = context.closeCalls();
    fallbackRelease.resolve();
    settle.resolve();
    await shutdown;
    await responseOutcome;

    expect(firstOutcome).toBe("aborted");
    expect(receivedSignal?.aborted).toBe(true);
    expect(closeCallsWhileActive).toBe(0);
    expect(context.closeCalls()).toBe(1);
    expect(await readdir(context.uploadDirectory)).toEqual([]);
  });

  it("rejects bounded shutdown without closing active non-cooperative work, then closes on idle", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const context = await startActivityServer(
      async () => {
        entered.resolve();
        await release.promise;
        throw new AppError(
          503,
          "INDEXING_ABORTED",
          "La indexación se ha cancelado.",
        );
      },
      { shutdownTimeoutMs: 10, shutdownAbortGraceMs: 10 },
    );
    const responseOutcome = context.send().then(
      (value) => value,
      (error: unknown) => error,
    );
    await entered.promise;

    const shutdownOutcome = await context.runtime.shutdown().then(
      () => ({ resolved: true as const, error: undefined }),
      (error: unknown) => ({ resolved: false as const, error }),
    );
    const closeCallsAtRejection = context.closeCalls();
    release.resolve();
    await context.closed;
    await responseOutcome;

    expect(shutdownOutcome.resolved).toBe(false);
    expect(shutdownOutcome.error).toMatchObject({
      name: "ShutdownActivityTimeoutError",
    });
    expect(closeCallsAtRejection).toBe(0);
    expect(context.closeCalls()).toBe(1);
    expect(await readdir(context.uploadDirectory)).toEqual([]);
  });

  it("waits for the worker loop to exit before closing the database", async () => {
    const root = await mkdtemp(join(tmpdir(), "connectia-server-worker-"));
    roots.push(root);
    const uploadDirectory = join(root, "uploads");
    const config = {
      ...loadConfig({
        AUTH_TOKEN,
        DATABASE_PATH: join(root, "connectia.sqlite"),
        TEMP_DIR: uploadDirectory,
      }),
      PORT: 0,
    };
    const owned = createIndexingComposition(config);
    const workerRelease = deferred<void>();
    let workerSettled = false;
    let closedBeforeWorkerSettled = false;
    let closeCalls = 0;
    const composition: IndexingComposition = {
      ...owned,
      worker: {
        start: (signal: AbortSignal) =>
          new Promise<void>((resolveStart) => {
            signal.addEventListener(
              "abort",
              () => {
                void workerRelease.promise.then(() => {
                  workerSettled = true;
                  resolveStart();
                });
              },
              { once: true },
            );
          }),
      } as IndexingComposition["worker"],
      close: () => {
        closeCalls += 1;
        if (!workerSettled) {
          closedBeforeWorkerSettled = true;
        }
        owned.close();
      },
    };
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const runtime = await startServer({
      config,
      createComposition: () => composition,
      createApplication: (dependencies) =>
        createApp({
          ...dependencies,
          logger: pino({ level: "silent" }),
        }),
      registerSignalHandlers: false,
      shutdownTimeoutMs: 500,
      shutdownAbortGraceMs: 500,
    });

    const shutdownPromise = runtime.shutdown();
    // Give shutdown() a chance to reach the point where it would close the
    // composition, without our fake worker having settled yet.
    await new Promise((resolveTick) => setImmediate(resolveTick));
    expect(closeCalls).toBe(0);
    workerRelease.resolve();
    await shutdownPromise;

    expect(closeCalls).toBe(1);
    expect(closedBeforeWorkerSettled).toBe(false);
  });
});
