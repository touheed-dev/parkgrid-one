import cron, { type ScheduledTask } from "node-cron";
import { pool } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { expireStaleHolds, expireUnusedBookings } from "../modules/bookings/repo.js";
import { settlePendingRefunds } from "../modules/payments/refunds.js";
import { autoEndStaleSessions } from "../modules/sessions/service.js";

export interface JobDef {
  name: string;
  /** cron expression (node-cron) */
  schedule: string;
  run: () => Promise<number>;
}

/** Each job returns how many rows it touched, so logs show real work done. */
export const JOBS: JobDef[] = [
  { name: "expireStaleHolds", schedule: "* * * * *", run: () => expireStaleHolds() },
  { name: "expireUnusedBookings", schedule: "*/5 * * * *", run: () => expireUnusedBookings() },
  { name: "autoEndStaleSessions", schedule: "*/10 * * * *", run: () => autoEndStaleSessions() },
  { name: "settlePendingRefunds", schedule: "*/5 * * * *", run: () => settlePendingRefunds() },
];

/** Stable advisory-lock key per job name (so only ONE instance runs a job at a time). */
function lockKey(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

export type JobOutcome = { ran: true; count: number } | { ran: false; reason: "locked" | "failed" };

/**
 * Run one job under a Postgres advisory lock. If another instance holds the lock we skip.
 * Errors are logged and swallowed: a failing job must never crash the process.
 */
export async function runJob(name: string): Promise<JobOutcome | null> {
  const job = JOBS.find((j) => j.name === name);
  if (!job) return null;
  const client = await pool.connect();
  try {
    const got = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [lockKey(name)]);
    if (!got.rows[0]?.ok) return { ran: false, reason: "locked" };
    try {
      const count = await job.run();
      if (count > 0) logger.info({ job: name, count }, "job finished");
      return { ran: true, count };
    } catch (err) {
      logger.error({ job: name, err: (err as Error).message }, "job failed");
      return { ran: false, reason: "failed" };
    } finally {
      await client.query("select pg_advisory_unlock($1)", [lockKey(name)]);
    }
  } finally {
    client.release();
  }
}

const tasks: ScheduledTask[] = [];

export function startJobs(): void {
  for (const job of JOBS) {
    tasks.push(cron.schedule(job.schedule, () => void runJob(job.name)));
  }
  logger.info(`scheduled ${JOBS.length} background jobs`);
}

export async function stopJobs(): Promise<void> {
  for (const t of tasks) await t.stop();
  tasks.length = 0;
}
