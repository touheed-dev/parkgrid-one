import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";

/**
 * Embedding providers.
 *  - openai: OpenAI embeddings API (EMBEDDING_MODEL, truncated to EMBEDDING_DIM via `dimensions`)
 *  - local : deterministic hashed bag-of-words vectors. Used when no OPENAI_API_KEY is set, so
 *            dev, CI and the eval script work offline. Lexical (not semantic) but good enough
 *            for FAQ-style retrieval and fully reproducible.
 * The stored vector dimension must equal EMBEDDING_DIM (see docs/RAG.md before changing models).
 */
export interface EmbeddingProvider {
  readonly name: "openai" | "local";
  embed(texts: string[]): Promise<number[][]>;
}

const BATCH_SIZE = 64;
const MAX_ATTEMPTS = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STOPWORDS = new Set(
  "a an the and or of to in on for at is are was were be been it this that these those with as by from can i my me you your we our do does did how what when where which who why will would should could may might if then than so not no yes".split(" "),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9₹%+.\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[.]+|[.]+$/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function stem(t: string): string {
  return t.length > 4 ? t.replace(/(ing|ed|es|s)$/, "") : t;
}

/**
 * Parking-domain synonyms folded onto one canonical term, so a paraphrase ("reserve" vs "book",
 * "cost" vs "fee") still lands on the same hashed feature. Only used by the offline embedder;
 * real embedding models understand this natively.
 */
const CANONICAL: Record<string, string> = {};
for (const [canon, words] of Object.entries({
  book: ["book", "reserve", "reservation", "booking", "advance", "ahead"],
  cancel: ["cancel", "cancellation", "cancelled", "cancelling"],
  fee: ["fee", "cost", "price", "charge", "charged", "tariff", "rate", "pricing", "pay", "paid"],
  exit: ["exit", "leave", "leaving", "depart", "departure", "checkout", "out"],
  hours: ["hours", "open", "close", "closing", "timing", "timings", "operating", "24/7"],
  overstay: ["overstay", "late", "extend", "extension", "exceed", "beyond", "stay", "grace"],
  ev: ["ev", "electric", "charging", "charger", "chargers", "kwh", "connector", "connectors"],
  heavy: ["heavy", "truck", "large", "oversized", "lorry"],
  deduct: ["deducted", "debited", "money", "deduction"],
  invoice: ["invoice", "receipt", "gst", "tax", "taxes"],
  arrive: ["arrive", "arrival", "show", "noshow", "no-show", "miss"],
  edit: ["edit", "change", "modify", "modification", "update"],
  availability: ["availability", "available", "vacant", "free", "live", "real-time"],
  qr: ["qr", "barcode", "barrier", "scan", "scanner", "contactless"],
  entrance: ["entrance", "entry", "enter", "arrival-gate", "located", "location"],
  refund: ["refund", "refunded", "reimbursed", "bank"],
  floor: ["floor", "floors", "level", "levels", "storey", "building"],
  history: ["history", "upcoming", "passes", "past"],
})) {
  for (const w of words) CANONICAL[w] = canon;
}
const canon = (t: string): string => CANONICAL[t] ?? CANONICAL[stem(t)] ?? stem(t);

/** Canonical content terms of a text (stopwords removed, synonyms folded). */
export function contentTerms(text: string): Set<string> {
  return new Set(tokenize(text).map(canon));
}

export function localEmbed(text: string, dim = env.EMBEDDING_DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  const toks = tokenize(text).map(canon);
  const feats = [...toks];
  for (let i = 0; i < toks.length - 1; i++) feats.push(`${toks[i]}_${toks[i + 1]}`); // bigrams
  for (const f of feats) {
    const h = fnv1a(f);
    v[h % dim] = (v[h % dim] ?? 0) + (h & 0x80000000 ? -1 : 1) * (f.includes("_") ? 0.7 : 1);
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

class LocalProvider implements EmbeddingProvider {
  readonly name = "local" as const;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => localEmbed(t));
  }
}

class OpenAiProvider implements EmbeddingProvider {
  readonly name = "openai" as const;

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      out.push(...(await this.batch(texts.slice(i, i + BATCH_SIZE))));
    }
    return out;
  }

  private async batch(input: string[]): Promise<number[][]> {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
          body: JSON.stringify({ model: env.EMBEDDING_MODEL, input, dimensions: env.EMBEDDING_DIM, encoding_format: "float" }),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`retryable status ${res.status}`);
        if (!res.ok) throw new Error(`embedding request failed with status ${res.status}`);
        const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
        return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) throw err;
        logger.warn({ attempt }, "embedding request failed, retrying");
        await sleep(400 * 2 ** attempt); // exponential backoff
      }
    }
  }
}

let override: EmbeddingProvider | null = null;
export function setEmbeddingProviderForTests(p: EmbeddingProvider | null): void {
  override = p;
}

export function getEmbeddingProvider(): EmbeddingProvider {
  if (override) return override;
  return env.OPENAI_API_KEY ? new OpenAiProvider() : new LocalProvider();
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const vectors = await getEmbeddingProvider().embed(texts);
  for (const v of vectors) {
    if (v.length !== env.EMBEDDING_DIM) {
      throw new Error(`embedding has ${v.length} dimensions, expected EMBEDDING_DIM=${env.EMBEDDING_DIM}`);
    }
  }
  return vectors;
}

export const toVectorLiteral = (v: number[]): string => `[${v.join(",")}]`;
