import type { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { bizDateStr, fmtBizDate, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { Field, Flash, PageHead } from "../ui";
import { addPrice, saveTerms } from "./actions";

const usd = (v: number) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Màn 19 — Nhà cung cấp & bảng giá theo thời kỳ, so sánh giá giữa các NCC. */
export default async function SuppliersPage({ searchParams }: { searchParams: Promise<{ sup?: string; sku?: string; ok?: string; error?: string }> }) {
  await requireUser(["ADMIN", "QUAN_LY", "KE_TOAN"]);
  const sp = await searchParams;
  const today = todayVn();
  const historyWhere: Prisma.SupplierPriceWhereInput = {
    ...(sp.sup ? { supplierId: sp.sup } : {}),
    ...(sp.sku ? { sku: { contains: sp.sku.trim().toUpperCase() } } : {}),
  };

  const [suppliers, current, history, ffStats] = await Promise.all([
    prisma.supplier.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.supplierPrice.findMany({ where: { effectiveFrom: { lte: today }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }] }, include: { supplier: true } }),
    prisma.supplierPrice.findMany({ where: historyWhere, include: { supplier: true }, orderBy: [{ sku: "asc" }, { effectiveFrom: "desc" }], take: 200 }),
    prisma.fulfillmentOrder.groupBy({ by: ["supplierId"], _count: true, _sum: { costUsd: true, listedCostUsd: true } }),
  ]);
  const statBy = new Map(ffStats.map((s) => [s.supplierId, s]));

  // So sánh: SKU × NCC, giá hiện hành
  const skus = [...new Set(current.map((p) => p.sku))].sort();
  const priced = [...new Set(current.map((p) => p.supplierId))];
  const priceAt = new Map(current.map((p) => [`${p.sku}|${p.supplierId}`, Number(p.priceUsd)]));
  const supName = new Map(suppliers.map((s) => [s.id, s.name]));

  return (
    <div className="max-w-7xl">
      <PageHead no={19} title="Nhà cung cấp & bảng giá" />
      <Flash ok={sp.ok} error={sp.error} />

      <section className="mt-4">
        <h2 className="font-bold">Điều khoản thanh toán</h2>
        <p className="text-sm text-muted">Trả trước hay công nợ bao nhiêu ngày — chạy thẳng vào dự báo dòng tiền và hạn trả hoá đơn.</p>
        <div className="card mt-2 overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>NCC</th><th>Dịch vụ</th><th>Điều khoản</th><th className="text-right">Đơn fulfill</th><th className="text-right">Thực trả / bảng giá</th></tr></thead>
            <tbody>
              {suppliers.map((s) => {
                const st = statBy.get(s.id);
                const listed = Number(st?._sum.listedCostUsd ?? 0);
                const actual = Number(st?._sum.costUsd ?? 0);
                const variance = listed > 0 ? (actual - listed) / listed : null;
                return (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td className="text-xs text-muted">{s.service ?? ""}</td>
                    <td>
                      <form action={saveTerms.bind(null, s.id)} className="flex items-center gap-2 text-sm">
                        <label className="flex items-center gap-1"><input type="checkbox" name="prepaid" defaultChecked={s.prepaid} /> Trả trước</label>
                        <span className="text-muted">hoặc nợ</span>
                        <input className="input w-16" name="creditDays" type="number" min={0} max={365} defaultValue={s.creditDays} aria-label={`Số ngày công nợ ${s.name}`} />
                        <span className="text-muted">ngày</span>
                        <button className="btn" type="submit">Lưu</button>
                      </form>
                    </td>
                    <td className="text-right tabular-nums">{st?._count ?? 0}</td>
                    <td className={`text-right tabular-nums ${variance !== null && variance > 0.05 ? "font-semibold text-crit" : ""}`}>
                      {variance === null ? <span className="text-muted">—</span> : `${variance > 0 ? "+" : ""}${(variance * 100).toFixed(1)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-[360px_1fr]">
        <form action={addPrice} className="card space-y-3 p-5">
          <h2 className="font-bold">Thêm giá</h2>
          <Field name="supplierId" label="NCC" required empty="Chọn…" options={suppliers.map((s) => ({ value: s.id, label: s.name }))} />
          <Field name="sku" label="SKU" required placeholder="ORN-XMAS-01" />
          <Field name="priceUsd" label="Giá (USD)" required inputMode="decimal" placeholder="8.50" />
          <Field name="effectiveFrom" label="Hiệu lực từ" type="date" required defaultValue={bizDateStr(today)} />
          <button className="btn-primary" type="submit">Thêm</button>
          <p className="text-xs text-muted">Giá mới = bản ghi mới, giá cũ cùng NCC + SKU tự đóng — tra được giá của bất kỳ ngày nào.</p>
        </form>

        <div className="card overflow-x-auto p-5">
          <h2 className="font-bold">So sánh giá hiện hành</h2>
          {skus.length === 0 ? (
            <p className="mt-2 text-sm text-muted">Chưa có bảng giá.</p>
          ) : (
            <table className="tbl mt-2">
              <thead><tr><th>SKU</th>{priced.map((id) => <th key={id} className="text-right">{supName.get(id) ?? "?"}</th>)}</tr></thead>
              <tbody>
                {skus.map((sku) => {
                  const vals = priced.map((id) => priceAt.get(`${sku}|${id}`)).filter((v): v is number => v !== undefined);
                  const min = Math.min(...vals);
                  return (
                    <tr key={sku}>
                      <td className="font-mono text-xs">{sku}</td>
                      {priced.map((id) => {
                        const v = priceAt.get(`${sku}|${id}`);
                        return (
                          <td key={id} className={`text-right tabular-nums ${v !== undefined && v === min && vals.length > 1 ? "font-semibold text-good" : ""}`}>
                            {v === undefined ? <span className="text-muted">—</span> : <>{usd(v)}{v === min && vals.length > 1 && " ✓"}</>}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-xs text-muted">✓ = rẻ nhất cho SKU đó.</p>
        </div>
      </section>

      <section className="mt-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="font-bold">Lịch sử bảng giá</h2>
          <form method="get" className="flex items-end gap-2">
            <Field name="sup" label="NCC" empty="Tất cả" defaultValue={sp.sup} options={suppliers.map((s) => ({ value: s.id, label: s.name }))} />
            <Field name="sku" label="SKU" defaultValue={sp.sku} />
            <button className="btn" type="submit">Lọc</button>
          </form>
        </div>
        <div className="card mt-2 overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>NCC</th><th>SKU</th><th className="text-right">Giá</th><th>Hiệu lực</th></tr></thead>
            <tbody>
              {history.map((p) => (
                <tr key={p.id}>
                  <td>{p.supplier.name}</td>
                  <td className="font-mono text-xs">{p.sku}</td>
                  <td className="text-right tabular-nums">{usd(Number(p.priceUsd))}</td>
                  <td className="tabular-nums">{fmtBizDate(p.effectiveFrom)} → {p.effectiveTo ? fmtBizDate(p.effectiveTo) : "nay"}</td>
                </tr>
              ))}
              {!history.length && <tr><td colSpan={4} className="py-6 text-center text-muted">Chưa có giá nào.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
