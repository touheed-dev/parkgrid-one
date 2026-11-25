import type { Request } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { env } from "../config/env.js";

const isTest = env.NODE_ENV === "test";

function limiter(windowMs: number, limit: number, message: string, keyFn?: (req: Request) => string) {
  return rateLimit({
    windowMs,
    limit: isTest ? 10_000 : limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: keyFn ?? ((req) => ipKeyGenerator(req.ip ?? "unknown")),
    handler: (_req, res) => {
      res.status(429).json({ error: { code: "RATE_LIMITED", message } });
    },
  });
}

const perUserOrIp = (req: Request): string => req.user?.id ?? ipKeyGenerator(req.ip ?? "unknown");

/** Generous global ceiling per IP. */
export const globalLimiter = limiter(60_000, 600, "Too many requests. Please slow down.");
/** Strict limiter for login/signup/forgot-password (per IP). Per-email limits live in auth service. */
export const authLimiter = limiter(15 * 60_000, 40, "Too many attempts. Please try again in a few minutes.");
export const paymentLimiter = limiter(60_000, 30, "Too many payment requests. Please wait a moment.", perUserOrIp);
export const gateLimiter = limiter(60_000, 120, "Too many scans. Please slow down.", perUserOrIp);
export const chatLimiter = limiter(10 * 60_000, 20, "You have reached the assistant message limit. Try again later.", perUserOrIp);
