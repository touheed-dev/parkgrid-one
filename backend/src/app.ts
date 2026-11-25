import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { randomUUID } from "node:crypto";
import { corsOrigins, env } from "./config/env.js";
import { pool } from "./db/pool.js";
import { logger } from "./lib/logger.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { globalLimiter } from "./middleware/rateLimit.js";
import { apiRouter } from "./modules/index.js";
import { webhooksRouter } from "./modules/payments/webhooks.routes.js";

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        const id = typeof incoming === "string" && incoming.length <= 64 ? incoming : randomUUID();
        res.setHeader("x-request-id", id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === "/healthz" },
    }),
  );
  // This is an API consumed cross-origin by the web app; CORS (below) is the real gatekeeper.
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(
    cors({
      origin: (origin, cb) => {
        // Non-browser clients (curl, server-to-server, webhooks) send no Origin header.
        if (!origin || corsOrigins.includes(origin)) cb(null, true);
        else cb(null, false);
      },
      credentials: false,
      allowedHeaders: ["Authorization", "Content-Type", "X-Request-Id"],
      exposedHeaders: ["X-Request-Id"],
    }),
  );

  app.get("/healthz", async (_req, res) => {
    try {
      await pool.query("select 1");
      res.json({ status: "ok", db: "up", time: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: "degraded", db: "down" });
    }
  });

  // Webhooks need the RAW body for signature verification, so they are mounted BEFORE express.json().
  app.use("/webhooks", webhooksRouter);

  app.use(express.json({ limit: "100kb" }));
  app.use(globalLimiter);
  app.use(apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
