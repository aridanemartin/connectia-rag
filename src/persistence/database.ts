import Database from "better-sqlite3";

export type DatabaseConnection = Database.Database;

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
