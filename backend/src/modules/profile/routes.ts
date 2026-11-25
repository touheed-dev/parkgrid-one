import { Router } from "express";
import { z } from "zod";
import { query } from "../../db/pool.js";
import { AppError } from "../../lib/errors.js";
import { me, requireAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";

export const profileRouter: Router = Router();
profileRouter.use(requireAuth);

const PHONE_RE = /^(?:\+91|91|0)?([6-9]\d{9})$/;

const updateBody = z.strictObject({
  full_name: z.string().trim().min(2, "Name must be between 2 and 80 characters").max(80, "Name must be between 2 and 80 characters"),
  phone: z
    .string()
    .trim()
    .nullable()
    .optional()
    .refine((v) => !v || PHONE_RE.test(v.replace(/[\s-]/g, "")), "Phone must be a valid 10-digit Indian mobile number starting with 6-9")
    .transform((v) => {
      if (!v) return null;
      const m = PHONE_RE.exec(v.replace(/[\s-]/g, ""));
      return m?.[1] ? `+91${m[1]}` : null;
    }),
});

interface ProfileRow {
  id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  role: "member" | "admin" | "staff";
  created_at: Date;
}

const PROFILE_SQL = `select u.id, u.email::text as email, p.full_name, p.phone, p.role, p.created_at
                       from profiles p join users u on u.id = p.id where p.id = $1`;

profileRouter.get("/", async (req, res) => {
  const { rows } = await query<ProfileRow>(PROFILE_SQL, [me(req).id]);
  if (!rows[0]) throw AppError.notFound("Profile not found");
  res.json({ profile: rows[0] });
});

// Only full_name and phone can change here. Role/avatar/id sent by a client are rejected (strict schema).
profileRouter.patch("/", validate({ body: updateBody }), async (req, res) => {
  const userId = me(req).id;
  await query("update profiles set full_name = $2, phone = $3 where id = $1", [userId, req.body.full_name, req.body.phone ?? null]);
  const { rows } = await query<ProfileRow>(PROFILE_SQL, [userId]);
  res.json({ profile: rows[0] });
});

profileRouter.get("/recent-bookings", async (req, res) => {
  const { rows } = await query(
    `select b.id, b.reference, b.status, b.start_at, b.end_at, b.total_paise,
            json_build_object('code', s.code, 'zone', s.zone, 'level_code', s.level_code) as parking_slots
       from bookings b join parking_slots s on s.id = b.slot_id
      where b.user_id = $1
      order by b.created_at desc
      limit 5`,
    [me(req).id],
  );
  res.json({ bookings: rows });
});
