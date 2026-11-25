/** npm run seed - idempotent: parking levels + 150 slots, default settings, knowledge base. */
import { readFileSync } from "node:fs";
import { pool } from "../src/db/pool.js";
import { seedKb } from "./seed-kb.js";

async function main(): Promise<void> {
  await pool.query(readFileSync("seeds/parking.sql", "utf8"));
  await pool.query("insert into pricing_settings (id) values (true) on conflict (id) do nothing");
  const { rows } = await pool.query<{ slots: number }>("select count(*)::int as slots from parking_slots");
  console.log(`parking seeded: ${rows[0]?.slots} slots`);
  console.log("knowledge base:", await seedKb());
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
