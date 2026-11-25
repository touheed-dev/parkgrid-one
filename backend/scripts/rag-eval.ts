/**
 * npm run rag:eval
 * Retrieval evaluation over tests/rag/eval.json against the published knowledge base:
 *   - in_scope        : hit@1 / hit@k (an expected FAQ id appears in the top results)
 *   - out_of_scope    : must NOT retrieve anything above the similarity threshold
 *   - injection       : must NOT retrieve anything above the threshold either (so the model would
 *                       get an empty context and deflect), and the system prompt never contains secrets
 * Exit code 1 when a threshold is missed, so CI can gate on it.
 */
import { readFileSync } from "node:fs";
import { env } from "../src/config/env.js";
import { pool } from "../src/db/pool.js";
import { buildSystemPrompt } from "../src/modules/chat/routes.js";
import { getEmbeddingProvider } from "../src/modules/kb/embeddings.js";
import { search } from "../src/modules/kb/service.js";
import { seedKb } from "./seed-kb.js";

interface Item { id: string; type: "in_scope" | "out_of_scope" | "injection"; question: string; expect?: string[] }

export interface EvalReport {
  provider: string;
  topK: number;
  minScore: number;
  inScope: { total: number; hitAt1: number; hitAtK: number; failures: string[] };
  outOfScope: { total: number; correctlyRejected: number; failures: string[] };
  injection: { total: number; correctlyRejected: number; failures: string[] };
}

export async function runEval(file = "tests/rag/eval.json"): Promise<EvalReport> {
  const items = JSON.parse(readFileSync(file, "utf8")) as Item[];
  const topK = env.RAG_TOP_K;
  const report: EvalReport = {
    provider: getEmbeddingProvider().name, topK, minScore: env.RAG_MIN_SCORE,
    inScope: { total: 0, hitAt1: 0, hitAtK: 0, failures: [] },
    outOfScope: { total: 0, correctlyRejected: 0, failures: [] },
    injection: { total: 0, correctlyRejected: 0, failures: [] },
  };

  for (const it of items) {
    const hits = await search(it.question, { topK });
    const ids = hits.map((h) => String(h.metadata["faq_id"] ?? ""));
    if (it.type === "in_scope") {
      report.inScope.total += 1;
      const expected = it.expect ?? [];
      if (ids[0] && expected.includes(ids[0])) report.inScope.hitAt1 += 1;
      if (ids.some((id) => expected.includes(id))) report.inScope.hitAtK += 1;
      else report.inScope.failures.push(`${it.id}: expected ${expected.join("|")} got [${ids.join(", ")}]`);
    } else {
      const bucket = it.type === "out_of_scope" ? report.outOfScope : report.injection;
      bucket.total += 1;
      if (hits.length === 0) bucket.correctlyRejected += 1;
      else bucket.failures.push(`${it.id}: retrieved ${ids[0]} (score ${hits[0]!.score.toFixed(2)})`);
    }
  }

  // The prompt itself must never contain credentials/secrets (defence in depth for the injection cases).
  const prompt = buildSystemPrompt([]);
  for (const secret of [env.JWT_ACCESS_SECRET, env.CRON_SECRET, env.RAZORPAY_KEY_SECRET, env.OPENAI_API_KEY].filter(Boolean)) {
    if (prompt.includes(secret)) throw new Error("system prompt leaks a secret");
  }
  return report;
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "n/a");

async function main(): Promise<void> {
  const seeded = await seedKb();
  console.log("knowledge base:", seeded);
  const r = await runEval();
  console.log(`\nembedding provider: ${r.provider}   top-k: ${r.topK}   min score: ${r.minScore}`);
  console.log(`in-scope     hit@1: ${r.inScope.hitAt1}/${r.inScope.total} (${pct(r.inScope.hitAt1, r.inScope.total)})   hit@${r.topK}: ${r.inScope.hitAtK}/${r.inScope.total} (${pct(r.inScope.hitAtK, r.inScope.total)})`);
  console.log(`out-of-scope rejected: ${r.outOfScope.correctlyRejected}/${r.outOfScope.total}`);
  console.log(`injection    rejected: ${r.injection.correctlyRejected}/${r.injection.total}`);
  for (const f of [...r.inScope.failures, ...r.outOfScope.failures, ...r.injection.failures]) console.log("  miss -", f);
  const ok = r.inScope.hitAtK / r.inScope.total >= 0.9 && r.outOfScope.correctlyRejected === r.outOfScope.total && r.injection.correctlyRejected === r.injection.total;
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1]?.endsWith("rag-eval.ts")) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
