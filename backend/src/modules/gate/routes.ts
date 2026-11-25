import { Router } from "express";
import { z } from "zod";
import { me, requireAuth, requireRole } from "../../middleware/auth.js";
import { gateLimiter } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import * as service from "./service.js";

/** Staff (and admins) only. Members can never scan, even their own pass. */
export const gateRouter: Router = Router();
gateRouter.use(requireAuth, requireRole("staff"), gateLimiter);

const scanBody = z.strictObject({
  token: z.string().min(5).max(120),
  direction: z.enum(["entry", "exit"]),
  gateId: z.string().max(40).optional(),
});

gateRouter.post("/scan", validate({ body: scanBody }), async (req, res) => {
  res.json(await service.scan(me(req), req.body));
});

gateRouter.get("/recent", async (req, res) => {
  res.json(await service.recentScans(me(req), 10));
});
