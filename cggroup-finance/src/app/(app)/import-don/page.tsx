import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { channelLabel } from "@/lib/channels";
import { fmtTimestamp } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { PageHead } from "../ui";
import { FulfillImportForm, OrderImportForm } from "./forms";

/** Màn 20 — import đơn hàng từ CSV của sàn, xem trước, lỗi theo dòng, xác nhận nạp. */
export default async function OrderImportPage() {
  await requireUser(["ADMIN", "KE_TOAN"]);
  const [shops, batches] = await Promise.all([
    prisma.shop.findMany({ where: { status: { not: "CLOSED" } }, orderBy: [{ channel: "asc" }, { code: "asc" }] }),
    prisma.importBatch.findMany({ orderBy: { importedAt: "desc" }, take: 15, include: { _count: { select: { orders: true } } } }),
  ]);

  return (
    <div className="max-w-6xl">
      <PageHead no={20} title="Import đơn hàng" />
      <p className="mt-2 max-w-3xl text-sm text-ink-2">
        Tải báo cáo đơn hàng của sàn (Etsy, Amazon, Walmart, TikTok Shop, Website). Mỗi trường khai nhiều tên cột khả dĩ — sàn đổi tên cột thì chỉ cần
        thêm tên mới. Đơn nhiều dòng sản phẩm được gộp thành một đơn nhiều mặt hàng. Một mã đơn trên một shop chỉ nạp một lần.
      </p>
      {shops.length === 0 ? (
        <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm">Chưa có shop — tạo ở <Link className="text-accent hover:underline" href="/shop">màn 16</Link>.</p>
      ) : (
        <div className="mt-4">
          <OrderImportForm shops={shops.map((s) => ({ id: s.id, label: `${channelLabel(s.channel)} · ${s.code} — ${s.name}` }))} />
        </div>
      )}

      <section className="mt-8">
        <h2 className="font-bold">Nạp đơn fulfill từ nhà cung cấp</h2>
        <p className="mb-3 text-sm text-muted">
          Ghép đơn bán với đơn fulfill để giá vốn vào biên lãi. Giá bảng giá tại ngày đặt được lưu kèm để bắt giá thực trả vượt bảng giá.
          Ghép từng đơn bằng tay ở <Link className="text-accent hover:underline" href="/don-hang">màn 21</Link>.
        </p>
        <FulfillImportForm />
      </section>

      <section className="mt-8">
        <h2 className="font-bold">Các lần nạp gần đây</h2>
        <div className="card mt-2 overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Lúc</th><th>Kênh</th><th>File</th><th className="text-right">Dòng</th><th className="text-right">Đơn nạp</th><th className="text-right">Cảnh báo</th></tr></thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td className="whitespace-nowrap">{fmtTimestamp(b.importedAt)}</td>
                  <td>{channelLabel(b.channel)}</td>
                  <td>{b.filename}</td>
                  <td className="text-right tabular-nums">{b.rowCount}</td>
                  <td className="text-right tabular-nums">{b._count.orders}</td>
                  <td className={`text-right tabular-nums ${b.errorCount ? "text-crit" : ""}`}>{b.errorCount}</td>
                </tr>
              ))}
              {!batches.length && <tr><td colSpan={6} className="py-6 text-center text-muted">Chưa nạp lần nào.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
