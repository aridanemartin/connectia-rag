import { realpathSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { type AppDependencies, createApp } from "./api/app.js";
import { type AppConfig, loadConfig } from "./config/env.js";
import {
  createIndexingComposition,
  type IndexingComposition,
} from "./documents/indexing.service.js";
import { ActivityTracker } from "./shared/activity-tracker.js";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_ABORT_GRACE_MS = 1_000;

type CompositionFactory = (config: AppConfig) => IndexingComposition;
type ApplicationFactory = (
  dependencies: Partial<AppDependencies>,
) => ReturnType<typeof createApp>;

export class ShutdownActivityTimeoutError extends Error {
  constructor() {
    super("Application activity did not settle after shutdown abort");
    this.name = "ShutdownActivityTimeoutError";
  }
}

export interface StartServerOptions {
  config?: AppConfig;
  createComposition?: CompositionFactory;
  createApplication?: ApplicationFactory;
  registerSignalHandlers?: boolean;
  shutdownTimeoutMs?: number;
  shutdownAbortGraceMs?: number;
}

export interface RunningServer {
  server: Server;
  composition: IndexingComposition;
  activity: ActivityTracker;
  shutdown(): Promise<void>;
}

export interface DirectExecutionInput {
  importMetaMain: boolean | undefined;
  moduleUrl: string;
  argvEntry: string | undefined;
}

export function isDirectExecution(input: DirectExecutionInput): boolean {
  if (input.importMetaMain === true) {
    return true;
  }
  if (!input.argvEntry) {
    return false;
  }
  try {
    return (
      realpathSync.native(fileURLToPath(input.moduleUrl)) ===
      realpathSync.native(input.argvEntry)
    );
  } catch {
    return false;
  }
}

function listen(application: ReturnType<ApplicationFactory>, port: number) {
  return new Promise<Server>((resolveListening, reject) => {
    const server = application.listen(port, () => {
      server.off("error", reject);
      resolveListening(server);
    });
    server.once("error", reject);
  });
}

function beginHttpClose(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolveClosed) => {
    server.close(() => resolveClosed());
  });
}

function settlesWithin(settlement: Promise<unknown>, timeoutMs: number) {
  return new Promise<boolean>((resolveSettled) => {
    let finished = false;
    const finish = (settled: boolean) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolveSettled(settled);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void settlement.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

export async function startServer(
  options: StartServerOptions = {},
): Promise<RunningServer> {
  const config = options.config ?? loadConfig(process.env);
  const compositionFactory =
    options.createComposition ?? createIndexingComposition;
  const applicationFactory = options.createApplication ?? createApp;
  const shutdownTimeoutMs =
    options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const abortGraceMs = options.shutdownAbortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
  const activity = new ActivityTracker();
  const composition = compositionFactory(config);
  let compositionClosed = false;
  const closeComposition = () => {
    if (compositionClosed) {
      return;
    }
    compositionClosed = true;
    composition.close();
  };

  let server: Server | undefined;
  try {
    await composition.sweepOrphans();
    composition.recoverExpiredJobs();
    composition.recoverExpiredCleanupJobs();
    await composition.diagnostics.purgeExpired();
    const dependencies: Partial<AppDependencies> = {
      activity,
      config,
      indexingService: composition.indexingService,
      indexingJobs: composition.jobs,
      lifecycle: composition.lifecycle,
      questionService: composition.questionService,
    };
    server = await listen(applicationFactory(dependencies), config.PORT);
  } catch (error) {
    activity.abort();
    if (server) {
      server.closeAllConnections();
      await beginHttpClose(server);
    }
    closeComposition();
    throw error;
  }

  // Signal-handler registration happens immediately once `server` exists,
  // strictly *before* the "escucha en el puerto" log line below (or any
  // other observable side effect) — not merely as "the very next statement"
  // after that line. Signals are not preemptive: process.once() only
  // protects the process from the instant it is synchronously called, and
  // nothing guarantees a few-microsecond JS gap always wins a race against
  // an external process's kill() round-trip under real OS scheduling. The
  // only fully reliable fix is to make registration a *precondition* of the
  // observable trigger (the log line) an external watcher could react to,
  // rather than racing to register after producing it. workerTeardown/
  // workerLoop are declared here and assigned only after this block, once
  // the worker loop actually starts below — shutdown() guards both being
  // possibly still undefined in that residual gap.
  let workerTeardown: AbortController | undefined;
  let workerLoop: Promise<void> | undefined;
  let cleanupTeardown: AbortController | undefined;
  let cleanupLoop: Promise<void> | undefined;
  let purgeInterval: ReturnType<typeof setInterval> | undefined;

  let shutdownPromise: Promise<void> | undefined;
  let signalsRegistered = false;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      if (purgeInterval) clearInterval(purgeInterval);
      if (signalsRegistered) {
        process.off("SIGINT", signalHandler);
        process.off("SIGTERM", signalHandler);
        signalsRegistered = false;
      }
      activity.stopAccepting();
      const serverClosed = beginHttpClose(server);
      const idle = activity.waitForIdle();
      const drained = await settlesWithin(
        Promise.all([serverClosed, idle]),
        shutdownTimeoutMs,
      );
      if (!drained) {
        activity.abort();
        server.closeAllConnections();
        const abortedActivitySettled = await settlesWithin(
          Promise.all([serverClosed, activity.waitForIdle()]),
          abortGraceMs,
        );
        if (!abortedActivitySettled) {
          workerTeardown?.abort();
          cleanupTeardown?.abort();
          void Promise.all([
            serverClosed,
            activity.waitForIdle(),
            workerLoop ? settlesWithin(workerLoop, abortGraceMs) : true,
            cleanupLoop ? settlesWithin(cleanupLoop, abortGraceMs) : true,
          ]).then(() => {
            try {
              closeComposition();
            } catch {
              process.exitCode = 1;
            }
          });
          throw new ShutdownActivityTimeoutError();
        }
      }
      // Ask the worker to stop and, bounded by abortGraceMs, actually wait
      // for its loop to exit before touching the database — releasing
      // whatever job it currently holds at its next safe point (see
      // IndexingWorker.releaseIfStopping) rather than abandoning it for a
      // future recoverExpired() to reclaim after the full lease duration.
      // (workerTeardown/workerLoop may still be undefined if shutdown() is
      // somehow invoked in the residual gap before they are assigned below
      // — nothing to tear down or wait for in that case.)
      workerTeardown?.abort();
      cleanupTeardown?.abort();
      if (workerLoop) {
        await settlesWithin(workerLoop, abortGraceMs);
      }
      if (cleanupLoop) {
        await settlesWithin(cleanupLoop, abortGraceMs);
      }
      closeComposition();
    })();
    return shutdownPromise;
  };
  const signalHandler = () => {
    void shutdown().catch(() => {
      process.exitCode = 1;
    });
  };

  if (options.registerSignalHandlers ?? true) {
    process.once("SIGINT", signalHandler);
    process.once("SIGTERM", signalHandler);
    signalsRegistered = true;
  }

  console.log(`La API RAG de Connectia escucha en el puerto ${config.PORT}`);

  // The worker loop is not wrapped in activity.run(...): a fresh queued job
  // is always waiting to be leased at the top of every poll, so the loop
  // never settles on its own, and treating it as ordinary "active" work
  // would make activity.waitForIdle() block forever and force every
  // shutdown onto the abort-on-timeout path (breaking the drain-without-
  // aborting contract ordinary route work relies on). Instead the worker
  // reacts to the shared activity.signal for a forced/timed-out shutdown
  // (matching Task 6's abort budget), and to workerTeardown for the
  // ordinary graceful path, which always resolves once shutdown decides to
  // close the composition, so the loop never outlives the database.
  workerTeardown = new AbortController();
  const workerSignal = AbortSignal.any([
    activity.signal,
    workerTeardown.signal,
  ]);
  // Captured (not fire-and-forget) so shutdown() can wait for the loop to
  // actually exit before closing the database — see shutdown() above.
  workerLoop = composition.worker.start(workerSignal).catch(() => {
    console.error(
      "El trabajador de indexación se ha detenido de forma inesperada.",
    );
  });

  cleanupTeardown = new AbortController();
  const cleanupSignal = AbortSignal.any([
    activity.signal,
    cleanupTeardown.signal,
  ]);
  cleanupLoop = composition.cleanupWorker.start(cleanupSignal).catch(() => {
    console.error(
      "El trabajador de limpieza se ha detenido de forma inesperada.",
    );
  });

  purgeInterval = setInterval(() => {
    void composition.diagnostics.purgeExpired();
  }, 3_600_000).unref();

  return { server, composition, activity, shutdown };
}

if (
  isDirectExecution({
    importMetaMain: import.meta.main,
    moduleUrl: import.meta.url,
    argvEntry: process.argv[1],
  })
) {
  void startServer().catch(() => {
    console.error("No se ha podido iniciar la API RAG de Connectia.");
    process.exitCode = 1;
  });
}
