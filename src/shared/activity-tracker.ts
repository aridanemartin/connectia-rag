/**
 * Thrown when new activity is registered after the tracker has stopped
 * accepting work (e.g. during shutdown).
 */
export class ActivityNotAcceptedError extends Error {
  constructor() {
    super("Application activity is no longer accepted");
    this.name = "ActivityNotAcceptedError";
  }
}

/**
 * Tracks in-flight application activity so graceful shutdown can drain work
 * before closing dependencies. Exposes a shared abort signal and lets callers
 * begin/end work or run operations until idle.
 */
export class ActivityTracker {
  private readonly controller = new AbortController();
  private readonly idleWaiters = new Set<() => void>();
  private accepting = true;
  private active = 0;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get activeCount(): number {
    return this.active;
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  abort(): void {
    this.stopAccepting();
    this.controller.abort();
  }

  begin(): () => void {
    if (!this.accepting) {
      throw new ActivityNotAcceptedError();
    }
    this.active += 1;
    let finished = false;
    return () => {
      if (finished) {
        return;
      }
      finished = true;
      this.active -= 1;
      if (this.active === 0) {
        for (const resolveIdle of this.idleWaiters) {
          resolveIdle();
        }
        this.idleWaiters.clear();
      }
    };
  }

  async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const finish = this.begin();
    try {
      return await operation(this.signal);
    } finally {
      finish();
    }
  }

  waitForIdle(): Promise<void> {
    if (this.active === 0) {
      return Promise.resolve();
    }
    return new Promise((resolveIdle) => {
      this.idleWaiters.add(resolveIdle);
    });
  }
}
