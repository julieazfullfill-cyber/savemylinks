import { NextResponse } from "next/server";
import { mimeOf, readAttachment } from "@/lib/attachments";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/** Mở chứng từ — cùng quyền với Sổ quỹ (middleware đã chặn theo đường dẫn /so-quy, kiểm lại ở đây). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s || (s.role !== "ADMIN" && s.role !== "KE_TOAN")) return new NextResponse("Không đủ quyền", { status: 403 });
  const { id } = await params;
  const att = await prisma.attachment.findUnique({ where: { id } });
  if (!att) return new NextResponse("Không tìm thấy chứng từ", { status: 404 });
  try {
    const body = await readAttachment(att.url);
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": mimeOf(att.url),
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new NextResponse("File chứng từ không còn trên máy chủ", { status: 410 });
  }
}
