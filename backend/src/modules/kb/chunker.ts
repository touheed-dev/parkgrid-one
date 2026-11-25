/** ~4 characters per token for English prose (good enough for sizing; exact counts are not needed). */
export const approxTokens = (text: string): number => Math.ceil(text.length / 4);

export interface ChunkOptions {
  maxTokens?: number;
  overlapTokens?: number;
}

/**
 * Split a long document into ~500-token chunks with ~60 tokens of overlap, preferring heading and
 * paragraph boundaries so a chunk never cuts a sentence in the middle when avoidable.
 */
export function chunkDocument(text: string, opts: ChunkOptions = {}): string[] {
  const maxChars = (opts.maxTokens ?? 500) * 4;
  const overlapChars = (opts.overlapTokens ?? 60) * 4;
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  // paragraphs; very long ones are split further on sentence ends
  const units: string[] = [];
  for (const para of clean.split(/\n{2,}/)) {
    if (para.length <= maxChars) {
      units.push(para.trim());
      continue;
    }
    let buf = "";
    for (const sentence of para.split(/(?<=[.!?])\s+/)) {
      if ((buf + " " + sentence).length > maxChars && buf) {
        units.push(buf.trim());
        buf = sentence;
      } else {
        buf = buf ? `${buf} ${sentence}` : sentence;
      }
    }
    if (buf.trim()) units.push(buf.trim());
  }

  const chunks: string[] = [];
  let current = "";
  for (const unit of units.filter(Boolean)) {
    if (current && (current + "\n\n" + unit).length > maxChars) {
      chunks.push(current);
      const tail = current.slice(-overlapChars);
      const wordStart = tail.indexOf(" ");
      current = (wordStart >= 0 ? tail.slice(wordStart + 1) : tail) + "\n\n" + unit;
    } else {
      current = current ? `${current}\n\n${unit}` : unit;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export interface FaqItem {
  faq_id: string;
  category: string;
  subcategory: string;
  question: string;
  answer: string;
  keywords: string[];
}

/** One FAQ item = one chunk (question + answer + category + keywords). */
export function faqToChunk(item: FaqItem): { content: string; metadata: Record<string, unknown> } {
  return {
    content: `Q: ${item.question}\nA: ${item.answer}\nCategory: ${item.category} / ${item.subcategory}\nKeywords: ${item.keywords.join(", ")}`,
    metadata: { faq_id: item.faq_id, category: item.category, subcategory: item.subcategory, kind: "faq" },
  };
}
