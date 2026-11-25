import { runner } from "node-pg-migrate";
import pg from "pg";
import { ADMIN_DB_URL, TEST_DB_NAME, TEST_DB_URL } from "./test-env.js";

/** Creates a fresh throw-away database and applies ALL migrations before the test run. */
export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  try {
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1`, [TEST_DB_NAME]);
    await admin.query(`drop database if exists ${TEST_DB_NAME}`);
    await admin.query(`create database ${TEST_DB_NAME}`);
  } finally {
    await admin.end();
  }

  await runner({
    databaseUrl: TEST_DB_URL,
    dir: "migrations",
    direction: "up",
    migrationsTable: "pgmigrations",
    log: () => undefined,
  });
}
