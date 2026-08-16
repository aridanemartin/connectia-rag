import type { RequestHandler } from "express";
import { Router } from "express";
import type { RuntimeSnapshot } from "../../diagnostics/runtime-metrics.js";

export interface InternalMetricsDependencies {
  collectMetrics: () => Promise<RuntimeSnapshot>;
}

/**
 * Create a router for GET /internal/metrics.
 *
 * This route is ONLY mounted when ENABLE_INTERNAL_METRICS=true.
 * It returns a JSON snapshot of current runtime health metrics.
 */
export function createInternalMetricsRouter(
  deps: InternalMetricsDependencies,
): Router {
  const router = Router();

  const handler: RequestHandler = async (_request, response, next) => {
    try {
      const metrics = await deps.collectMetrics();
      response.status(200).json(metrics);
    } catch (error) {
      next(error);
    }
  };

  router.get("/metrics", handler);

  return router;
}