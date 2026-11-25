import pino from "pino";
import { env } from "../config/env.js";

export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.NODE_ENV === "production" ? "info" : "debug",
  // Never log credentials, tokens or card/UPI data (we never see the latter).
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.password_hash",
      "*.refreshToken",
      "*.refresh_token",
      "*.token",
      "*.razorpay_signature",
    ],
    censor: "[redacted]",
  },
});
