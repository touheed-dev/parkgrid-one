import type { Queryable } from "../../db/pool.js";
import { query } from "../../db/pool.js";

export interface PricingSettings {
  id: boolean;
  gst_bps: number;
  hold_minutes: number;
  min_hours: number;
  max_hours: number;
  max_advance_days: number;
  refund_full_hours: number;
  refund_partial_minutes: number;
  partial_refund_bps: number;
  payment_mode: "mock" | "razorpay";
  max_payment_attempts: number;
  exit_grace_minutes: number;
  early_entry_minutes: number;
  created_at: Date;
  updated_at: Date;
}

export async function getPricingSettings(db?: Queryable): Promise<PricingSettings> {
  const { rows } = await query<PricingSettings>("select * from pricing_settings where id = true", [], db);
  if (!rows[0]) throw new Error("pricing_settings row missing (run the migrations/seed)");
  return rows[0];
}
