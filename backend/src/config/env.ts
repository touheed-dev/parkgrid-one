import "dotenv/config";
import { z } from "zod";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_BASE_URL: z.string().url().default("http://localhost:4000"),
  CORS_ORIGINS: z.string().default("http://localhost:3000,http://localhost:5173"),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: bool.default(false),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  JWT_ACCESS_TTL: z.string().default("15m"),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  PASSWORD_RESET_TTL_MIN: z.coerce.number().int().min(5).max(1440).default(30),

  PAYMENT_PROVIDER: z.enum(["mock", "razorpay"]).default("mock"),
  RAZORPAY_KEY_ID: z.string().default(""),
  RAZORPAY_KEY_SECRET: z.string().default(""),
  RAZORPAY_WEBHOOK_SECRET: z.string().default(""),

  OPENAI_API_KEY: z.string().default(""),
  // Free alternative for the assistant text (embeddings stay offline/OpenAI: Groq has none).
  GROQ_API_KEY: z.string().default(""),
  GROQ_MODEL: z.string().default("openai/gpt-oss-20b"),
  CHAT_MODEL: z.string().default("gpt-4o-mini"),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDING_DIM: z.coerce.number().int().min(8).max(4096).default(1536),
  RAG_TOP_K: z.coerce.number().int().min(1).max(20).default(5),
  RAG_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.25),

  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  MAIL_FROM: z.string().default("ParkGrid <no-reply@parkgrid.local>"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  CRON_SECRET: z.string().min(16, "CRON_SECRET must be at least 16 characters").default("dev-cron-secret-0000"),
  ENABLE_JOBS: bool.default(true),

  ADMIN_SEED_EMAIL: z.string().default(""),
  ADMIN_SEED_PASSWORD: z.string().default(""),
  // Free-tier hosting has no shell: set up the database on first boot (idempotent).
  BOOTSTRAP_ON_BOOT: bool.default(false),
  DEMO_SEED: bool.default(false),
  DEMO_PASSWORD: z.string().default(""),
  REDIS_URL: z.string().default(""),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    // Fail fast: a misconfigured server must never start.
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  const env = parsed.data;
  if (env.PAYMENT_PROVIDER === "razorpay") {
    const missing = (["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"] as const).filter(
      (k) => !env[k],
    );
    if (missing.length) {
      throw new Error(`PAYMENT_PROVIDER=razorpay requires: ${missing.join(", ")}`);
    }
  }
  return env;
}

export const env: Env = load();
export const corsOrigins = env.CORS_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
