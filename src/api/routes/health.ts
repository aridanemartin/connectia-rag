import { Router } from "express";

export function createHealthRouter(): Router {
  const router = Router();

  router.get("/live", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  return router;
}
