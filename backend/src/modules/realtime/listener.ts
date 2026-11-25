import pg from "pg";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";

export interface DbEvent {
  type: string;
  user_id?: string;
  booking_id?: string;
  session_id?: string;
  slot_id?: string;
}

const CHANNEL = "parkgrid";
const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

/**
 * ONE dedicated connection (never from the pool: pooled clients get recycled and would silently
 * lose the LISTEN). Reconnects with exponential backoff and re-issues LISTEN.
 * NOTIFY is delivered only after the sending transaction commits, so listeners never see
 * uncommitted work.
 */
export function startListener(onEvent: (e: DbEvent) => void): { stop: () => Promise<void> } {
  let client: pg.Client | null = null;
  let stopped = false;
  let backoff = MIN_BACKOFF_MS;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void connect(), backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const c = new pg.Client({
      connectionString: env.DATABASE_URL,
      ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
      keepAlive: true,
    });
    client = c;
    c.on("notification", (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      try {
        onEvent(JSON.parse(msg.payload) as DbEvent);
      } catch {
        logger.error("ignored malformed realtime payload");
      }
    });
    c.on("error", (err) => {
      logger.error({ err: err.message }, "realtime listener connection error");
    });
    c.on("end", () => {
      if (client === c) client = null;
      schedule(); // reconnect and re-LISTEN
    });
    try {
      await c.connect();
      await c.query(`LISTEN ${CHANNEL}`);
      backoff = MIN_BACKOFF_MS;
      logger.info("realtime listener connected");
    } catch (err) {
      logger.error({ err: (err as Error).message }, "realtime listener failed to connect");
      c.removeAllListeners("end");
      await c.end().catch(() => undefined);
      schedule();
    }
  };

  void connect();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      const c = client;
      client = null;
      if (c) {
        c.removeAllListeners("end");
        await c.end().catch(() => undefined);
      }
    },
  };
}
