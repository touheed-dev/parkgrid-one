import pg from "pg";
import { env } from "../config/env.js";

// bigint (int8) comes back as a string by default; our counts/sums are far below 2^53.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 20_000,
});

pool.on("error", (err) => {
  // An idle client failing must never crash the process.
  console.error("[pg pool] idle client error:", err.message);
});

export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client: Queryable = pool,
): Promise<pg.QueryResult<T>> {
  return client.query<T>(text, params);
}
