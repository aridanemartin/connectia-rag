import { Router } from "express";
import type { Readiness } from "../../health/readiness.service.js";

export function createHealthRouter(readiness: Readiness): Router {
  const router = Router();

  router.get("/live", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  router.get("/ready", async (_request, response) => {
    const result = await readiness.check();
    response.status(result.status === "ready" ? 200 : 503).json(result);
  });

  return router;
}
