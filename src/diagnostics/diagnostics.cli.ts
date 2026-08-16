import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/env.js";
import { closeDatabase, openDatabase } from "../persistence/database.js";
import { migrate } from "../persistence/migrate.js";
import { DiagnosticsRepository } from "../persistence/repositories/diagnostics.repository.js";
import { systemClock } from "../shared/clock.js";
import { DiagnosticsService } from "./diagnostics.service.js";
import type { DiagnosticsCliIO } from "./diagnostics.types.js";

function defaultCliIO(): DiagnosticsCliIO {
  return {
    write: (line) => console.log(line),
    error: (line) => console.error(line),
  };
}

function parseLimit(argv: string[]): number {
  const limitIndex = argv.indexOf("--limit");
  if (limitIndex === -1 || limitIndex + 1 >= argv.length) {
    return 20;
  }
  const parsed = Number.parseInt(argv[limitIndex + 1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
}

export async function runDiagnosticsCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cliIo: DiagnosticsCliIO = defaultCliIO(),
): Promise<number> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(env);
  } catch {
    cliIo.error(
      "No se ha podido cargar la configuración. Asegúrate de que las variables de entorno están definidas.",
    );
    return 1;
  }

  if (!config.DIAGNOSTICS_ENABLED) {
    cliIo.error(
      "Los diagnósticos están deshabilitados. Establece DIAGNOSTICS_ENABLED=true.",
    );
    return 1;
  }

  const database = openDatabase(config.DATABASE_PATH);
  try {
    migrate(database);
    const repository = new DiagnosticsRepository(database, systemClock);
    const service = new DiagnosticsService({
      repository,
      enabled: true,
      ttlHours: config.DIAGNOSTICS_TTL_HOURS,
      clock: systemClock,
    });

    const command = argv[0];
    switch (command) {
      case "list": {
        const limit = parseLimit(argv);
        const entries = await service.listRecent(limit);
        for (const entry of entries) {
          cliIo.write(JSON.stringify(entry));
        }
        return 0;
      }
      case "purge": {
        const deleted = await service.purgeExpired();
        cliIo.write(String(deleted));
        return 0;
      }
      default:
        cliIo.error("Uso: diagnostics list [--limit N] | purge");
        return 2;
    }
  } finally {
    closeDatabase(database);
  }
}

if (
  import.meta.main &&
  fileURLToPath(import.meta.url) === fileURLToPath(process.argv[1])
) {
  void runDiagnosticsCli(process.argv.slice(2), process.env).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
