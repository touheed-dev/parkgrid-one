import { runner } from "node-pg-migrate";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { ADMIN_DB_URL } from "./test-env.js";

const DB = "parkgrid_roundtrip";
const url = ADMIN_DB_URL.replace(/\/[^/]+$/, `/${DB}`);

async function migrate(direction: "up" | "down"): Promise<void> {
  await runner({
    databaseUrl: url,
    dir: "migrations",
    direction,
    migrationsTable: "pgmigrations",
    count: direction === "down" ? Infinity : undefined,
    log: () => undefined,
  });
}

describe("migrations", () => {
  it("run up -> down (all) -> up cleanly on an empty database", async () => {
    const admin = new pg.Client({ connectionString: ADMIN_DB_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${DB}`);
    await admin.query(`create database ${DB}`);
    await admin.end();

    await migrate("up");
    await migrate("down");

    const mid = new pg.Client({ connectionString: url });
    await mid.connect();
    const { rows } = await mid.query(
      "select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name <> 'pgmigrations'",
    );
    await mid.end();
    expect(rows[0].n).toBe(0);

    await migrate("up");

    const admin2 = new pg.Client({ connectionString: ADMIN_DB_URL });
    await admin2.connect();
    await admin2.query(`drop database if exists ${DB} with (force)`);
    await admin2.end();
  });
});
