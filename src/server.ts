import type { Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type AppDependencies, createApp } from "./api/app.js";
import { type AppConfig, loadConfig } from "./config/env.js";
import {
  createIndexingComposition,
  type IndexingComposition,
} from "./documents/indexing.service.js";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

type CompositionFactory = (config: AppConfig) => IndexingComposition;
type ApplicationFactory = (
  dependencies: Partial<AppDependencies>,
) => ReturnType<typeof createApp>;

export interface StartServerOptions {
  config?: AppConfig;
  createComposition?: CompositionFactory;
  createApplication?: ApplicationFactory;
  registerSignalHandlers?: boolean;
  shutdownTimeoutMs?: number;
}

export interface RunningServer {
  server: Server;
  composition: IndexingComposition;
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

function closeHttpServer(server: Server, timeoutMs: number): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolveClosed) => {
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolveClosed();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, timeoutMs);
    timer.unref();
    server.close(finish);
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
      config,
      indexingService: composition.indexingService,
    };
    server = await listen(applicationFactory(dependencies), config.PORT);
  } catch (error) {
    if (server) {
      await closeHttpServer(server, shutdownTimeoutMs);
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
      try {
        await closeHttpServer(server, shutdownTimeoutMs);
      } finally {
        closeComposition();
      }
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

  return { server, composition, shutdown };
}

function isMainModule(): boolean {
  const mainPath = process.argv[1];
  return (
    typeof mainPath === "string" &&
    import.meta.url === pathToFileURL(resolve(mainPath)).href
  );
}

if (isMainModule()) {
  void startServer().catch(() => {
    console.error("No se ha podido iniciar la API RAG de Connectia.");
    process.exitCode = 1;
  });
}
