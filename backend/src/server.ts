import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./db/pool.js";
import { startJobs, stopJobs } from "./jobs/index.js";
import { logger } from "./lib/logger.js";
import { bootstrap } from "./db/bootstrap.js";
import { attachRealtime } from "./modules/realtime/socket.js";

if (env.BOOTSTRAP_ON_BOOT) await bootstrap();

const app = createApp();
const server = createServer(app);
const realtime = attachRealtime(server);

server.listen(env.PORT, () => {
  logger.info(`ParkGrid API listening on :${env.PORT} (${env.NODE_ENV})`);
  if (env.ENABLE_JOBS) startJobs();
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received: shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await stopJobs();
  await realtime.close().catch(() => undefined);
  server.close(async () => {
    await pool.end().catch(() => undefined);
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "unhandled promise rejection");
});
