import type { Queryable } from "../../db/pool.js";
import { query } from "../../db/pool.js";

/** Every mutating admin action is recorded: who, what, why, before/after. */
export async function writeAudit(
  db: Queryable,
  entry: {
    actorId: string;
    action: string;
    recordType: string;
    recordId: string;
    reason?: string;
    oldData?: unknown;
    newData?: unknown;
  },
): Promise<void> {
  await query(
    `insert into admin_audit_log (actor_id, action, record_type, record_id, reason, old_data, new_data)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.actorId,
      entry.action,
      entry.recordType,
      entry.recordId,
      entry.reason ?? "",
      entry.oldData === undefined ? null : JSON.stringify(entry.oldData),
      entry.newData === undefined ? null : JSON.stringify(entry.newData),
    ],
    db,
  );
}
