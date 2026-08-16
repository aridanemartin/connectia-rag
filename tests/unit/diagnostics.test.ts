import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDiagnosticsCli } from "../../src/diagnostics/diagnostics.cli.js";
import { DiagnosticsService } from "../../src/diagnostics/diagnostics.service.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { migrate } from "../../src/persistence/migrate.js";
import { DiagnosticsRepository } from "../../src/persistence/repositories/diagnostics.repository.js";
import type { Clock } from "../../src/shared/clock.js";

class MutableClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

const AUTH_TOKEN = "test-auth-token-with-at-least-32-characters";

function createTestDatabase() {
  const database = openDatabase(":memory:");
  migrate(database);
  return database;
}

function makeEntry() {
  return {
    requestId: randomUUID(),
    question: "¿Cuál es el plazo de matrícula?",
    answer: null,
    retrievedChunkIds: ["chunk-1", "chunk-2"],
  };
}

const databaseDirectories: string[] = [];

afterEach(() => {
  for (const directory of databaseDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("DiagnosticsService", () => {
  it("stores nothing while diagnostics are disabled", async () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const repository = new DiagnosticsRepository(database, clock);
    const service = new DiagnosticsService({
      repository,
      enabled: false,
      ttlHours: 24,
      clock,
    });

    await service.record(makeEntry());

    expect(repository.count()).toBe(0);

    closeDatabase(database);
  });

  it("stores a diagnostic entry when diagnostics are enabled", async () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const repository = new DiagnosticsRepository(database, clock);
    const service = new DiagnosticsService({
      repository,
      enabled: true,
      ttlHours: 24,
      clock,
    });
    const entry = makeEntry();

    await service.record(entry);

    expect(repository.count()).toBe(1);
    const stored = repository.listRecent(10);
    expect(stored[0].question).toBe(entry.question);
    expect(stored[0].requestId).toBe(entry.requestId);
    expect(stored[0].answer).toBeNull();
    expect(stored[0].retrievedChunkIds).toEqual(["chunk-1", "chunk-2"]);
    expect(stored[0].expiresAt).toBe("2026-08-17T10:00:00.000Z");

    closeDatabase(database);
  });

  it("purges content exactly after the configured 24-hour TTL", async () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const repository = new DiagnosticsRepository(database, clock);
    const service = new DiagnosticsService({
      repository,
      enabled: true,
      ttlHours: 24,
      clock,
    });

    await service.record(makeEntry());
    clock.advance(24 * 60 * 60 * 1000 - 1);
    expect(await service.purgeExpired()).toBe(0);
    clock.advance(1);
    expect(await service.purgeExpired()).toBe(1);

    closeDatabase(database);
  });

  it("caps listRecent at 100 entries", async () => {
    const database = createTestDatabase();
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const repository = new DiagnosticsRepository(database, clock);
    const service = new DiagnosticsService({
      repository,
      enabled: true,
      ttlHours: 24,
      clock,
    });

    for (let i = 0; i < 101; i++) {
      await service.record(makeEntry());
    }

    const entries = await service.listRecent(1000);
    expect(entries).toHaveLength(100);

    closeDatabase(database);
  });
});

describe("CLI", () => {
  it("refuses to run when diagnostics are disabled", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const io = {
      write: (line: string) => output.push(line),
      error: (line: string) => errors.push(line),
    };

    const exitCode = await runDiagnosticsCli(
      ["list"],
      { AUTH_TOKEN, DIAGNOSTICS_ENABLED: "false", DATABASE_PATH: ":memory:" },
      io,
    );

    expect(exitCode).toBe(1);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("deshabilitados"))).toBe(true);
  });

  it("lists up to 100 entries with the list command", async () => {
    const directory = mkdtempSync(join(tmpdir(), "connectia-diagnostics-"));
    databaseDirectories.push(directory);
    const databasePath = join(directory, "diagnostics.sqlite");
    const database = openDatabase(databasePath);
    migrate(database);
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const repository = new DiagnosticsRepository(database, clock);
    for (let i = 0; i < 101; i++) {
      repository.insert({
        id: randomUUID(),
        requestId: randomUUID(),
        question: `Pregunta ${i}`,
        answer: null,
        retrievedChunkIds: [],
        expiresAt: new Date(clock.now().getTime() + 86_400_000),
      });
    }
    closeDatabase(database);

    const output: string[] = [];
    const io = {
      write: (line: string) => output.push(line),
      error: () => {},
    };

    const exitCode = await runDiagnosticsCli(
      ["list", "--limit", "500"],
      {
        AUTH_TOKEN,
        DIAGNOSTICS_ENABLED: "true",
        DATABASE_PATH: databasePath,
        DIAGNOSTICS_TTL_HOURS: "24",
      },
      io,
    );

    expect(exitCode).toBe(0);
    expect(output).toHaveLength(100);
  });

  it("purges expired entries and prints the deleted count", async () => {
    const directory = mkdtempSync(join(tmpdir(), "connectia-diagnostics-"));
    databaseDirectories.push(directory);
    const databasePath = join(directory, "purge-diag.sqlite");
    const database = openDatabase(databasePath);
    migrate(database);
    const clock = new MutableClock(new Date("2026-08-16T10:00:00.000Z"));
    const repository = new DiagnosticsRepository(database, clock);
    repository.insert({
      id: randomUUID(),
      requestId: randomUUID(),
      question: "Expired",
      answer: null,
      retrievedChunkIds: [],
      expiresAt: "2026-08-15T10:00:00.000Z",
    });
    closeDatabase(database);

    const output: string[] = [];
    const io = {
      write: (line: string) => output.push(line),
      error: () => {},
    };

    const exitCode = await runDiagnosticsCli(
      ["purge"],
      {
        AUTH_TOKEN,
        DIAGNOSTICS_ENABLED: "true",
        DATABASE_PATH: databasePath,
        DIAGNOSTICS_TTL_HOURS: "24",
      },
      io,
    );

    expect(exitCode).toBe(0);
    expect(output).toContain("1");
  });
});
