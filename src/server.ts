import type { Server } from "node:http";
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
    const dependencies: Partial<AppDependencies> = {
      activity,
      config,
      indexingService: composition.indexingService,
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

  console.log(`La API RAG de Connectia escucha en el puerto ${config.PORT}`);

  let shutdownPromise: Promise<void> | undefined;
  let signalsRegistered = false;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
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
          void Promise.all([serverClosed, activity.waitForIdle()]).then(() => {
            try {
              closeComposition();
            } catch {
              process.exitCode = 1;
            }
          });
          throw new ShutdownActivityTimeoutError();
        }
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

  return { server, composition, activity, shutdown };
}

if (import.meta.main) {
  void startServer().catch(() => {
    console.error("No se ha podido iniciar la API RAG de Connectia.");
    process.exitCode = 1;
  });
}
