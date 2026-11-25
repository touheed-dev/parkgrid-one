import { Router } from "express";
import { z } from "zod";
import { me, requireAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import * as service from "./service.js";

export const sessionsRouter: Router = Router();
sessionsRouter.use(requireAuth);

const activeQuery = z.object({ booking_id: z.uuid().optional() });
sessionsRouter.get("/active", validate({ query: activeQuery }), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof activeQuery>;
  res.json(await service.getActiveSession(me(req), q.booking_id ?? null));
});

const listQuery = z.object({
  status: z.string().max(20).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
});
sessionsRouter.get("/", validate({ query: listQuery }), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof listQuery>;
  res.json(await service.listMySessions(me(req), q.status && q.status !== "All" ? q.status : null, q.page, q.pageSize));
});

const idParams = z.object({ id: z.uuid() });
sessionsRouter.get("/:id", validate({ params: idParams }), async (req, res) => {
  res.json(await service.getSession(me(req), (req.params as unknown as { id: string }).id));
});

sessionsRouter.post("/:id/end", validate({ params: idParams }), async (req, res) => {
  res.json(await service.endSession(me(req), (req.params as unknown as { id: string }).id));
});
