import { Router } from "express";
import { z } from "zod";
import { query } from "../../db/pool.js";
import { me, requireAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";

export const notificationsRouter: Router = Router();
notificationsRouter.use(requireAuth);

const listQuery = z.object({
  filter: z.enum(["all", "unread"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

// Every query is scoped to the caller: WHERE user_id = $me. There is no way to touch another user's rows.
notificationsRouter.get("/", validate({ query: listQuery }), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof listQuery>;
  const userId = me(req).id;
  const unreadOnly = q.filter === "unread" ? "and is_read = false" : "";
  const [rows, count] = await Promise.all([
    query(
      `select * from notifications where user_id = $1 ${unreadOnly}
        order by created_at desc limit $2 offset $3`,
      [userId, q.pageSize, (q.page - 1) * q.pageSize],
    ),
    query<{ n: number }>(`select count(*)::int as n from notifications where user_id = $1 ${unreadOnly}`, [userId]),
  ]);
  const totalCount = count.rows[0]?.n ?? 0;
  res.json({
    notifications: rows.rows,
    totalCount,
    page: q.page,
    pageSize: q.pageSize,
    totalPages: Math.max(1, Math.ceil(totalCount / q.pageSize)),
  });
});

notificationsRouter.get("/unread-count", async (req, res) => {
  const { rows } = await query<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and is_read = false", [me(req).id]);
  res.json({ count: rows[0]?.n ?? 0 });
});

const markBody = z.strictObject({ ids: z.array(z.uuid()).min(1).max(100) });
notificationsRouter.post("/mark-read", validate({ body: markBody }), async (req, res) => {
  const r = await query(
    "update notifications set is_read = true, read = true where user_id = $1 and id = any($2::uuid[]) and is_read = false",
    [me(req).id, req.body.ids],
  );
  res.json({ success: true, count: r.rowCount ?? 0 });
});

notificationsRouter.post("/mark-all-read", async (req, res) => {
  const r = await query("update notifications set is_read = true, read = true where user_id = $1 and is_read = false", [me(req).id]);
  res.json({ success: true, count: r.rowCount ?? 0 });
});

notificationsRouter.delete("/:id", validate({ params: z.object({ id: z.uuid() }) }), async (req, res) => {
  await query("delete from notifications where id = $1 and user_id = $2", [(req.params as unknown as { id: string }).id, me(req).id]);
  res.json({ success: true });
});
