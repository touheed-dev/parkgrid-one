import { env } from "../../config/env.js";
import { query } from "../../db/pool.js";
import { withTransaction, type Tx } from "../../db/tx.js";
import { AppError } from "../../lib/errors.js";
import { sha256Hex } from "../../lib/tokens.js";
import { approxTokens, chunkDocument } from "./chunker.js";
import { contentTerms, embedTexts, getEmbeddingProvider, toVectorLiteral } from "./embeddings.js";

export interface ChunkInput {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface IngestInput {
  title: string;
  category: string;
  source?: string | null;
  version?: number;
  language?: string;
  status?: "draft" | "published";
  /** Plain text: chunked automatically (~500 tokens, 60 overlap). */
  content?: string;
  /** Pre-split chunks (e.g. one FAQ item per chunk). Used instead of `content` when given. */
  chunks?: ChunkInput[];
  createdBy?: string | null;
}

const CHUNK_SEPARATOR = "\n\n---\n\n";

export interface IngestResult {
  id: string;
  action: "created" | "updated" | "unchanged";
  chunks: number;
}

async function replaceChunks(tx: Tx, documentId: string, chunks: ChunkInput[], vectors: number[][]): Promise<void> {
  await query("delete from kb_chunks where document_id = $1", [documentId], tx);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    await query(
      `insert into kb_chunks (document_id, chunk_index, content, token_count, embedding, metadata)
       values ($1, $2, $3, $4, $5::vector, $6)`,
      [documentId, i, c.content, approxTokens(c.content), toVectorLiteral(vectors[i]!), JSON.stringify(c.metadata ?? {})],
      tx,
    );
  }
}

/**
 * Idempotent ingestion: unchanged content (same SHA-256) is skipped; changed content bumps the
 * version, re-chunks and re-embeds. Embedding happens BEFORE the transaction so no lock is held
 * while waiting on the network.
 */
export async function ingestDocument(input: IngestInput): Promise<IngestResult> {
  const chunks: ChunkInput[] = input.chunks?.length
    ? input.chunks
    : chunkDocument(input.content ?? "").map((content) => ({ content, metadata: { kind: "text" } }));
  if (chunks.length === 0) throw AppError.badRequest("Document has no content", "EMPTY_DOCUMENT");

  const content = input.chunks?.length ? input.chunks.map((c) => c.content).join(CHUNK_SEPARATOR) : (input.content ?? "").trim();
  const hash = sha256Hex(content);

  const existing = await query<{ id: string; content_hash: string; version: number; status: string }>(
    "select id, content_hash, version, status from kb_documents where title = $1",
    [input.title],
  );
  const doc = existing.rows[0];
  if (doc && doc.content_hash === hash) {
    if (input.status && input.status !== doc.status) await query("update kb_documents set status = $2 where id = $1", [doc.id, input.status]);
    const n = await query<{ n: number }>("select count(*)::int as n from kb_chunks where document_id = $1", [doc.id]);
    return { id: doc.id, action: "unchanged", chunks: n.rows[0]?.n ?? 0 };
  }

  const vectors = await embedTexts(chunks.map((c) => c.content));

  return withTransaction(async (tx) => {
    let id: string;
    let action: IngestResult["action"];
    if (doc) {
      id = doc.id;
      action = "updated";
      await query(
        `update kb_documents set category = $2, source = $3, version = $4, language = $5, status = coalesce($6, status),
                content = $7, content_hash = $8 where id = $1`,
        [id, input.category, input.source ?? null, doc.version + 1, input.language ?? "en", input.status ?? null, content, hash],
        tx,
      );
    } else {
      action = "created";
      const ins = await query<{ id: string }>(
        `insert into kb_documents (title, category, source, version, language, status, content, content_hash, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [input.title, input.category, input.source ?? null, input.version ?? 1, input.language ?? "en", input.status ?? "draft", content, hash, input.createdBy ?? null],
        tx,
      );
      id = ins.rows[0]!.id;
    }
    await replaceChunks(tx, id, chunks, vectors);
    return { id, action, chunks: chunks.length };
  });
}

/** Re-embed (and, for plain-text documents, re-chunk) one document. */
export async function reembedDocument(documentId: string): Promise<{ chunks: number }> {
  const d = await query<{ id: string; content: string }>("select id, content from kb_documents where id = $1", [documentId]);
  if (!d.rows[0]) throw AppError.notFound("Document not found", "KB_DOCUMENT_NOT_FOUND");
  const existing = await query<{ content: string; metadata: Record<string, unknown> }>(
    "select content, metadata from kb_chunks where document_id = $1 order by chunk_index",
    [documentId],
  );
  const structured = existing.rows.some((c) => c.metadata?.["kind"] === "faq");
  const chunks: ChunkInput[] = structured
    ? existing.rows.map((c) => ({ content: c.content, metadata: c.metadata }))
    : chunkDocument(d.rows[0].content).map((content) => ({ content, metadata: { kind: "text" } }));
  const vectors = await embedTexts(chunks.map((c) => c.content));
  await withTransaction((tx) => replaceChunks(tx, documentId, chunks, vectors));
  return { chunks: chunks.length };
}

export async function reembedAll(): Promise<{ documents: number; chunks: number }> {
  const docs = await query<{ id: string }>("select id from kb_documents order by created_at");
  let chunks = 0;
  for (const d of docs.rows) chunks += (await reembedDocument(d.id)).chunks;
  return { documents: docs.rows.length, chunks };
}

export interface SearchHit {
  chunk_id: string;
  document_id: string;
  title: string;
  category: string;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
}

/**
 * Cosine-similarity retrieval over PUBLISHED documents only (HNSW index). Hits below `minScore`
 * are dropped: "nothing relevant" must be an honest outcome, not a forced answer.
 */
export async function search(text: string, opts: { topK?: number; minScore?: number; includeBelowThreshold?: boolean } = {}): Promise<SearchHit[]> {
  const topK = opts.topK ?? env.RAG_TOP_K;
  const minScore = opts.minScore ?? env.RAG_MIN_SCORE;
  const [vec] = await embedTexts([text]);
  const offline = getEmbeddingProvider().name === "local";
  const { rows } = await query<SearchHit>(
    `select c.id as chunk_id, c.document_id, d.title, d.category, c.content, c.metadata,
            1 - (c.embedding <=> $1::vector) as score
       from kb_chunks c join kb_documents d on d.id = c.document_id
      where d.status = 'published'
      order by c.embedding <=> $1::vector
      limit $2`,
    [toVectorLiteral(vec!), offline ? Math.max(topK * 4, 20) : topK],
  );
  let hits = rows.map((r) => ({ ...r, score: Number(r.score) }));
  if (offline) {
    // Offline (hashed bag-of-words) vectors dilute on long chunks, so blend in how many of the
    // question's content terms the chunk actually contains. Real embeddings use pure cosine.
    const q = contentTerms(text);
    hits = hits
      .map((h) => {
        const terms = contentTerms(h.content);
        const covered = q.size ? [...q].filter((t) => terms.has(t)).length / q.size : 0;
        return { ...h, score: 0.5 * h.score + 0.5 * covered };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
  return opts.includeBelowThreshold ? hits : hits.filter((h) => h.score >= minScore);
}

export async function listDocuments() {
  const { rows } = await query(
    `select d.id, d.title, d.category, d.source, d.version, d.language, d.status, d.created_at, d.updated_at,
            length(d.content) as size_chars, (select count(*)::int from kb_chunks c where c.document_id = d.id) as chunk_count
       from kb_documents d order by d.category, d.title`,
  );
  return rows;
}

export async function getStatus() {
  const { rows } = await query<Record<string, number>>(
    `select (select count(*) from kb_documents)::int as documents,
            (select count(*) from kb_documents where status = 'published')::int as published_documents,
            (select count(*) from kb_chunks)::int as chunks,
            (select count(*) from kb_chunks where embedding is not null)::int as embedded_chunks`,
  );
  const r = rows[0]!;
  return {
    ...r,
    vectorDimension: env.EMBEDDING_DIM,
    embeddingProvider: getEmbeddingProvider().name,
    embeddingModel: getEmbeddingProvider().name === "openai" ? env.EMBEDDING_MODEL : "local-hashing",
    status: r["chunks"] === r["embedded_chunks"] && r["chunks"]! > 0 ? "OPERATIONAL" : "NEEDS_ATTENTION",
  };
}
