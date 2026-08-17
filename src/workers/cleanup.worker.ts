import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import type { CleanupJob } from "../persistence/persistence.types.js";
import { isTransientDependencyError } from "./indexing.worker.js";
import type { CleanupWorkerDependencies } from "./workers.types.js";

export type {
  CleanupJobLeaseRepository,
  CleanupVectorStore,
  CleanupWorkerDependencies,
} from "./workers.types.js";

export const CLEANUP_RETRY_DELAYS_MS = [250, 500, 1000] as const;

/**
 * Background loop that leases queued vector-cleanup jobs, deletes the
 * corresponding vectors with bounded retries, and completes or requeues the
 * job. Key methods: runOnce(), start(signal).
 */
export class CleanupWorker {
  private signal: AbortSignal = new AbortController().signal;

  constructor(private readonly deps: CleanupWorkerDependencies) {}

  async runOnce(): Promise<"processed" | "idle"> {
    const job = this.deps.jobs.leaseNext(this.deps.owner, this.deps.leaseMs);
    if (!job) {
      return "idle";
    }

    try {
      await this.process(job);
    } catch {
      // Defensive: infrastructure errors back off instead of crashing the loop.
    }
    return "processed";
  }

  async start(signal: AbortSignal): Promise<void> {
    this.signal = signal;
    while (!signal.aborted) {
      let outcome: "processed" | "idle";
      try {
        outcome = await this.runOnce();
      } catch {
        outcome = "idle";
      }
      if (signal.aborted) {
        return;
      }
      if (outcome === "idle") {
        await this.abortAwareSleep(this.deps.pollIntervalMs, signal);
      }
    }
  }

  private async process(job: CleanupJob): Promise<void> {
    // Delete vectors first; complete() is called separately so a LeaseLostError
    // from complete() (lease expired during the Qdrant call) is not misclassified
    // as a vector-deletion failure.
    try {
      await this.withRetry(
        () => this.deps.vectorStore.deleteVersion(job.versionId),
        isTransientDependencyError,
      );
    } catch (error) {
      const { code, message, delayMs } = this.classifyCleanupError(error);
      try {
        this.deps.jobs.retry(job.id, this.deps.owner, code, message, delayMs);
      } catch {
        // LeaseLostError: another owner already reclaimed this job.
      }
      return;
    }
    // Vectors deleted. complete() is best-effort: if the lease was lost,
    // recoverExpired() will reclaim the job and the next attempt will
    // re-delete (idempotent) and complete successfully.
    try {
      this.deps.jobs.complete(job.id, this.deps.owner);
    } catch {
      // LeaseLostError or other: another owner reclaimed the job, or the
      // lease expired. The vectors are already deleted (idempotent), so
      // a future recoverExpired() will re-attempt and complete.
    }
  }

  private classifyCleanupError(error: unknown): {
    code: string;
    message: string;
    delayMs: number;
  } {
    if (isTransientDependencyError(error)) {
      return {
        code: "VECTOR_CLEANUP_RETRYABLE",
        message: "No se han podido eliminar los vectores. Reintentando.",
        delayMs: CLEANUP_RETRY_DELAYS_MS[0],
      };
    }
    return {
      code: "VECTOR_CLEANUP_FAILED",
      message: "No se han podido eliminar los vectores.",
      delayMs: 0,
    };
  }

  private async withRetry<T>(
    operation: () => Promise<T>,
    isTransient: (error: unknown) => boolean,
  ): Promise<T> {
    let lastError: unknown;
    for (
      let attempt = 0;
      attempt <= CLEANUP_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!isTransient(error) || attempt === CLEANUP_RETRY_DELAYS_MS.length) {
          throw error;
        }
        await this.sleep(CLEANUP_RETRY_DELAYS_MS[attempt] ?? 0);
      }
    }
    throw lastError;
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : setTimeoutPromise(ms);
  }

  private async abortAwareSleep(
    ms: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await setTimeoutPromise(ms, undefined, { signal });
    } catch {
      // Resolve immediately on early cancellation instead of throwing.
    }
  }
}
