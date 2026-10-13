"use client";

import { useActionState } from "react";
import { runFulfillImport, runOrderImport, type FulfillImportState, type OrderImportState } from "./actions";

const usd = (v: number) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const FIELD_VI: Record<string, string> = {
  externalId: "Mã đơn",
  orderedAt: "Ngày đặt",
  country: "Quốc gia",
  grossUsd: "Doanh thu",
  discountUsd: "Giảm giá",
  shippingChargedUsd: "Phí ship thu khách",
  platformFeeUsd: "Phí sàn",
  taxUsd: "Thuế",
  sku: "SKU",
  qty: "Số lượng",
};

function Source({ placeholder }: { placeholder: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
      <div>
        <label className="label" htmlFor="file">File CSV</label>
        <input className="text-sm" id="file" name="file" type="file" accept=".csv,.tsv,.txt,text/csv" />
        <p className="mt-1 text-xs text-muted">Hoặc dán nội dung vào ô bên cạnh.</p>
      </div>
      <div>
        <label className="label" htmlFor="data">Nội dung (gồm dòng tiêu đề)</label>
        <textarea className="input h-32 font-mono text-xs" id="data" name="data" placeholder={placeholder} />
      </div>
    </div>
  );
}

export function OrderImportForm({ shops }: { shops: { id: string; label: string }[] }) {
  const [s, action, pending] = useActionState<OrderImportState, FormData>(runOrderImport, null);
  return (
    <div>
      <form action={action} className="card space-y-4 p-5">
        <div className="max-w-sm">
          <label className="label" htmlFor="shopId">Shop<span className="text-crit"> *</span></label>
          <select className="input" id="shopId" name="shopId" required defaultValue="">
            <option value="">Chọn shop…</option>
            {shops.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
          <p className="mt-1 text-xs text-muted">Mỗi file là đơn của một shop — bảng ánh xạ cột theo kênh của shop.</p>
        </div>
        <Source placeholder={"Sale Date,Order ID,Ship Country,Order Value,Shipping,Card Processing Fees,Sales Tax,SKU,Quantity\n11/03/2026,3412887001,US,$42.95,$0.00,$2.18,$3.44,ORN-XMAS-01,2"} />
        <div className="flex gap-2">
          <button className="btn" type="submit" name="mode" value="preview" disabled={pending}>{pending ? "Đang đọc…" : "Xem trước"}</button>
          <button className="btn-primary" type="submit" name="mode" value="commit" disabled={pending}>Xác nhận nạp</button>
        </div>
      </form>

      {s?.error && <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-crit">{s.error}</p>}
      {s?.orders && (
        <section className="mt-4 space-y-3">
          <div className="card p-4 text-sm">
            <div className="font-semibold">
              {s.mode === "commit" ? "Đã nạp" : "Xem trước"} — {s.shop} · {s.filename}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-5 text-ink-2">
              <span>{s.rowCount} dòng → <strong>{s.orderCount}</strong> đơn</span>
              <span>Doanh thu ròng {usd(s.totalNetUsd ?? 0)}</span>
              <span className={s.errors?.length ? "text-crit" : ""}>{s.errors?.length ?? 0} cảnh báo</span>
              {s.mode === "commit" && <span className="text-good">{s.created} đơn mới · {s.skipped?.length ?? 0} đơn đã có (bỏ qua)</span>}
            </div>
            <div className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
              {Object.entries(FIELD_VI).map(([f, vi]) => (
                <div key={f}>
                  {vi}:{" "}
                  {s.matchedColumns?.[f] ? <code>{s.matchedColumns[f]}</code> : <span className="font-semibold text-crit">không tìm thấy cột</span>}
                </div>
              ))}
            </div>
            {!!s.missingColumns?.length && (
              <p className="mt-2 text-xs text-ink-2">
                Cột thiếu được tính là 0. Nếu file có cột đó dưới tên khác, thêm tên vào <code>COLUMN_MAPS</code> trong <code>src/lib/order-import.ts</code>.
              </p>
            )}
          </div>
          {!!s.errors?.length && (
            <div className="card max-h-60 overflow-auto">
              <table className="tbl text-xs">
                <thead><tr><th>Dòng</th><th>Trường</th><th>Vấn đề</th><th>Giá trị</th></tr></thead>
                <tbody>{s.errors.map((e, i) => <tr key={i}><td>{e.row}</td><td>{FIELD_VI[e.field] ?? e.field}</td><td className="text-crit">{e.message}</td><td>{e.raw}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          <div className="card max-h-96 overflow-auto">
            <table className="tbl text-xs">
              <thead><tr><th>Mã đơn</th><th>Ngày</th><th className="text-right">Doanh thu</th><th className="text-right">Ròng</th><th>Mặt hàng</th></tr></thead>
              <tbody>
                {s.orders.map((o) => (
                  <tr key={o.externalId}>
                    <td className="font-mono">{o.externalId}</td>
                    <td>{o.orderedAt}</td>
                    <td className="text-right tabular-nums">{usd(o.grossUsd)}</td>
                    <td className="text-right tabular-nums">{usd(o.netUsd)}</td>
                    <td>{o.items.map((i) => `${i.sku}×${i.qty}`).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(s.orderCount ?? 0) > s.orders.length && <p className="p-2 text-xs text-muted">Hiển thị 50 đơn đầu.</p>}
          </div>
        </section>
      )}
    </div>
  );
}

export function FulfillImportForm() {
  const [s, action, pending] = useActionState<FulfillImportState, FormData>(runFulfillImport, null);
  const n = (k: string) => s?.results?.filter((r) => r.status === k).length ?? 0;
  return (
    <div>
      <form action={action} className="card space-y-4 p-5">
        <Source placeholder={"shopCode,orderId,supplierCode,sku,externalId,submittedAt,costUsd,shipUsd,trackingNo\nET-01,3412887001,MERCHIZE,ORN-XMAS-01,MZ-55012,2026-11-03,16.40,4.20,"} />
        <button className="btn-primary" type="submit" disabled={pending}>{pending ? "Đang nạp…" : "Nạp đơn fulfill"}</button>
      </form>
      {s?.error && <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-crit">{s.error}</p>}
      {s?.results && (
        <div className="card mt-3 max-h-72 overflow-auto">
          <p className="p-3 text-sm"><span className="text-good">{n("ok")} ghép</span> · <span className="text-muted">{n("skip")} bỏ qua</span> · <span className="text-crit">{n("error")} lỗi</span></p>
          <table className="tbl text-xs">
            <tbody>{s.results.map((r) => <tr key={r.line}><td>Dòng {r.line}</td><td className={r.status === "error" ? "text-crit" : r.status === "ok" ? "text-good" : "text-muted"}>{r.message}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
