/** Shared by globalSetup (separate process) and setupFiles (each worker). */
export const ADMIN_DB_URL = process.env["TEST_ADMIN_DATABASE_URL"] ?? "postgres://parkgrid:parkgrid@localhost:54329/postgres";
export const TEST_DB_NAME = "parkgrid_test";
export const TEST_DB_URL = process.env["TEST_DATABASE_URL"] ?? `postgres://parkgrid:parkgrid@localhost:54329/${TEST_DB_NAME}`;
