"use client";

import Link from "next/link";
import { useState } from "react";
import { KIND_LABEL, type TxnKind } from "@/lib/cashbook-forms";

type Opt = { value: string; label: string };
type ShopOpt = { id: string; code: string; name: string; channel: string };

/** Form nhập giao dịch — trường hiện theo loại; "Thu từ shop" chọn kênh rồi shop của kênh đó. */
export function EntryForm({
  action,
  accounts,
  categories,
  suppliers,
  shops,
  channels,
  today,
  defaultAccount,
  fxPlaceholder,
}: {
  action: (form: FormData) => void | Promise<void>;
  accounts: Opt[];
  categories: Opt[];
  suppliers: Opt[];
  shops: ShopOpt[];
  channels: Opt[];
  today: string;
  defaultAccount?: string;
  fxPlaceholder: string;
}) {
  const [kind, setKind] = useState<TxnKind>("SHOP_IN");
  const [channel, setChannel] = useState(channels[0]?.value ?? "");
  const channelShops = shops.filter((s) => s.channel === channel);

  const select = (name: string, label: string, opts: Opt[], o: { required?: boolean; empty?: string; help?: string } = {}) => (
    <div>
      <label className="label" htmlFor={name}>
        {label}
        {o.required && <span className="text-crit"> *</span>}
      </label>
      <select className="input" id={name} name={name} required={o.required} defaultValue="">
        <option value="">{o.empty ?? "—"}</option>
        {opts.map((x) => (
          <option key={x.value} value={x.value}>{x.label}</option>
        ))}
      </select>
      {o.help && <p className="mt-1 text-xs text-muted">{o.help}</p>}
    </div>
  );

  return (
    <form action={action} className="card p-5">
      <h2 className="font-bold">Nhập giao dịch</h2>

      <div className="mt-3 flex flex-wrap gap-1" role="radiogroup" aria-label="Loại giao dịch">
        {(Object.keys(KIND_LABEL) as TxnKind[]).map((k) => (
          <label
            key={k}
            className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm ${
              kind === k ? "border-accent bg-accent/10 font-semibold text-accent" : "border-hair text-ink-2 hover:bg-page"
            }`}
          >
            <input className="sr-only" type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
            {KIND_LABEL[k]}
          </label>
        ))}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label" htmlFor="date">Ngày<span className="text-crit"> *</span></label>
          <input className="input" id="date" name="date" type="date" required defaultValue={today} />
        </div>
        <div>
          <label className="label" htmlFor="accountId">{kind === "OUT" ? "Chi từ tài khoản" : "Tiền về tài khoản"}<span className="text-crit"> *</span></label>
          <select className="input" id="accountId" name="accountId" required defaultValue={defaultAccount ?? ""}>
            <option value="">Chọn…</option>
            {accounts.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="amount">Số tiền<span className="text-crit"> *</span></label>
          <input className="input" id="amount" name="amount" required inputMode="decimal" placeholder="1.250.000 hoặc 125,50" />
          <p className="mt-1 text-xs text-muted">Theo tiền của tài khoản (đồng / đô)</p>
        </div>
        <div>
          <label className="label" htmlFor="fxRate">Tỷ giá (chỉ USD)</label>
          <input className="input" id="fxRate" name="fxRate" inputMode="decimal" placeholder={fxPlaceholder} />
          <p className="mt-1 text-xs text-muted">Trống = tỷ giá gần nhất trong bảng</p>
        </div>

        {kind === "SHOP_IN" && (
          <>
            <div>
              <label className="label" htmlFor="channel">Kênh<span className="text-crit"> *</span></label>
              <select className="input" id="channel" value={channel} onChange={(e) => setChannel(e.target.value)}>
                {channels.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="shopId">Shop<span className="text-crit"> *</span></label>
              {/* key theo kênh: đổi kênh thì reset shop đã chọn */}
              <select key={channel} className="input" id="shopId" name="shopId" required defaultValue="">
                <option value="">{channelShops.length ? "Chọn shop…" : "Kênh này chưa có shop"}</option>
                {channelShops.map((s) => (
                  <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
                ))}
              </select>
              {!channelShops.length && (
                <p className="mt-1 text-xs">
                  <Link className="text-accent hover:underline" href="/danh-muc/shop?edit=new">+ Tạo shop cho kênh này</Link>
                </p>
              )}
            </div>
          </>
        )}

        {kind === "OUT" && (
          <>
            {select("categoryId", "Hạng mục chi phí", categories, { help: "Trống = chi khác (699)" })}
            {select("supplierId", "Nhà cung cấp", suppliers)}
            <div>
              <label className="label" htmlFor="shopId">Chi cho shop</label>
              <select className="input" id="shopId" name="shopId" defaultValue="">
                <option value="">— (chi chung)</option>
                {channels.map((c) => {
                  const list = shops.filter((s) => s.channel === c.value);
                  return list.length ? (
                    <optgroup key={c.value} label={c.label}>
                      {list.map((s) => (
                        <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
                      ))}
                    </optgroup>
                  ) : null;
                })}
              </select>
            </div>
          </>
        )}

        {kind === "IN" && (
          <>
            {select("categoryId", "Hạng mục (nếu là hoàn chi phí)", categories, { help: "Trống = thu nhập khác (409)" })}
            {select("supplierId", "Từ nhà cung cấp", suppliers)}
          </>
        )}
      </div>

      <div className="mt-4">
        <label className="label" htmlFor="description">Diễn giải<span className="text-crit"> *</span></label>
        <input
          className="input"
          id="description"
          name="description"
          required
          placeholder={kind === "SHOP_IN" ? "Payout Amazon kỳ 01–14/11…" : kind === "OPENING" ? "Số dư đầu kỳ 31/10" : "Nạp Merchize đơn tuần 45…"}
        />
      </div>
      <div className="mt-5">
        <button className="btn-primary" type="submit">Ghi sổ</button>
      </div>
    </form>
  );
}
