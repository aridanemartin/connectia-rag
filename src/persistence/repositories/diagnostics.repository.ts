import type { Clock } from "../../shared/shared.types.js";
import type {
  DatabaseConnection,
  DiagnosticEntry,
  DiagnosticInput,
  DiagnosticRow,
} from "../persistence.types.js";

export type {
  DiagnosticEntry,
  DiagnosticInput,
  DiagnosticRow,
} from "../persistence.types.js";

function toDiagnosticEntry(row: DiagnosticRow): DiagnosticEntry {
  const chunkIds: unknown = JSON.parse(row.retrieved_chunk_ids);
  if (
    !Array.isArray(chunkIds) ||
    !chunkIds.every((id) => typeof id === "string")
  ) {
    throw new Error(`Diagnostic ${row.id} contains invalid chunk identifiers`);
  }
  return {
    id: row.id,
    requestId: row.request_id,
    question: row.question,
    answer: row.answer,
    retrievedChunkIds: chunkIds,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function toIsoString(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("Diagnostic expiry must be a valid date");
  }
  return date.toISOString();
}

/**
 * Sqlite repository for diagnostics entries: inserts, queries by id, lists
 * recent entries, counts, and purges expired records. Key methods: insert,
 * find, listRecent, count, purgeExpired.
 */
export class DiagnosticsRepository {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly clock: Clock,
  ) {}

  insert(input: DiagnosticInput): DiagnosticEntry {
    const createdAt = this.clock.now().toISOString();
    const expiresAt = toIsoString(input.expiresAt);
    this.database
      .prepare(
        `
          INSERT INTO diagnostics (
            id, request_id, question, answer, retrieved_chunk_ids,
            expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.id,
        input.requestId,
        input.question,
        input.answer,
        JSON.stringify(input.retrievedChunkIds),
        expiresAt,
        createdAt,
      );
    return this.find(input.id) as DiagnosticEntry;
  }

  find(id: string): DiagnosticEntry | undefined {
    const row = this.database
      .prepare<[string], DiagnosticRow>(
        "SELECT * FROM diagnostics WHERE id = ?",
      )
      .get(id);
    return row ? toDiagnosticEntry(row) : undefined;
  }

  listRecent(limit: number): DiagnosticEntry[] {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("Diagnostic list limit must be a positive integer");
    }
    return this.database
      .prepare<[number], DiagnosticRow>(
        "SELECT * FROM diagnostics ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(Math.min(limit, 100))
      .map(toDiagnosticEntry);
  }

  count(): number {
    const row = this.database
      .prepare<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM diagnostics",
      )
      .get();
    return row?.count ?? 0;
  }

  purgeExpired(): number {
    return this.database
      .prepare("DELETE FROM diagnostics WHERE expires_at <= ?")
      .run(this.clock.now().toISOString()).changes;
  }
}
