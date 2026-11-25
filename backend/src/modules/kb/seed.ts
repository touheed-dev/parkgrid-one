import { readFileSync } from "node:fs";
import { faqToChunk } from "./chunker.js";
import { ingestDocument } from "./service.js";

interface SeedItem {
  faq_id: string;
  category: string;
  subcategory: string;
  question: string;
  answer: string;
  keywords: string[];
}
interface SeedDoc {
  title: string;
  category: string;
  source: string;
  version: string;
  items: SeedItem[];
}

/** Idempotent: unchanged documents are skipped (SHA-256 of content). */
export async function seedKb(file = "seeds/kb/documents.json"): Promise<{ created: number; updated: number; unchanged: number; chunks: number }> {
  const docs = JSON.parse(readFileSync(file, "utf8")) as SeedDoc[];
  const out = { created: 0, updated: 0, unchanged: 0, chunks: 0 };
  for (const d of docs) {
    const r = await ingestDocument({
      title: d.title,
      category: d.category,
      source: d.source,
      status: "published",
      chunks: d.items.map(faqToChunk),
    });
    out[r.action] += 1;
    out.chunks += r.chunks;
  }
  return out;
}
