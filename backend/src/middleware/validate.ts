import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";
import { AppError } from "../lib/errors.js";

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Zod validation for body / query / params. Parsed values replace the originals, so handlers only
 * ever see validated data. Use `.strict()` on body schemas to reject unknown fields
 * (mass-assignment: clients must never be able to set status, price, role, user_id, paid...).
 */
export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    for (const part of ["params", "query", "body"] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(part === "body" ? (req.body ?? {}) : req[part]);
      if (!result.success) {
        const first = result.error.issues[0];
        const where = first && first.path.length ? `${first.path.join(".")}: ` : "";
        throw AppError.badRequest(`${where}${first?.message ?? "Invalid input"}`, "VALIDATION_ERROR", {
          issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      if (part === "body") {
        req.body = result.data;
      } else {
        // Express 5 exposes req.query as a getter; store validated data on a dedicated property.
        Object.defineProperty(req, part, { value: result.data, writable: true, configurable: true });
      }
    }
    next();
  };
}
