/**
 * One-off converter: frontend FAQ_DATABASE -> backend/seeds/kb/*.json (no hand copying).
 *   npx tsx scripts/build-kb-seed.ts
 * Items are grouped by their source `document`; each FAQ item becomes ONE chunk (question +
 * answer + category + keywords). Live numbers that used to be hard-coded in answers are removed:
 * live data now comes from the database through chat tools.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { FAQ_DATABASE } from "../../frontend/src/lib/faq-rag-data.ts";

const SANITIZE: [RegExp | string, string][] = [
  [
    "Live capacity typically shows 73 available, 62 occupied, and 15 reserved spaces. ",
    "Live availability by floor and zone is shown on the interactive Parking map. ",
  ],
];

function clean(text: string): string {
  let out = text;
  for (const [from, to] of SANITIZE) out = out.replace(from, to);
  return out;
}

interface SeedItem {
  faq_id: string;
  category: string;
  subcategory: string;
  question: string;
  answer: string;
  keywords: string[];
  source: string;
}
interface SeedDocument {
  title: string;
  category: string;
  source: string;
  version: string;
  items: SeedItem[];
}

const docs = new Map<string, SeedDocument>();
for (const f of FAQ_DATABASE) {
  const doc = docs.get(f.document) ?? { title: f.document, category: f.category, source: f.source, version: f.version, items: [] };
  doc.items.push({
    faq_id: f.id,
    category: f.category,
    subcategory: f.subcategory,
    question: f.question,
    answer: clean(f.answer),
    keywords: f.keywords,
    source: f.source,
  });
  docs.set(f.document, doc);
}

mkdirSync("seeds/kb", { recursive: true });
writeFileSync("seeds/kb/documents.json", JSON.stringify([...docs.values()], null, 2) + "\n");
console.log(`wrote ${docs.size} documents, ${FAQ_DATABASE.length} FAQ chunks`);
