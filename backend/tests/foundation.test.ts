import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it, afterAll } from "vitest";
import { createApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { percentOfBps, quoteFor, refundFor } from "../src/lib/money.js";
import { isAlignedTo15Min, istDateStamp } from "../src/lib/time.js";
import { parseQrPayload, toQrPayload, newQrToken } from "../src/lib/tokens.js";

const app = createApp();
afterAll(async () => {
  await pool.end();
});

describe("health", () => {
  it("reports db up", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.db).toBe("up");
  });
  it("returns the standard error shape for unknown routes", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ROUTE_NOT_FOUND");
  });
});

describe("schema + seed", () => {
  it("seeds exactly 5 levels and 150 slots, idempotently", async () => {
    const sql = readFileSync("seeds/parking.sql", "utf8");
    await pool.query(sql);
    await pool.query(sql);
    const { rows } = await pool.query(
      "select (select count(*) from parking_levels)::int as levels, (select count(*) from parking_slots)::int as slots",
    );
    expect(rows[0]).toEqual({ levels: 5, slots: 150 });
  });
  it("has the exclusion constraint that blocks double booking", async () => {
    const { rows } = await pool.query(
      "select 1 from pg_constraint where conname = 'bookings_slot_during_overlap_excl'",
    );
    expect(rows).toHaveLength(1);
  });
});

describe("money (parity with the original SQL rounding)", () => {
  it("rounds GST half-up on integer paise", () => {
    expect(percentOfBps(5000, 1800)).toBe(900);
    expect(percentOfBps(5001, 1800)).toBe(900); // 900.18 -> 900
    expect(percentOfBps(2500, 1850)).toBe(463); // 462.5 -> 463 (half away from zero)
  });
  it("builds a quote", () => {
    expect(quoteFor(2, 7000, 1800)).toEqual({
      hours: 2, hourly_rate_paise: 7000, base_paise: 14000, gst_paise: 2520, total_paise: 16520,
    });
  });
  const policy = { refund_full_hours: 2, refund_partial_minutes: 30, partial_refund_bps: 5000 };
  const H = 3_600_000;
  it("applies the refund tiers only to paid bookings", () => {
    expect(refundFor(10000, true, 3 * H, policy)).toEqual({ refund_paise: 10000, refund_percentage: 100 });
    expect(refundFor(10000, true, 2 * H, policy)).toEqual({ refund_paise: 10000, refund_percentage: 100 });
    expect(refundFor(10000, true, 1 * H, policy)).toEqual({ refund_paise: 5000, refund_percentage: 50 });
    expect(refundFor(10000, true, 29 * 60_000, policy)).toEqual({ refund_paise: 0, refund_percentage: 0 });
    expect(refundFor(10000, false, 5 * H, policy)).toEqual({ refund_paise: 0, refund_percentage: 0 });
  });
});

describe("time (IST boundaries)", () => {
  it("checks 15-minute alignment on the IST clock", () => {
    expect(isAlignedTo15Min(new Date("2026-03-01T04:30:00Z"))).toBe(true); // 10:00 IST
    expect(isAlignedTo15Min(new Date("2026-03-01T04:40:00Z"))).toBe(false);
    expect(isAlignedTo15Min(new Date("2026-03-01T04:30:30Z"))).toBe(false);
  });
  it("uses the IST calendar day for references (crossing midnight IST)", () => {
    expect(istDateStamp(new Date("2026-03-01T18:29:59Z"))).toBe("20260301"); // 23:59:59 IST
    expect(istDateStamp(new Date("2026-03-01T18:30:00Z"))).toBe("20260302"); // 00:00 IST next day
  });
});

describe("qr token", () => {
  it("round-trips the PG1: payload and rejects junk", () => {
    const t = newQrToken();
    expect(parseQrPayload(toQrPayload(t))).toBe(t);
    expect(parseQrPayload("SP-20260101-ABCD")).toBeNull();
    expect(parseQrPayload("PG1:short")).toBeNull();
  });
});
