import { randomUUID } from "node:crypto";
import type { DiagnosticsRepository } from "../persistence/repositories/diagnostics.repository.js";
import type { Clock } from "../shared/clock.js";
import type {
  DiagnosticEntry,
  DiagnosticRecordInput,
} from "./diagnostics.types.js";

export interface DiagnosticsServiceOptions {
  repository: DiagnosticsRepository;
  enabled: boolean;
  ttlHours: number;
  clock: Clock;
}

export class DiagnosticsService {
  private readonly repository: DiagnosticsRepository;
  private readonly enabled: boolean;
  private readonly ttlMs: number;
  private readonly clock: Clock;

  constructor(options: DiagnosticsServiceOptions) {
    this.repository = options.repository;
    this.enabled = options.enabled;
    this.ttlMs = options.ttlHours * 3_600_000;
    this.clock = options.clock;
  }

  async record(entry: DiagnosticRecordInput): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    this.repository.insert({
      id: randomUUID(),
      requestId: entry.requestId,
      question: entry.question,
      answer: entry.answer,
      retrievedChunkIds: entry.retrievedChunkIds,
      expiresAt,
    });
  }

  async purgeExpired(): Promise<number> {
    return this.repository.purgeExpired();
  }

  async listRecent(limit: number): Promise<DiagnosticEntry[]> {
    return this.repository.listRecent(limit);
  }
}
