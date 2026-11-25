import { Router } from "express";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { safeEqual } from "../../lib/tokens.js";
import { runJob } from "../../jobs/index.js";

/** For an external scheduler (e.g. Render cron / GitHub Actions). Protected by CRON_SECRET. */
export const internalRouter: Router = Router();

internalRouter.post("/jobs/:name", async (req, res) => {
  const secret = req.get("x-cron-secret") ?? "";
  if (!safeEqual(secret, env.CRON_SECRET)) throw AppError.unauthorized("Invalid cron secret", "INVALID_CRON_SECRET");
  const outcome = await runJob(String(req.params["name"]));
  if (!outcome) throw AppError.notFound("Unknown job", "JOB_NOT_FOUND");
  res.json(outcome);
});
