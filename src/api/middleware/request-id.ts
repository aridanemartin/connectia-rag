import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

declare module "express-serve-static-core" {
  interface Request {
    requestId: string;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const requestId: RequestHandler = (request, response, next) => {
  const suppliedRequestId = request.get("X-Request-Id");
  request.requestId =
    suppliedRequestId && UUID_PATTERN.test(suppliedRequestId)
      ? suppliedRequestId
      : randomUUID();
  response.setHeader("X-Request-Id", request.requestId);
  next();
};
