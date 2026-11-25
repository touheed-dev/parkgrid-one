import { Router } from "express";
import { z } from "zod";
import { me, requireAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { slotAvailability } from "../parking/service.js";
import * as service from "./service.js";

export const bookingsRouter: Router = Router();
bookingsRouter.use(requireAuth);

const iso = z.iso.datetime({ offset: true });
const uuid = z.uuid();

const availabilityQuery = z.object({
  start_at: iso,
  end_at: iso,
  level: z.string().max(10).optional(),
  zone: z.string().max(10).optional(),
  slot_type: z.string().max(20).optional(),
});

bookingsRouter.get("/availability", validate({ query: availabilityQuery }), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof availabilityQuery>;
  const availability = await slotAvailability(new Date(q.start_at), new Date(q.end_at), q);
  res.json({ availability });
});

const quoteQuery = z.object({ slot_id: z.string().min(1).max(40), start_at: iso, end_at: iso });
bookingsRouter.get("/quote", validate({ query: quoteQuery }), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof quoteQuery>;
  res.json({ quote: await service.quote(q.slot_id, q.start_at, q.end_at) });
});

// The client sends ONLY what it wants; price, status, user, hold time are all decided server-side.
const createBody = z.strictObject({ slot_id: z.string().min(1).max(40), vehicle_id: uuid, start_at: iso, end_at: iso });
bookingsRouter.post("/", validate({ body: createBody }), async (req, res) => {
  const booking = await service.createBooking(me(req), req.body);
  res.status(201).json({ booking });
});

const listQuery = z.object({
  statusTab: z.enum(["Upcoming", "Active", "Completed", "Cancelled"]).default("Upcoming"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
});
bookingsRouter.get("/", validate({ query: listQuery }), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof listQuery>;
  res.json(await service.listMine(me(req), q.statusTab, q.page, q.pageSize));
});

const lookupQuery = z.object({ reference: z.string().regex(/^SP-[0-9]{8}-[A-Z0-9]{4}$/).optional() });
bookingsRouter.get("/lookup", validate({ query: lookupQuery }), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof lookupQuery>;
  res.json(await service.getOne(me(req), q.reference ? { reference: q.reference } : {}));
});

const idParams = z.object({ id: uuid });
const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

bookingsRouter.get("/:id", validate({ params: idParams }), async (req, res) => {
  res.json(await service.getOne(me(req), { id: idOf(req) }));
});

bookingsRouter.get("/:id/cancellation-preview", validate({ params: idParams }), async (req, res) => {
  res.json({ preview: await service.cancellationPreview(me(req), idOf(req)) });
});

const cancelBody = z.strictObject({ reason: z.string().trim().max(200).nullish() });
bookingsRouter.post("/:id/cancel", validate({ params: idParams, body: cancelBody }), async (req, res) => {
  res.json(await service.cancelBooking(me(req), idOf(req), req.body.reason ?? null));
});
