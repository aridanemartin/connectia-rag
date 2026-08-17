import type { ErrorRequestHandler } from "express";
import type { BodyParserError } from "../api.types.js";
import { AppError } from "../errors.js";

export type { BodyParserError } from "../api.types.js";

function mapBodyParserError(error: BodyParserError): AppError | undefined {
  if (error.type === "entity.parse.failed") {
    return new AppError(
      400,
      "BODY_INVALID",
      "El cuerpo de la solicitud no es válido.",
    );
  }
  if (error.type === "entity.too.large") {
    return new AppError(
      413,
      "BODY_TOO_LARGE",
      "El cuerpo de la solicitud es demasiado grande.",
    );
  }
  if (error.status === 400 || error.status === 413) {
    return new AppError(
      error.status,
      error.status === 400 ? "BODY_INVALID" : "BODY_TOO_LARGE",
      error.status === 400
        ? "El cuerpo de la solicitud no es válido."
        : "El cuerpo de la solicitud es demasiado grande.",
    );
  }
  return undefined;
}

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  request,
  response,
  _next,
) => {
  const safeError =
    error instanceof AppError
      ? error
      : (mapBodyParserError(error as BodyParserError) ??
        new AppError(500, "INTERNAL_ERROR", "Ha ocurrido un error interno."));
  const body = {
    code: safeError.code,
    message: safeError.message,
    requestId: request.requestId,
    ...(safeError.details === undefined ? {} : { details: safeError.details }),
  };

  response.status(safeError.status).json({ error: body });
};
