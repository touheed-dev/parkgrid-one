import { AppError } from "../lib/errors.js";

interface PgLikeError {
  code?: string;
  message?: string;
  constraint?: string;
}

/**
 * Translate PostgreSQL errors into clean API errors.
 *  23505 unique -> 409   23503 FK -> 409   23P01 exclusion -> 409 SLOT_TAKEN
 *  23514 check  -> 400   P0001 (raise exception in our triggers/functions) -> 400 with its message
 */
export function mapPgError(err: unknown): AppError | null {
  const e = err as PgLikeError;
  if (!e || typeof e.code !== "string") return null;
  switch (e.code) {
    case "23P01":
      return new AppError("SLOT_TAKEN", 409, "This slot was just taken for that time");
    case "23505":
      return new AppError("DUPLICATE", 409, "A record with these details already exists", {
        constraint: e.constraint,
      });
    case "23503":
      return new AppError("REFERENCE_ERROR", 409, "Operation conflicts with related records");
    case "23514":
    case "22P02":
    case "22003":
      return new AppError("INVALID_DATA", 400, "Invalid data supplied");
    case "P0001":
      return new AppError("RULE_VIOLATION", 400, e.message ?? "Request violates a rule");
    case "P0002":
      return new AppError("NOT_FOUND", 404, e.message ?? "Not found");
    case "42501":
      return new AppError("FORBIDDEN", 403, e.message ?? "Access denied");
    case "57014":
      return new AppError("TIMEOUT", 503, "The database took too long to answer");
    default:
      return null;
  }
}
