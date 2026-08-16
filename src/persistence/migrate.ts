import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock } from "../shared/clock.js";
import { systemClock } from "../shared/clock.js";
import type { DatabaseConnection } from "./database.js";

export interface Migration {
  id: string;
  sql: string;
}

interface AppliedMigrationRow {
  checksum: string;
}

function defaultMigrations(): Migration[] {
  const besideModule = fileURLToPath(
    new URL("./migrations/001_initial.sql", import.meta.url),
  );
  const path = existsSync(besideModule)
    ? besideModule
    : resolve("src/persistence/migrations/001_initial.sql");
  return [{ id: "001_initial", sql: readFileSync(path, "utf8") }];
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export function migrate(
  database: DatabaseConnection,
  migrations: readonly Migration[] = defaultMigrations(),
  clock: Clock = systemClock,
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const findApplied = database.prepare<[string], AppliedMigrationRow>(
    "SELECT checksum FROM schema_migrations WHERE id = ?",
  );
  const recordApplied = database.prepare(
    "INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)",
  );
  const applyMigration = database.transaction(
    (migration: Migration, migrationChecksum: string) => {
      database.exec(migration.sql);
      recordApplied.run(
        migration.id,
        migrationChecksum,
        clock.now().toISOString(),
      );
    },
  );

  for (const migration of migrations) {
    const migrationChecksum = checksum(migration.sql);
    const applied = findApplied.get(migration.id);
    if (applied) {
      if (applied.checksum !== migrationChecksum) {
        throw new Error(
          `Migration ${migration.id} checksum does not match the applied migration`,
        );
      }
      continue;
    }
    applyMigration(migration, migrationChecksum);
  }
}
