/**
 * Runtime metrics collector for the Connectia RAG API.
 *
 * Collects process-level metrics:
 * - Heap used / total (MB)
 * - Event loop lag (ms) — sampled periodically
 * - Active handles (approximation via process._getActiveHandles)
 * - Memory usage (rss)
 *
 * These are exposed via the internal metrics endpoint guarded by
 * ENABLE_INTERNAL_METRICS=true.
 */

import { performance } from "node:perf_hooks";

export interface RuntimeSnapshot {
  /** ISO timestamp of the snapshot */
  timestamp: string;
  /** Heap used in MB */
  heapUsedMb: number;
  /** Heap total in MB */
  heapTotalMb: number;
  /** RSS in MB */
  rssMb: number;
  /** Number of active handles */
  activeHandles: number;
  /** Sampled event loop lag in ms */
  eventLoopLagMs: number;
  /** Uptime in seconds */
  uptimeSeconds: number;
}

let lastLagMeasurement = 0;

/**
 * Measure event loop lag by recording the time delta between
 * consecutive setImmediate calls.
 */
function measureLag(): Promise<number> {
  return new Promise<number>((resolve) => {
    const before = performance.now();
    setImmediate(() => {
      const after = performance.now();
      lastLagMeasurement = after - before;
      resolve(lastLagMeasurement);
    });
  });
}

/**
 * Collect a snapshot of current runtime metrics.
 */
export async function collectRuntimeMetrics(): Promise<RuntimeSnapshot> {
  const mem = process.memoryUsage();
  const lag = await measureLag();

  let activeHandles = 0;
  try {
    // process._getActiveHandles() returns an array; it's available in Node.js
    // but is an undocumented internal.
    const handles = (
      process as NodeJS.EventEmitter & { _getActiveHandles?(): unknown[] }
    )._getActiveHandles?.();
    if (handles) {
      activeHandles = handles.length;
    }
  } catch {
    activeHandles = -1;
  }

  return {
    timestamp: new Date().toISOString(),
    heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
    heapTotalMb: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
    rssMb: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
    activeHandles,
    eventLoopLagMs: Math.round(lag * 100) / 100,
    uptimeSeconds: Math.round(process.uptime() * 100) / 100,
  };
}
