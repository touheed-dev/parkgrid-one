import { hash } from "@node-rs/argon2";
import { readFileSync } from "node:fs";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { seedKb } from "../modules/kb/seed.js";
import { pool } from "./pool.js";

const DEMO_ACCOUNTS = [
  { email: "demo.member@parkgrid.demo", name: "Demo Driver", role: "member" },
  { email: "demo.staff@parkgrid.demo", name: "Demo Gate Staff", role: "staff" },
  { email: "demo.admin@parkgrid.demo", name: "Demo Admin", role: "admin" },
] as const;

/**
 * First-boot setup for hosts without a shell (free tiers). Everything is idempotent, so it is
 * safe on every start: parking layout, default settings, knowledge base and, only when
 * DEMO_SEED=true, three demo logins that already exist are left untouched.
 */
export async function bootstrap(): Promise<void> {
  await pool.query(readFileSync("seeds/parking.sql", "utf8"));
  await pool.query("insert into pricing_settings (id) values (true) on conflict (id) do nothing");
  const kb = await seedKb();
  logger.info({ kb }, "bootstrap: parking layout and knowledge base ready");

  if (!env.DEMO_SEED) return;
  if (env.DEMO_PASSWORD.length < 8) throw new Error("DEMO_SEED=true requires DEMO_PASSWORD (at least 8 characters)");
  const passwordHash = await hash(env.DEMO_PASSWORD);
  for (const a of DEMO_ACCOUNTS) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const exists = await client.query("select 1 from users where email = $1", [a.email]);
      if (!exists.rows[0]) {
        const u = await client.query<{ id: string }>("insert into users (email, password_hash) values ($1, $2) returning id", [a.email, passwordHash]);
        await client.query("insert into profiles (id, full_name, role) values ($1, $2, $3)", [u.rows[0]!.id, a.name, a.role]);
        if (a.role === "member") {
          await client.query(
            "insert into vehicles (user_id, plate_number, vehicle_type, make, model, color, is_default) values ($1, 'MH12DE1234', 'car', 'Tata', 'Nexon', 'White', true)",
            [u.rows[0]!.id],
          );
        }
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }
  logger.info("bootstrap: demo accounts ready");
}
