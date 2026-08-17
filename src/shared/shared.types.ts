export interface Clock {
  now(): Date;
}

export interface DiagnosticsRecorder {
  record(entry: {
    requestId: string;
    question: string;
    answer: string | null;
    retrievedChunkIds: string[];
  }): Promise<void>;
}
