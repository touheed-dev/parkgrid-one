/** One error type for the whole API: stable `code`, HTTP status, human message. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  static badRequest(message: string, code = "BAD_REQUEST", details?: unknown) {
    return new AppError(code, 400, message, details);
  }
  static unauthorized(message = "Authentication required", code = "UNAUTHORIZED") {
    return new AppError(code, 401, message);
  }
  static forbidden(message = "Access denied", code = "FORBIDDEN") {
    return new AppError(code, 403, message);
  }
  /** Used for "not yours" too, so existence of other users' resources is never leaked. */
  static notFound(message = "Not found", code = "NOT_FOUND") {
    return new AppError(code, 404, message);
  }
  static conflict(message: string, code = "CONFLICT") {
    return new AppError(code, 409, message);
  }
  static unprocessable(message: string, code = "UNPROCESSABLE") {
    return new AppError(code, 422, message);
  }
  static tooMany(message = "Too many requests. Please try again later.") {
    return new AppError("RATE_LIMITED", 429, message);
  }
}
