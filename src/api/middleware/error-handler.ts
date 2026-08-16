import type { ErrorRequestHandler } from "express";
import { AppError } from "../errors.js";

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  request,
  response,
  _next,
) => {
  const safeError =
    error instanceof AppError
      ? error
      : new AppError(500, "INTERNAL_ERROR", "Ha ocurrido un error interno.");
  const body = {
    code: safeError.code,
    message: safeError.message,
    requestId: request.requestId,
    ...(safeError.details === undefined ? {} : { details: safeError.details }),
  };

  response.status(safeError.status).json({ error: body });
};
