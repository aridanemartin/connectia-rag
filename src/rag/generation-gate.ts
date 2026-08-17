import PQueue from "p-queue";
import type { GenerationGateConfig, GenerationGateStats } from "./rag.types.js";

export type { GenerationGateConfig, GenerationGateStats } from "./rag.types.js";

/**
 * Concurrency limiter for model generation: bounds active operations and
 * queue depth, rejects when saturated, and times out operations that wait
 * too long for a slot. Key methods: run(operation), stats().
 */
export class GenerationGate {
  private readonly queue: PQueue;
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly timeoutMs: number;
  private active = 0;
  private zombies = 0;

  constructor(config: GenerationGateConfig) {
    if (config.concurrency < 1) {
      throw new Error("concurrency must be >= 1");
    }
    if (config.maxQueued < 0) {
      throw new Error("maxQueued must be >= 0");
    }
    if (config.timeoutMs < 1) {
      throw new Error("timeoutMs must be >= 1");
    }
    this.concurrency = config.concurrency;
    this.maxQueued = config.maxQueued;
    this.timeoutMs = config.timeoutMs;
    this.queue = new PQueue({ concurrency: config.concurrency });
  }

  stats(): GenerationGateStats {
    return {
      active: this.active,
      queued: this.queue.size - this.zombies,
      capacity: this.concurrency + this.maxQueued,
    };
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (
      this.active + this.queue.size - this.zombies >=
      this.concurrency + this.maxQueued
    ) {
      return Promise.reject(
        Object.assign(new Error("Generation queue is saturated"), {
          code: "QUEUE_SATURATED",
          retryAfterSeconds: 1,
        }),
      );
    }

    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    return new Promise<T>((resolve, reject) => {
      // Start the wait timeout — this fires if the operation doesn't begin
      // within timeoutMs. Once the operation starts, we clear the timeout.
      timeoutId = setTimeout(() => {
        timedOut = true;
        this.zombies += 1;
        reject(
          Object.assign(new Error("Generation queue timeout"), {
            code: "QUEUE_TIMEOUT",
          }),
        );
      }, this.timeoutMs);

      // p-queue rejects when paused/draining. The callback never runs, so
      // the outer promise will settle via the timeout.
      void this.queue
        .add(async () => {
          // Operation is now running — cancel the wait timeout.
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
            timeoutId = undefined;
          }
          if (timedOut) {
            // Timeout already fired before we got the slot; clean up the
            // zombie count and do nothing.
            this.zombies -= 1;
            return;
          }
          this.active += 1;
          try {
            const result = await operation();
            resolve(result);
          } catch (error) {
            reject(error);
          } finally {
            this.active -= 1;
          }
        })
        .catch(() => undefined);
    });
  }
}
