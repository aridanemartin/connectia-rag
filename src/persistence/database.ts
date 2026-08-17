import Database from "better-sqlite3";
import type { DatabaseConnection } from "./persistence.types.js";

export type { DatabaseConnection } from "./persistence.types.js";

export function openDatabase(path: string): DatabaseConnection {
  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  return database;
}

export function closeDatabase(database: DatabaseConnection): void {
  database.close();
}
