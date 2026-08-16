import type { DiagnosticEntry } from "../persistence/repositories/diagnostics.repository.js";

export interface DiagnosticRecordInput {
  requestId: string;
  question: string;
  answer: string | null;
  retrievedChunkIds: string[];
}

export type { DiagnosticEntry };
