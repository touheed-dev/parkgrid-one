import type pg from "pg";
import { pool } from "./pool.js";

export type Tx = pg.PoolClient;

const RETRYABLE = new Set(["40001", "40P01"]); // serialization_failure, deadlock_detected
const MAX_ATTEMPTS = 3;

/**
 * Run `fn` inside ONE transaction. Commits on success, rolls back on any throw, always releases
 * the client, and retries serialization failures / deadlocks up to 3 times.
 * Never `await` slow external HTTP (Razorpay/OpenAI/mail) inside `fn` while holding row locks.
 */
export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* connection already broken; release below discards it */
      }
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < MAX_ATTEMPTS) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * Run a ported SQL function that still uses the `auth.uid()` shim (see migration 010):
 * sets a transaction-local `app.user_id` first. Express has already authorised the caller.
 */
export async function withAuthUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTransaction(async (tx) => {
    await tx.query("select set_config('app.user_id', $1, true)", [userId]);
    return fn(tx);
  });
}
