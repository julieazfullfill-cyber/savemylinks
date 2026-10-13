// Màn hình 1 — Tổng quan tiền. Hàm thuần: số dư theo ngày, quy đổi, cảnh báo.
// Đặc tả mục 05: thẻ số dư (khả dụng / bị giam), tổng quy VND, biểu đồ 90 ngày, ba cảnh báo nổi bật.

import { addDays, bizDateStr, daysBetween, fmtBizDate } from "./dates";
import { formatMoney, toVnd, type Currency } from "./money";

export type LedgerTxn = { accountId: string; date: Date; direction: "IN" | "OUT"; amount: bigint; currency: Currency };
export type RatePoint = { date: Date; rate: string };

const sign = (t: LedgerTxn) => (t.direction === "IN" ? t.amount : -t.amount);

/** Tỷ giá USD/VND áp cho ngày `d`: bản ghi gần nhất vào hoặc trước ngày đó (rates sắp tăng dần). */
export function rateOn(rates: RatePoint[], d: Date): string | null {
  let r: string | null = null;
  for (const x of rates) {
    if (x.date > d) break;
    r = x.rate;
  }
  return r;
}

/** Số dư nguyên tệ của một tài khoản tại cuối ngày `on` (mặc định: tất cả). */
export function bookBalance(txns: LedgerTxn[], accountId: string, on?: Date): bigint {
  return txns.filter((t) => t.accountId === accountId && (!on || t.date <= on)).reduce((a, t) => a + sign(t), 0n);
}

/**
 * Chuỗi số dư toàn công ty theo ngày trong [from, to], quy VND bằng tỷ giá CỦA NGÀY ĐÓ
 * (USD giữ bao nhiêu đô thì định giá theo tỷ giá hôm ấy). Ngày chưa có tỷ giá nào → phần USD
 * không quy được, `missingRate = true` để biểu đồ ghi chú.
 */
export function balanceSeries(txns: LedgerTxn[], rates: RatePoint[], from: Date, to: Date) {
  const sorted = [...txns].sort((a, b) => a.date.getTime() - b.date.getTime());
  const sortedRates = [...rates].sort((a, b) => a.date.getTime() - b.date.getTime());
  const native: Record<Currency, bigint> = { VND: 0n, USD: 0n };
  let i = 0;
  const out: { date: string; vnd: bigint; missingRate: boolean }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    while (i < sorted.length && sorted[i].date <= d) {
      native[sorted[i].currency] += sign(sorted[i]);
      i++;
    }
    const rate = rateOn(sortedRates, d);
    const usdVnd = native.USD === 0n ? 0n : rate ? toVnd(native.USD, "USD", rate) : 0n;
    out.push({ date: bizDateStr(d), vnd: native.VND + usdVnd, missingRate: native.USD !== 0n && !rate });
  }
  return out;
}

/** Thu / chi trong khoảng, quy VND theo tỷ giá ngày giao dịch (amountVnd đã lưu cứng). Bỏ số dư đầu kỳ. */
export function flows(txns: { date: Date; direction: "IN" | "OUT"; amountVnd: bigint; opening: boolean }[], from: Date, to: Date) {
  let inflow = 0n;
  let outflow = 0n;
  for (const t of txns) {
    if (t.opening || t.date < from || t.date > to) continue;
    if (t.direction === "IN") inflow += t.amountVnd;
    else outflow += t.amountVnd;
  }
  return { inflow, outflow, net: inflow - outflow };
}

// ------------------------------------------------------------- cảnh báo

export type Severity = "crit" | "warn" | "info";
export type Alert = { severity: Severity; title: string; detail: string; href: string; /** GĐ4: mã cảnh báo (màn 28) */ code?: string };

export type AlertInput = {
  today: Date;
  accounts: {
    id: string;
    code: string;
    label: string;
    currency: Currency;
    book: bigint;
    txnCount: number;
    hasOpening: boolean;
    /** lần chốt số dư gần nhất (màn 5) và số dư sổ quỹ tại ngày đó */
    lastClose?: { date: Date; available: bigint; bookAtDate: bigint } | null;
  }[];
  latestUsdRateDate: Date | null;
  overdueBills: { supplier: string; dueDate: Date; outstandingVnd: bigint }[];
  /** tỷ giá cũ hơn số ngày này thì cảnh báo */
  staleRateDays?: number;
  /** tuần đầu tiên dự báo xuống dưới ngưỡng (màn 6) */
  forecastBreach?: { week: number; from: Date; closingVnd: bigint; floorVnd: bigint } | null;
  /** hạng mục chi vượt ngân sách tháng này */
  overBudget?: { name: string; usedVnd: bigint; budgetVnd: bigint }[];
};

const ORDER: Record<Severity, number> = { crit: 0, warn: 1, info: 2 };

/** Toàn bộ cảnh báo, nặng trước. Màn hình hiện 3 cái đầu. */
export function buildAlerts(i: AlertInput): Alert[] {
  const out: Alert[] = [];
  const stale = i.staleRateDays ?? 3;

  for (const a of i.accounts) {
    if (a.book < 0n) {
      out.push({
        severity: "crit",
        title: `Số dư âm: ${a.code}`,
        detail: `${a.label} đang ${formatMoney(a.book, a.currency)} trên sổ quỹ — thiếu số dư đầu kỳ hoặc ghi nhầm tài khoản.`,
        href: `/so-quy?acc=${a.id}`,
      });
    }
  }

  if (i.forecastBreach) {
    const b = i.forecastBreach;
    out.push({
      severity: "crit",
      title: `Số dư dự kiến chạm đáy tuần ${b.week}`,
      detail: `Tuần từ ${fmtBizDate(b.from)} dự kiến còn ${formatMoney(b.closingVnd)}, dưới ngưỡng ${formatMoney(b.floorVnd)}.`,
      href: "/du-bao",
    });
  }

  if (i.overdueBills.length) {
    const total = i.overdueBills.reduce((s, b) => s + b.outstandingVnd, 0n);
    const oldest = i.overdueBills.reduce((m, b) => (b.dueDate < m.dueDate ? b : m));
    out.push({
      severity: "crit",
      title: `${i.overdueBills.length} hoá đơn NCC quá hạn`,
      detail: `Tổng ${formatMoney(total)}; lâu nhất ${oldest.supplier} hạn ${fmtBizDate(oldest.dueDate)} (${daysBetween(oldest.dueDate, i.today)} ngày).`,
      href: "/cong-no",
    });
  }

  const usdHeld = i.accounts.some((a) => a.currency === "USD" && a.book !== 0n);
  if (usdHeld && !i.latestUsdRateDate) {
    out.push({
      severity: "warn",
      title: "Chưa có tỷ giá USD/VND",
      detail: "Số dư USD chưa quy được ra VND — tổng tiền đang thiếu phần này.",
      href: "/so-quy",
    });
  } else if (usdHeld && i.latestUsdRateDate && daysBetween(i.latestUsdRateDate, i.today) > stale) {
    out.push({
      severity: "warn",
      title: "Tỷ giá USD cũ",
      detail: `Tỷ giá gần nhất ngày ${fmtBizDate(i.latestUsdRateDate)} (${daysBetween(i.latestUsdRateDate, i.today)} ngày trước) — tổng quy VND có thể lệch.`,
      href: "/so-quy",
    });
  }

  for (const a of i.accounts) {
    const c = a.lastClose;
    if (c && c.available !== c.bookAtDate) {
      out.push({
        severity: "warn",
        title: `Lệch số dư: ${a.code}`,
        detail: `Chốt ngày ${fmtBizDate(c.date)} là ${formatMoney(c.available, a.currency)}, sổ quỹ ${formatMoney(c.bookAtDate, a.currency)} (lệch ${formatMoney(c.available - c.bookAtDate, a.currency)}).`,
        href: `/so-quy?acc=${a.id}`,
      });
    }
  }

  if (i.overBudget?.length) {
    const worst = i.overBudget.reduce((m, b) => (b.usedVnd * m.budgetVnd > m.usedVnd * b.budgetVnd ? b : m));
    out.push({
      severity: "warn",
      title: `${i.overBudget.length} hạng mục chi vượt ngân sách`,
      detail: `Nặng nhất: ${worst.name} ${formatMoney(worst.usedVnd)} / ${formatMoney(worst.budgetVnd)} tháng này.`,
      href: "/chi-phi",
    });
  }

  const noOpening = i.accounts.filter((a) => a.txnCount > 0 && !a.hasOpening);
  if (noOpening.length) {
    out.push({
      severity: "warn",
      title: `${noOpening.length} tài khoản chưa có số dư đầu kỳ`,
      detail: `${noOpening.map((a) => a.code).join(", ")} — số dư hiện tại chỉ là tổng giao dịch, chưa đúng số thật.`,
      href: "/so-quy",
    });
  }

  if (!i.accounts.some((a) => a.txnCount > 0)) {
    out.push({
      severity: "info",
      title: "Chưa có giao dịch nào",
      detail: "Nhập tỷ giá, số dư đầu kỳ từng tài khoản rồi giao dịch hằng ngày ở Sổ quỹ.",
      href: "/so-quy",
    });
  }

  return out.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

/** Số VND gọn cho trục và số lớn: 1,25 tỷ · 350 tr · 12 nghìn. */
export function compactVnd(v: number): string {
  const abs = Math.abs(v);
  const fmt = (x: number, unit: string) =>
    `${v < 0 ? "-" : ""}${x.toLocaleString("vi-VN", { maximumFractionDigits: x < 10 ? 2 : x < 100 ? 1 : 0 })} ${unit}`;
  if (abs >= 1e9) return fmt(abs / 1e9, "tỷ");
  if (abs >= 1e6) return fmt(abs / 1e6, "tr");
  if (abs >= 1e3) return fmt(abs / 1e3, "nghìn");
  return `${v.toLocaleString("vi-VN")} ₫`;
}

/** Vạch trục tròn số (1–2–2,5–5 × 10^n), bao trọn [min, max] và luôn có 0 khi dải số đi qua 0. */
export function niceTicks(min: number, max: number, target = 4): number[] {
  if (min === max) {
    const pad = Math.abs(max) || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}
