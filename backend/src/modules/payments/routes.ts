import { Router } from "express";
import { z } from "zod";
import { me, requireAuth } from "../../middleware/auth.js";
import { paymentLimiter } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import * as service from "./service.js";

export const paymentsRouter: Router = Router();
paymentsRouter.use(requireAuth);

const method = z.enum(["upi", "card", "netbanking", "wallet"]);

paymentsRouter.get("/config", async (_req, res) => {
  res.json(await service.getConfig());
});

// Mock gateway (dev/tests). Keeps the original scenario picker working.
const payBody = z.strictObject({
  booking_id: z.uuid(),
  method,
  idempotency_key: z.string().min(8).max(100),
  test_scenario: z.enum(["success", "decline", "insufficient_funds", "timeout"]).default("success"),
});
paymentsRouter.post("/pay", paymentLimiter, validate({ body: payBody }), async (req, res) => {
  res.json(await service.payWithMock(me(req), req.body));
});

const orderBody = z.strictObject({ booking_id: z.uuid(), method: method.optional() });
paymentsRouter.post("/create-order", paymentLimiter, validate({ body: orderBody }), async (req, res) => {
  res.status(201).json(await service.createOrder(me(req), req.body));
});

const verifyBody = z.strictObject({
  razorpay_order_id: z.string().min(5).max(100),
  razorpay_payment_id: z.string().min(5).max(100),
  razorpay_signature: z.string().min(10).max(200),
});
paymentsRouter.post("/verify", paymentLimiter, validate({ body: verifyBody }), async (req, res) => {
  res.json(await service.verifyPayment(me(req), req.body));
});

const failedBody = z.strictObject({ razorpay_order_id: z.string().min(5).max(100), reason: z.string().max(200).default("Payment was not completed") });
paymentsRouter.post("/report-failure", paymentLimiter, validate({ body: failedBody }), async (req, res) => {
  // Only touches an order that belongs to the caller and is still 'created'.
  await service.markOrderFailedForUser(me(req), req.body.razorpay_order_id, req.body.reason);
  res.json({ success: true });
});

const receiptQuery = z
  .object({ booking_id: z.uuid().optional(), payment_id: z.uuid().optional(), receipt_number: z.string().max(40).optional() })
  .refine((d) => d.booking_id || d.payment_id || d.receipt_number, "Must specify booking_id, payment_id, or receipt_number");
paymentsRouter.get("/receipt", validate({ query: receiptQuery }), async (req, res) => {
  res.json(await service.getReceipt(me(req), req.query as unknown as z.infer<typeof receiptQuery>));
});

const listQuery = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(10) });
paymentsRouter.get("/", validate({ query: listQuery }), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof listQuery>;
  res.json(await service.listMine(me(req), q.page, q.pageSize));
});
