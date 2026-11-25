import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { mapPgError } from "../db/errors.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound("Route not found", "ROUTE_NOT_FOUND"));
}

/** Single place that turns any thrown value into `{ error: { code, message, details? } }`. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  let appErr: AppError | null;

  if (err instanceof AppError) {
    appErr = err;
  } else {
    appErr = mapPgError(err);
    const e = err as { type?: string; status?: number };
    if (!appErr && e?.type === "entity.parse.failed") {
      appErr = AppError.badRequest("Malformed JSON body", "INVALID_JSON");
    } else if (!appErr && e?.type === "entity.too.large") {
      appErr = new AppError("PAYLOAD_TOO_LARGE", 413, "Request body is too large");
    }
  }

  if (!appErr) {
    // Unknown failure: log full detail server-side, hide it from the client.
    logger.error({ err, path: req.path, method: req.method }, "unhandled error");
    appErr = new AppError(
      "INTERNAL_ERROR",
      500,
      "Something went wrong. Please try again.",
      env.NODE_ENV === "production" ? undefined : { cause: (err as Error)?.message },
    );
  } else if (appErr.httpStatus >= 500) {
    logger.error({ err, path: req.path }, "server error");
  }

  if (res.headersSent) return;
  res.status(appErr.httpStatus).json({
    error: {
      code: appErr.code,
      message: appErr.message,
      ...(appErr.details !== undefined ? { details: appErr.details } : {}),
    },
  });
}
