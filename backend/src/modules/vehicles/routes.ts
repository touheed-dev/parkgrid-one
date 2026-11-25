import { Router } from "express";
import { z } from "zod";
import type { Queryable } from "../../db/pool.js";
import { query } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { AppError } from "../../lib/errors.js";
import { me, requireAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";

export const vehiclesRouter: Router = Router();
vehiclesRouter.use(requireAuth);

const CONNECTORS = ["CCS2", "Type2", "CHAdeMO", "Bharat_AC001", "Bharat_DC001"] as const;

const vehicleFields = {
  plate_number: z
    .string()
    .trim()
    .min(6, "Plate number must be at least 6 characters")
    .max(12, "Plate number cannot exceed 12 characters")
    .regex(/^[A-Za-z0-9\s-]+$/, "Plate number can only contain letters and numbers"),
  vehicle_type: z.enum(["car", "suv", "bike", "ev"]),
  make: z.string().trim().max(50, "Make cannot exceed 50 characters").nullish(),
  model: z.string().trim().max(50, "Model cannot exceed 50 characters").nullish(),
  color: z.string().trim().max(30, "Color cannot exceed 30 characters").nullish(),
  is_ev: z.boolean().default(false),
  connector_type: z.enum(CONNECTORS).nullish(),
  is_default: z.boolean().default(false),
};

function evRules(val: { is_ev: boolean; vehicle_type: string; connector_type?: string | null | undefined }, ctx: z.RefinementCtx) {
  const isEv = val.is_ev || val.vehicle_type === "ev";
  if (isEv && !val.connector_type) {
    ctx.addIssue({ code: "custom", message: "Connector type is required for electric vehicles", path: ["connector_type"] });
  }
  if (!isEv && val.connector_type) {
    ctx.addIssue({ code: "custom", message: "Connector type is only applicable for electric vehicles", path: ["connector_type"] });
  }
}

const createBody = z.strictObject(vehicleFields).superRefine(evRules);
const updateBody = z.strictObject(vehicleFields).superRefine(evRules);
const listQuery = z.object({ includeArchived: z.enum(["true", "false"]).default("false") });
const idParams = z.object({ id: z.uuid() });

type VehicleInput = z.infer<typeof createBody>;

const normalizePlate = (p: string): string => p.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
const clean = (v: string | null | undefined): string | null => v?.trim() || null;

function mapDbError(err: unknown, fallback: string): never {
  const e = err as { code?: string; message?: string };
  if (e.code === "23505") throw AppError.conflict("A vehicle with this plate number is already registered to your account.", "PLATE_TAKEN");
  if (e.code === "P0001" && /limit/i.test(e.message ?? "")) {
    throw AppError.badRequest("Active vehicle limit reached. You can register a maximum of 5 active vehicles.", "VEHICLE_LIMIT");
  }
  if (err instanceof AppError) throw err;
  throw AppError.badRequest(fallback, "VEHICLE_ERROR");
}

/** Atomic: clears other defaults and sets this one (own vehicles only). */
async function setDefault(db: Queryable, userId: string, vehicleId: string) {
  const found = await query("select 1 from vehicles where id = $1 and user_id = $2 and archived_at is null for update", [vehicleId, userId], db);
  if (!found.rows[0]) return null;
  await query("update vehicles set is_default = false where user_id = $1 and id <> $2 and is_default = true and archived_at is null", [userId, vehicleId], db);
  const { rows } = await query("update vehicles set is_default = true where id = $1 and user_id = $2 returning *", [vehicleId, userId], db);
  return rows[0] ?? null;
}

vehiclesRouter.get("/", validate({ query: listQuery }), async (req, res) => {
  const includeArchived = (req.query as unknown as z.infer<typeof listQuery>).includeArchived === "true";
  const { rows } = await query(
    `select * from vehicles where user_id = $1 ${includeArchived ? "" : "and archived_at is null"}
      order by is_default desc, created_at desc`,
    [me(req).id],
  );
  res.json({ vehicles: rows });
});

vehiclesRouter.post("/", validate({ body: createBody }), async (req, res) => {
  const userId = me(req).id;
  const d = req.body as VehicleInput;
  const isEv = d.is_ev || d.vehicle_type === "ev";
  try {
    const vehicle = await withTransaction(async (tx) => {
      const ins = await query(
        `insert into vehicles (user_id, plate_number, vehicle_type, make, model, color, is_ev, connector_type, is_default)
         values ($1,$2,$3,$4,$5,$6,$7,$8,false) returning *`,
        [userId, normalizePlate(d.plate_number), d.vehicle_type, clean(d.make), clean(d.model), clean(d.color), isEv, isEv ? d.connector_type : null],
        tx,
      );
      const created = ins.rows[0]!;
      return d.is_default ? ((await setDefault(tx, userId, created.id)) ?? created) : created;
    });
    res.status(201).json({ vehicle });
  } catch (err) {
    mapDbError(err, "Failed to register vehicle. Please check the details and try again.");
  }
});

// Ownership is part of every WHERE clause; other users' vehicles answer 404 (never 403).
vehiclesRouter.patch("/:id", validate({ params: idParams, body: updateBody }), async (req, res) => {
  const userId = me(req).id;
  const d = req.body as VehicleInput;
  const id = (req.params as unknown as { id: string }).id;
  const isEv = d.is_ev || d.vehicle_type === "ev";
  try {
    const vehicle = await withTransaction(async (tx) => {
      const upd = await query(
        `update vehicles set plate_number=$3, vehicle_type=$4, make=$5, model=$6, color=$7, is_ev=$8, connector_type=$9
          where id = $1 and user_id = $2 and archived_at is null returning *`,
        [id, userId, normalizePlate(d.plate_number), d.vehicle_type, clean(d.make), clean(d.model), clean(d.color), isEv, isEv ? d.connector_type : null],
        tx,
      );
      const updated = upd.rows[0];
      if (!updated) throw AppError.notFound("Vehicle not found, already archived, or access denied.");
      return d.is_default && !updated.is_default ? ((await setDefault(tx, userId, id)) ?? updated) : updated;
    });
    res.json({ vehicle });
  } catch (err) {
    mapDbError(err, "Vehicle not found or could not be updated.");
  }
});

vehiclesRouter.post("/:id/default", validate({ params: idParams }), async (req, res) => {
  const id = (req.params as unknown as { id: string }).id;
  const vehicle = await withTransaction((tx) => setDefault(tx, me(req).id, id));
  if (!vehicle) throw AppError.notFound("Vehicle not found, already archived, or access denied.");
  res.json({ vehicle });
});

// "Delete" archives the vehicle: bookings keep a plate snapshot, so history stays intact.
vehiclesRouter.delete("/:id", validate({ params: idParams }), async (req, res) => {
  const id = (req.params as unknown as { id: string }).id;
  const { rows } = await query<{ id: string }>(
    "update vehicles set archived_at = now(), is_default = false where id = $1 and user_id = $2 and archived_at is null returning id",
    [id, me(req).id],
  );
  if (!rows[0]) throw AppError.notFound("Vehicle not found or already archived.");
  res.json({ success: true, id: rows[0].id });
});
