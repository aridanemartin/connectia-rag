import { describe, expect, it } from "vitest";
import { GenerationGate } from "../../src/rag/generation-gate.js";

function deferred<T>(): {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  promise: Promise<T>;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}

describe("GenerationGate", () => {
  it("runs an operation and returns its result", async () => {
    const gate = new GenerationGate({
      concurrency: 2,
      maxQueued: 2,
      timeoutMs: 1000,
    });

    const result = await gate.run(async () => "hello");

    expect(result).toBe("hello");
  });

  it("runs up to concurrency operations concurrently", async () => {
    const gate = new GenerationGate({
      concurrency: 2,
      maxQueued: 2,
      timeoutMs: 1000,
    });
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    const d3 = deferred<string>();

    const p1 = gate.run(() => d1.promise);
    const p2 = gate.run(() => d2.promise);
    const p3 = gate.run(() => d3.promise);

    // d1 and d2 are running; d3 is queued
    expect(gate.stats()).toMatchObject({ active: 2, queued: 1 });

    d1.resolve("a");
    await p1;

    // d2 still running; d3 now queued but not yet active (concurrency=2, one freed)
    expect(gate.stats()).toMatchObject({ active: 1, queued: 1 });

    d2.resolve("b");
    d3.resolve("c");
    await Promise.all([p2, p3]);

    expect(gate.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it("preserves FIFO ordering", async () => {
    const gate = new GenerationGate({
      concurrency: 1,
      maxQueued: 3,
      timeoutMs: 1000,
    });
    const order: string[] = [];
    const d1 = deferred<void>();
    const d2 = deferred<void>();
    const d3 = deferred<void>();

    const p1 = gate.run(async () => {
      await d1.promise;
      order.push("first");
    });
    const p2 = gate.run(async () => {
      await d2.promise;
      order.push("second");
    });
    const p3 = gate.run(async () => {
      await d3.promise;
      order.push("third");
    });

    d1.resolve();
    await p1;
    d2.resolve();
    await p2;
    d3.resolve();
    await p3;

    expect(order).toEqual(["first", "second", "third"]);
  });

  it("rejects with QUEUE_SATURATED when capacity is exceeded", async () => {
    const gate = new GenerationGate({
      concurrency: 2,
      maxQueued: 2,
      timeoutMs: 1000,
    });
    const blockers = Array.from({ length: 4 }, () =>
      gate.run(() => deferred<void>().promise),
    );

    await expect(gate.run(async () => "extra")).rejects.toMatchObject({
      code: "QUEUE_SATURATED",
    });
    expect(gate.stats()).toMatchObject({ active: 2, queued: 2 });

    // Clean up: release all blockers
    for (const blocker of blockers) {
      blocker.catch(() => undefined);
    }
  });

  it("returns correct capacity in stats", () => {
    const gate = new GenerationGate({
      concurrency: 3,
      maxQueued: 5,
      timeoutMs: 1000,
    });

    expect(gate.stats()).toMatchObject({
      active: 0,
      queued: 0,
      capacity: 8,
    });
  });

  it("decrements active count even when the operation throws", async () => {
    const gate = new GenerationGate({
      concurrency: 1,
      maxQueued: 1,
      timeoutMs: 1000,
    });

    await expect(
      gate.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(gate.stats()).toMatchObject({ active: 0, queued: 0 });
    // Should be able to run another operation
    const result = await gate.run(async () => "ok");
    expect(result).toBe("ok");
  });

  it("decrements active count even when the operation rejects with a non-Error", async () => {
    const gate = new GenerationGate({
      concurrency: 1,
      maxQueued: 1,
      timeoutMs: 1000,
    });

    await expect(
      gate.run(async () => {
        throw "string-error"; // eslint-disable-line no-throw-literal
      }),
    ).rejects.toBe("string-error");

    expect(gate.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it("times out a queued operation that waits too long", async () => {
    const gate = new GenerationGate({
      concurrency: 1,
      maxQueued: 2,
      timeoutMs: 50,
    });
    // Block the single slot
    const blocker = gate.run(() => deferred<void>().promise);

    // This will queue and wait; should time out
    await expect(gate.run(async () => "slow")).rejects.toMatchObject({
      code: "QUEUE_TIMEOUT",
    });

    expect(gate.stats()).toMatchObject({ active: 1 });

    // Clean up
    blocker.catch(() => undefined);
  });

  it("does not count timed-out zombies toward capacity", async () => {
    const gate = new GenerationGate({
      concurrency: 1,
      maxQueued: 1,
      timeoutMs: 50,
    });
    // Block the single slot with a controllable deferred
    const blockerDeferred = deferred<void>();
    const blocker = gate.run(() => blockerDeferred.promise);

    // Queue one — fills the queue
    const queued = gate.run(async () => "slow");

    // Wait for timeout
    try {
      await queued;
    } catch {
      // Expected: QUEUE_TIMEOUT
    }

    // After timeout, stats should show the zombie is excluded
    expect(gate.stats()).toMatchObject({ active: 1, queued: 0 });

    // Release the blocker so p-queue can process the zombie and free the slot
    blockerDeferred.resolve();
    await blocker;
    // Give p-queue a tick to dequeue the zombie and process it
    await new Promise((r) => setTimeout(r, 0));

    // The zombie should now be cleaned up
    expect(gate.stats()).toMatchObject({ active: 0, queued: 0 });

    // A new request should be accepted — its timeout is generous (5s) and
    // the operation completes immediately, so it won't time out.
    const result = await gate.run(async () => "legitimate");
    expect(result).toBe("legitimate");
  });

  it("rejects synchronously when at capacity (no async wait)", async () => {
    const gate = new GenerationGate({
      concurrency: 1,
      maxQueued: 0,
      timeoutMs: 1000,
    });
    // Fill the single slot
    const blocker = gate.run(() => deferred<void>().promise);

    // Next call should reject synchronously (within the same microtask)
    let synchronousReject = false;
    try {
      await gate.run(async () => "full");
    } catch (error) {
      synchronousReject =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "QUEUE_SATURATED";
    }
    expect(synchronousReject).toBe(true);

    blocker.catch(() => undefined);
  });

  it("allows new operations after queued ones complete", async () => {
    const gate = new GenerationGate({
      concurrency: 1,
      maxQueued: 1,
      timeoutMs: 5000,
    });
    const blockerDeferred = deferred<void>();
    const blocker = gate.run(() => blockerDeferred.promise);

    // One queued
    const queued = gate.run(async () => "queued");

    // At capacity now
    expect(gate.stats()).toMatchObject({ active: 1, queued: 1 });

    // Release the blocker so queued can run
    blockerDeferred.resolve();
    await Promise.all([blocker, queued]);

    // After queued completes, capacity is freed
    expect(gate.stats()).toMatchObject({ active: 0, queued: 0 });

    // Can run new operations
    const result = await gate.run(async () => "after");
    expect(result).toBe("after");
  });
});
