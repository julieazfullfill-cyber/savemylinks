import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { channelLabel, CHANNELS } from "@/lib/channels";
import { bizDateStr, daysBetween, fmtBizDate, todayVn } from "@/lib/dates";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { FILING_KINDS, SHOP_STATUS_LABEL, SHOP_STATUSES, TROUBLE, type ShopStatus } from "@/lib/shops";
import { Badge, Field, Flash, PageHead } from "../ui";
import { addFilingAction, changeStatusAction, completeFilingAction, saveShopAction } from "./actions";

const tone = (s: string) => (s === "ACTIVE" ? "good" : (TROUBLE as string[]).includes(s) ? "crit" : "muted");

export default async function ShopsPage({ searchParams }: { searchParams: Promise<{ edit?: string; ok?: string; error?: string }> }) {
  const me = await requireUser(["ADMIN", "QUAN_LY", "KE_TOAN"]);
  const sp = await searchParams;
  const canEdit = me.role === "ADMIN" || me.role === "QUAN_LY";
  const today = todayVn();

  const [shops, entities, accounts, users, filings] = await Promise.all([
    prisma.shop.findMany({ include: { payoutAccount: { include: { provider: true } } }, orderBy: [{ channel: "asc" }, { code: "asc" }] }),
    prisma.legalEntity.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.cashAccount.findMany({ where: { active: true }, include: { provider: true }, orderBy: [{ provider: { name: "asc" } }, { code: "asc" }] }),
    prisma.user.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.entityFiling.findMany({ include: { entity: true }, orderBy: [{ status: "desc" }, { dueDate: "asc" }], take: 100 }),
  ]);
  const entityName = new Map(entities.map((e) => [e.id, `${e.code} · ${e.name}`]));
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const editing = sp.edit === "new" ? null : shops.find((s) => s.id === sp.edit);
  const showForm = canEdit && (sp.edit === "new" || !!editing);
  const missingSetup = shops.filter((s) => !s.entityId || !s.payoutAccountId);

  return (
    <div className="max-w-7xl">
      <PageHead no={16} title="Danh mục shop">
        {canEdit && !showForm && <Link className="btn-primary" href="/shop?edit=new">+ Thêm shop</Link>}
      </PageHead>
      <Flash ok={sp.ok} error={sp.error} />
      {entities.length === 0 && (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm">
          Chưa có pháp nhân nào — shop bắt buộc thuộc một pháp nhân.{" "}
          {me.role === "ADMIN" && <Link className="text-accent hover:underline" href="/danh-muc/phap-nhan?edit=new">Tạo pháp nhân</Link>}
        </p>
      )}
      {missingSetup.length > 0 && (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm">
          ⚠ {missingSetup.length} shop chưa có pháp nhân hoặc tài khoản nhận tiền: {missingSetup.map((s) => s.code).join(", ")} — bấm Sửa để bổ sung.
        </p>
      )}

      {showForm && (
        <form action={saveShopAction.bind(null, editing?.id ?? null)} className="card mt-4 p-5">
          <h2 className="font-bold">{editing ? `Sửa shop ${editing.code}` : "Thêm shop"}</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field name="code" label="Mã shop" required defaultValue={editing?.code} placeholder="AMZ-AU1" />
            <Field name="name" label="Tên" required defaultValue={editing?.name} />
            <Field name="channel" label="Kênh" required empty={false} defaultValue={editing?.channel ?? "AMAZON"} options={CHANNELS.map((c) => ({ value: c.code, label: `${c.label} (TK ${c.revenueAccount})` }))} />
            <Field name="entityId" label="Pháp nhân" required empty="Chọn…" defaultValue={editing?.entityId} options={entities.map((e) => ({ value: e.id, label: `${e.code} · ${e.name}` }))} />
            <div>
              <label className="label" htmlFor="payoutAccountId">Tài khoản nhận tiền<span className="text-crit"> *</span></label>
              <select className="input" id="payoutAccountId" name="payoutAccountId" required defaultValue={editing?.payoutAccountId ?? ""}>
                <option value="">Chọn…</option>
                {[...new Set(accounts.map((a) => a.provider.name))].map((g) => (
                  <optgroup key={g} label={g}>
                    {accounts.filter((a) => a.provider.name === g).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.email ?? a.name} ({a.currency})</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
            <Field name="ownerId" label="Người phụ trách" defaultValue={editing?.ownerId} options={users.map((u) => ({ value: u.id, label: u.name }))} />
            <Field name="openedAt" label="Ngày mở" type="date" defaultValue={editing?.openedAt ? bizDateStr(editing.openedAt) : ""} />
          </div>
          <div className="mt-5 flex gap-2">
            <button className="btn-primary" type="submit">Lưu</button>
            <Link className="btn" href="/shop">Huỷ</Link>
          </div>
          <p className="mt-2 text-xs text-muted">Trạng thái đổi ở bảng bên dưới — mỗi lần đổi được ghi vào lịch sử sức khoẻ shop.</p>
        </form>
      )}

      <div className="card mt-4 overflow-x-auto">
        <table className="tbl">
          <thead><tr><th>Kênh</th><th>Shop</th><th>Pháp nhân</th><th>Tiền về tài khoản</th><th>Phụ trách</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>
            {shops.map((s) => (
              <tr key={s.id}>
                <td>{channelLabel(s.channel)}</td>
                <td><span className="font-mono text-xs">{s.code}</span> · {s.name}{s.openedAt && <div className="text-xs text-muted">mở {fmtBizDate(s.openedAt)}</div>}</td>
                <td>{s.entityId ? entityName.get(s.entityId) : <Badge tone="crit">Thiếu</Badge>}</td>
                <td>{s.payoutAccount ? `${s.payoutAccount.provider.name} · ${s.payoutAccount.email ?? s.payoutAccount.code}` : <Badge tone="crit">Thiếu</Badge>}</td>
                <td>{s.ownerId ? userName.get(s.ownerId) : <span className="text-muted">—</span>}</td>
                <td><Badge tone={tone(s.status)}>{SHOP_STATUS_LABEL[s.status as ShopStatus] ?? s.status}</Badge></td>
                <td className="whitespace-nowrap">
                  {canEdit && (
                    <span className="flex items-start gap-3">
                      <Link className="text-sm text-accent hover:underline" href={`/shop?edit=${s.id}`}>Sửa</Link>
                      <details>
                        <summary className="cursor-pointer text-sm text-accent">Đổi trạng thái</summary>
                        <form action={changeStatusAction.bind(null, s.id)} className="mt-2 grid w-64 gap-2">
                          <select className="input" name="toStatus" required defaultValue="">
                            <option value="">Sang…</option>
                            {SHOP_STATUSES.filter((x) => x !== s.status).map((x) => <option key={x} value={x}>{SHOP_STATUS_LABEL[x]}</option>)}
                          </select>
                          <input className="input" name="at" type="date" defaultValue={bizDateStr(today)} aria-label="Ngày" />
                          <input className="input" name="note" placeholder="Ghi chú (lý do, mã case…)" aria-label="Ghi chú" />
                          <button className="btn-primary" type="submit">Lưu</button>
                        </form>
                      </details>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {!shops.length && <tr><td colSpan={7} className="py-6 text-center text-muted">Chưa có shop nào.</td></tr>}
          </tbody>
        </table>
      </div>

      <section className="mt-6">
        <h2 className="font-bold">Nghĩa vụ pháp nhân</h2>
        <p className="text-sm text-muted">Hạn gia hạn, nộp hồ sơ, thuế. Khoản còn mở có số tiền tự vào dự báo 13 tuần (màn 6).</p>
        <form action={addFilingAction} className="card mt-2 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
          <Field name="entityId" label="Pháp nhân" required empty="Chọn…" options={entities.map((e) => ({ value: e.id, label: `${e.code} · ${e.name}` }))} />
          <Field name="kind" label="Loại" required empty={false} options={Object.entries(FILING_KINDS).map(([value, label]) => ({ value, label }))} />
          <Field name="dueDate" label="Hạn" type="date" required />
          <Field name="amount" label="Số tiền (đ)" inputMode="numeric" />
          <div className="flex items-end"><button className="btn-primary" type="submit">Thêm</button></div>
        </form>
        <div className="card mt-2 overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Hạn</th><th>Pháp nhân</th><th>Loại</th><th className="text-right">Số tiền</th><th>Trạng thái</th><th /></tr></thead>
            <tbody>
              {filings.map((f) => {
                const left = daysBetween(today, f.dueDate);
                const late = f.status !== "DONE" && left < 0;
                return (
                  <tr key={f.id} className={f.status === "DONE" ? "opacity-60" : ""}>
                    <td className="tabular-nums">{fmtBizDate(f.dueDate)}</td>
                    <td>{f.entity.code} · {f.entity.name}</td>
                    <td>{FILING_KINDS[f.kind] ?? f.kind}</td>
                    <td className="text-right tabular-nums">{f.amountVnd ? formatMoney(f.amountVnd) : <span className="text-muted">—</span>}</td>
                    <td>
                      {f.status === "DONE" ? <Badge tone="good">Xong {f.completedAt ? fmtBizDate(f.completedAt) : ""}</Badge>
                        : late ? <Badge tone="crit">Quá hạn {-left} ngày</Badge>
                        : <Badge tone={left <= 30 ? "accent" : "muted"}>Còn {left} ngày</Badge>}
                    </td>
                    <td>{f.status !== "DONE" && <form action={completeFilingAction.bind(null, f.id)}><button className="text-sm text-accent hover:underline" type="submit">Đánh dấu xong</button></form>}</td>
                  </tr>
                );
              })}
              {!filings.length && <tr><td colSpan={6} className="py-6 text-center text-muted">Chưa có nghĩa vụ nào.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
