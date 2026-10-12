import { toJsonSafe, type Tx } from "./db";

export type AuditAction = "CREATE" | "UPDATE" | "VOID";

/** Ghi một dòng AuditLog trong cùng transaction với thay đổi. Bảng chỉ ghi thêm (trigger DB). */
export async function audit(
  tx: Tx,
  p: { actorId: string; tableName: string; recordId: string; action: AuditAction; before?: unknown; after?: unknown },
) {
  await tx.auditLog.create({
    data: {
      actorId: p.actorId,
      tableName: p.tableName,
      recordId: p.recordId,
      action: p.action,
      before: p.before === undefined ? undefined : (toJsonSafe(p.before) as object),
      after: p.after === undefined ? undefined : (toJsonSafe(p.after) as object),
    },
  });
}
