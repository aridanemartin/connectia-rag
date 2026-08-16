import type {
  DiagnosticEntry,
  DiagnosticsRepository,
} from "../persistence/repositories/diagnostics.repository.js";
import type { Clock } from "../shared/clock.js";

export interface DiagnosticRecordInput {
  requestId: string;
  question: string;
  answer: string | null;
  retrievedChunkIds: string[];
}

export interface DiagnosticsServiceOptions {
  repository: DiagnosticsRepository;
  enabled: boolean;
  ttlHours: number;
  clock: Clock;
}

export interface DiagnosticsCliIO {
  write(line: string): void;
  error(line: string): void;
}

export type { DiagnosticEntry };
