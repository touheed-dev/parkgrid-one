/**
 * npm run seed:admin
 * Creates (or promotes) an administrator from ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD.
 * Credentials are read from the environment only, never hard-coded.
 */
import { hash } from "@node-rs/argon2";
import { env } from "../src/config/env.js";
import { pool } from "../src/db/pool.js";

async function main(): Promise<void> {
  const email = env.ADMIN_SEED_EMAIL.trim().toLowerCase();
  const password = env.ADMIN_SEED_PASSWORD;
  if (!email || password.length < 12) {
    throw new Error("Set ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD (at least 12 characters) in the environment.");
  }
  const passwordHash = await hash(password);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{ id: string }>("select id from users where email = $1", [email]);
    let id = existing.rows[0]?.id;
    if (id) {
      await client.query("update users set password_hash = $2, disabled_at = null where id = $1", [id, passwordHash]);
    } else {
      const ins = await client.query<{ id: string }>("insert into users (email, password_hash) values ($1, $2) returning id", [email, passwordHash]);
      id = ins.rows[0]!.id;
      await client.query("insert into profiles (id, full_name, role) values ($1, 'Administrator', 'admin')", [id]);
    }
    await client.query("update profiles set role = 'admin' where id = $1", [id]);
    await client.query("commit");
    console.log(`administrator ready: ${email}`);
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
