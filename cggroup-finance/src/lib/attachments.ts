// Chứng từ đính kèm (đặc tả GĐ1 tuần 2). Lưu file trên đĩa (UPLOAD_DIR, mặc định ./uploads);
// đặc tả nói Supabase Storage — khi deploy chỉ cần thay `store()` / `read()`.
import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { audit } from "./audit";
import type { Tx } from "./db";

export const MAX_BYTES = 10 * 1024 * 1024;
export const ALLOWED: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const root = () => path.resolve(process.env.UPLOAD_DIR ?? "uploads");

/** Kiểm tra file trước khi lưu. Trả null nếu không có file (ô chọn file để trống). */
export function checkFile(f: FormDataEntryValue | null): File | null {
  if (!f || typeof f === "string" || f.size === 0) return null;
  if (f.size > MAX_BYTES) throw new Error("Chứng từ tối đa 10MB");
  if (!ALLOWED[f.type]) throw new Error("Chỉ nhận PDF, PNG, JPG, WEBP");
  return f;
}

export async function saveAttachment(tx: Tx, p: { file: File; tableName: string; recordId: string; actorId: string }) {
  const month = new Date().toISOString().slice(0, 7);
  const rel = `${month}/${randomUUID()}.${ALLOWED[p.file.type]}`;
  const abs = path.join(root(), rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, Buffer.from(await p.file.arrayBuffer()));
  const att = await tx.attachment.create({
    data: {
      url: rel,
      filename: p.file.name.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120) || `chung-tu.${ALLOWED[p.file.type]}`,
      tableName: p.tableName,
      recordId: p.recordId,
      uploadedBy: p.actorId,
    },
  });
  await audit(tx, { actorId: p.actorId, tableName: "Attachment", recordId: att.id, action: "CREATE", after: att });
  return att;
}

/** Đọc file của chứng từ; chặn đường dẫn thoát khỏi thư mục lưu. */
export async function readAttachment(url: string): Promise<Buffer> {
  const abs = path.resolve(root(), url);
  if (!abs.startsWith(root() + path.sep)) throw new Error("Đường dẫn chứng từ không hợp lệ");
  return readFile(abs);
}

export const mimeOf = (url: string) => Object.entries(ALLOWED).find(([, ext]) => url.endsWith(`.${ext}`))?.[0] ?? "application/octet-stream";
