import { Router } from "express";
import { z } from "zod";
import { pool, query } from "../../db/pool.js";
import { AppError } from "../../lib/errors.js";
import { me, requireAdmin, requireAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { writeAudit } from "../admin/audit.js";
import * as service from "./service.js";

/** Admin knowledge-base management (backs the admin "RAG Knowledge Base" page). Audit-logged. */
export const kbRouter: Router = Router();
kbRouter.use(requireAuth, requireAdmin);

const idParams = z.object({ id: z.uuid() });
const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
const audit = (req: Parameters<typeof me>[0], action: string, id: string, extra: object = {}) =>
  writeAudit(pool, { actorId: me(req).id, action, recordType: "kb_document", recordId: id, newData: extra });

kbRouter.get("/status", async (_req, res) => {
  res.json({ status: await service.getStatus() });
});

kbRouter.get("/documents", async (_req, res) => {
  res.json({ documents: await service.listDocuments() });
});

const createBody = z.strictObject({
  title: z.string().trim().min(3).max(150),
  category: z.string().trim().min(2).max(50),
  source: z.string().trim().max(200).nullish(),
  language: z.string().trim().min(2).max(10).default("en"),
  status: z.enum(["draft", "published"]).default("draft"),
  content: z.string().trim().min(20, "Content must be at least 20 characters").max(200_000),
});
kbRouter.post("/documents", validate({ body: createBody }), async (req, res) => {
  const result = await service.ingestDocument({ ...req.body, createdBy: me(req).id });
  await audit(req, "kb_create_document", result.id, { title: req.body.title, status: req.body.status });
  res.status(result.action === "created" ? 201 : 200).json(result);
});

const updateBody = z.strictObject({
  title: z.string().trim().min(3).max(150).optional(),
  category: z.string().trim().min(2).max(50).optional(),
  source: z.string().trim().max(200).nullish(),
  status: z.enum(["draft", "published"]).optional(),
  content: z.string().trim().min(20).max(200_000).optional(),
});
kbRouter.patch("/documents/:id", validate({ params: idParams, body: updateBody }), async (req, res) => {
  const id = idOf(req);
  const cur = await query<{ title: string; category: string; source: string | null; content: string; language: string; status: "draft" | "published" }>(
    "select title, category, source, content, language, status from kb_documents where id = $1",
    [id],
  );
  const doc = cur.rows[0];
  if (!doc) throw AppError.notFound("Document not found", "KB_DOCUMENT_NOT_FOUND");
  const b = req.body as z.infer<typeof updateBody>;

  if (b.content !== undefined || b.title !== undefined) {
    // Content or title changed: re-chunk + re-embed through the idempotent ingest path.
    await query("update kb_documents set title = $2 where id = $1", [id, b.title ?? doc.title]);
    const result = await service.ingestDocument({
      title: b.title ?? doc.title, category: b.category ?? doc.category, source: b.source ?? doc.source,
      language: doc.language, status: b.status ?? doc.status, content: b.content ?? doc.content,
    });
    await audit(req, "kb_update_document", result.id, { fields: Object.keys(b) });
    res.json(result);
    return;
  }
  await query(
    "update kb_documents set category = coalesce($2, category), source = coalesce($3, source), status = coalesce($4, status) where id = $1",
    [id, b.category ?? null, b.source ?? null, b.status ?? null],
  );
  await audit(req, "kb_update_document", id, { fields: Object.keys(b) });
  res.json({ id, action: "updated" });
});

kbRouter.post("/documents/:id/reembed", validate({ params: idParams }), async (req, res) => {
  const out = await service.reembedDocument(idOf(req));
  await audit(req, "kb_reembed_document", idOf(req), out);
  res.json(out);
});

kbRouter.delete("/documents/:id", validate({ params: idParams }), async (req, res) => {
  const r = await query("delete from kb_documents where id = $1", [idOf(req)]);
  if (!r.rowCount) throw AppError.notFound("Document not found", "KB_DOCUMENT_NOT_FOUND");
  await audit(req, "kb_delete_document", idOf(req));
  res.json({ success: true });
});

kbRouter.get("/documents/:id/chunks", validate({ params: idParams }), async (req, res) => {
  const { rows } = await query(
    "select id, chunk_index, content, token_count, metadata, (embedding is not null) as embedded from kb_chunks where document_id = $1 order by chunk_index",
    [idOf(req)],
  );
  res.json({ chunks: rows });
});

// "Test query": exactly what the assistant would retrieve, with scores (below-threshold hits flagged).
const testBody = z.strictObject({ query: z.string().trim().min(2).max(500), topK: z.number().int().min(1).max(20).optional() });
kbRouter.post("/search", validate({ body: testBody }), async (req, res) => {
  const hits = await service.search(req.body.query, { topK: req.body.topK ?? 5, includeBelowThreshold: true });
  const { env } = await import("../../config/env.js");
  res.json({
    minScore: env.RAG_MIN_SCORE,
    results: hits.map((h) => ({ ...h, score: Math.round(h.score * 1000) / 1000, accepted: h.score >= env.RAG_MIN_SCORE })),
  });
});
