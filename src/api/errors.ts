/**
 * Base application error carrying an HTTP status and a stable error code,
 * used across the API to produce consistent error responses.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown[],
  ) {
    super(message);
    this.name = "AppError";
  }
}
