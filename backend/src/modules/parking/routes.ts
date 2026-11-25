import { Router } from "express";
import { z } from "zod";
import { query } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { AppError } from "../../lib/errors.js";
import { me, requireAdmin, requireAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { writeAudit } from "../admin/audit.js";
import * as service from "./service.js";

export const parkingRouter: Router = Router();
parkingRouter.use(requireAuth);

const num = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

const listQuery = z.object({
  level: z.enum(["All", "B2", "B1", "G1", "L1", "L2"]).default("All"),
  zone: z.enum(["All", "A", "B", "EV"]).default("All"),
  slot_type: z.enum(["All", "standard", "ev", "accessible"]).default("All"),
  admin_status: z.enum(["All", "active", "maintenance", "blocked"]).default("All"),
  search: z.string().max(50).default(""),
  page: num(1, 1, 100_000),
  pageSize: num(0, 0, 200), // 0 = return every matching slot
});

parkingRouter.get("/slots", validate({ query: listQuery }), async (req, res) => {
  const user = me(req);
  const q = req.query as unknown as z.infer<typeof listQuery>;
  // Admins/staff see which booking occupies a bay; members only see free/occupied.
  res.json(await service.listSlots(q, user.role === "admin" || user.role === "staff"));
});

parkingRouter.get("/summary", async (_req, res) => {
  res.json(await service.getFacilitySummary());
});

const updateSlotBody = z
  .strictObject({
    admin_status: z.enum(["active", "maintenance", "blocked"]).optional(),
    notes: z.string().max(500).nullable().optional(),
    hourly_rate_paise: z.number().int().min(0).max(100_000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "No updatable fields provided");

// Only status, notes and rate may change: code/level/zone/bay/type are fixed facts of the building.
parkingRouter.patch("/slots/:id", requireAdmin, validate({ params: z.object({ id: z.uuid() }), body: updateSlotBody }), async (req, res) => {
  const id = (req.params as unknown as { id: string }).id;
  const slot = await withTransaction(async (tx) => {
    const before = await query("select * from parking_slots where id = $1 for update", [id], tx);
    if (!before.rows[0]) throw AppError.notFound("Parking slot not found");
    const body = req.body as z.infer<typeof updateSlotBody>;
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const key of ["admin_status", "notes", "hourly_rate_paise"] as const) {
      if (body[key] !== undefined) {
        params.push(body[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    const { rows } = await query(`update parking_slots set ${sets.join(", ")} where id = $1 returning *`, params, tx);
    await writeAudit(tx, {
      actorId: me(req).id, action: "update_slot", recordType: "parking_slots", recordId: id,
      oldData: before.rows[0], newData: rows[0],
    });
    return rows[0];
  });
  res.json({ success: true, slot });
});
