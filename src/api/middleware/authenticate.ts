import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { AppConfig } from "../../config/env.js";
import { AppError } from "../errors.js";

const BEARER_PATTERN = /^Bearer (\S+)$/i;

export function authenticate(config: AppConfig): RequestHandler {
  const expectedToken = Buffer.from(config.AUTH_TOKEN, "utf8");

  return (request, _response, next) => {
    const authorization = request.get("Authorization");
    const suppliedToken = authorization?.match(BEARER_PATTERN)?.[1];
    const suppliedBuffer = Buffer.from(suppliedToken ?? "", "utf8");
    const authenticated =
      suppliedBuffer.length === expectedToken.length &&
      timingSafeEqual(suppliedBuffer, expectedToken);

    if (!authenticated) {
      next(new AppError(401, "UNAUTHORIZED", "No autorizado."));
      return;
    }

    next();
  };
}
