// Màn 31 — đọc file "Tháng N Doanh thu chi phí team X.xlsx" (4 sheet) thành các dòng thu/chi chờ chốt.
//   Doanh thu- chi phí : tổng theo mục (THU AMZ / ESTY / khác; CHI cố định / lương-sàn-chung / fulfill)
//   Chi tiết tài khoản : tiền Etsy về theo TỪNG số TK nhận + tên shop → dùng thay dòng tổng nếu cộng khớp
//   Chi phí chung      : từng khoản có ngày → dùng thay các dòng "Chi phí chung / -AMZ / -Etsy / tiktok" nếu cộng khớp
//   Thu nhập khác      : từng khoản có ngày (USD × tỷ giá) → dùng thay "Doanh thu khác" nếu cộng khớp
// Chọn chi tiết hay dòng tổng theo việc CỘNG CÓ KHỚP không — không bao giờ lấy cả hai (đếm trùng).
import { excelDate, readXlsx, type Sheet } from "./xlsx-lite";

export type Section = "AMZ" | "ETSY" | "OTHER_IN" | "FIXED" | "OPEX" | "CHUNG" | "FULFILL";
export const SECTION_VI: Record<Section, string> = {
  AMZ: "Thu Amazon",
  ETSY: "Thu Etsy",
  OTHER_IN: "Thu khác",
  FIXED: "Chi cố định",
  OPEX: "Lương, sàn, phí",
  CHUNG: "Chi phí chung",
  FULFILL: "Fulfill",
};

export type DraftLine = {
  section: Section;
  label: string;
  ref: string | null;
  date: Date;
  direction: "IN" | "OUT";
  amount: bigint; // đơn vị nhỏ nhất
  currency: "VND" | "USD";
  note: string | null;
  /** gợi ý (tên) — ghép id ở suggest() */
  hint: { account?: string; shopName?: string; category?: string; supplier?: string; incomeGl?: string; skip?: string };
};

export type ParsedReport = { lines: DraftLine[]; totals: Record<string, number>; fxRate: number | null; warnings: string[] };

const num = (s: string | undefined) => {
  if (s === undefined || s === "") return null;
  const n = Number(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const usd = (x: number) => BigInt(Math.round(x * 100));
const vnd = (x: number) => BigInt(Math.round(x));
const close = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function sheet(sheets: Sheet[], startsWith: string): Sheet | undefined {
  return sheets.find((s) => norm(s.name).startsWith(norm(startsWith)));
}

/** Dòng ở sheet tổng: cột A nhóm (I. THU), B tiêu đề mục ("1. Nguồn thu từ AMZ"), C STT, D tên, E số tiền, F ghi chú / quy đổi. */
type Item = { row: number; section: string; name: string; e: number | null; f: string };

function summaryItems(s: Sheet) {
  const items: Item[] = [];
  const totals: Record<string, number> = {};
  let group = "";
  let section = "";
  for (const [row, c] of [...s.rows].sort((a, b) => a[0] - b[0])) {
    if (/^I\.\s*THU/i.test(c[0] ?? "")) {
      group = "THU";
      totals.THU = num(c[1]) ?? 0;
    } else if (/^II\.\s*CHI/i.test(c[0] ?? "")) {
      group = "CHI";
      totals.CHI = num(c[1]) ?? 0;
    } else if (/^III\./.test(c[0] ?? "")) group = "PROFIT";
    if (group === "PROFIT" && /còn lại/i.test(c[1] ?? "")) totals.LOI_NHUAN = num(c[3]) ?? num(c[2]) ?? 0;
    if (/^\d+\.\s/.test(c[1] ?? "") && group !== "PROFIT") {
      const t = norm(c[1]);
      section =
        group === "THU"
          ? t.includes("amz") ? "AMZ" : t.includes("esty") || t.includes("etsy") ? "ETSY" : "OTHER_IN"
          : t.includes("co dinh") ? "FIXED" : t.includes("fulfill") ? "FULFILL" : "OPEX";
      const k = { AMZ: "THU_AMZ", ETSY: "THU_ETSY", OTHER_IN: "THU_KHAC", FIXED: "CHI_CO_DINH", OPEX: "CHI_LUONG_SAN_CHUNG", FULFILL: "CHI_FULFILL" }[section]!;
      totals[k] = num(c[4]) ?? 0;
      continue;
    }
    if (section && num(c[2]) !== null && (c[3] ?? "").trim()) items.push({ row, section, name: c[3].trim(), e: num(c[4]), f: c[5] ?? "" });
  }
  return { items, totals };
}

/** Sheet "Chi tiết tài khoản": khối BANK VIỆT / AWHK / BANK RIÊNG (tên khối ở cột A); cột B số TK, C shop, D quản lý, E USD, F VND. */
function accountDetail(s: Sheet) {
  type D = { block: "BANKVN" | "AWHK" | "AWVN" | "BANKRIENG"; row: number; number: string; shop: string; manager: string; usd: number; vnd: number | null; note: string };
  const out: D[] = [];
  let block: D["block"] | null = null;
  for (const [row, c] of [...s.rows].sort((a, b) => a[0] - b[0])) {
    const a = norm(c[0] ?? "");
    if (a.startsWith("bank viet")) block = "BANKVN";
    else if (a.startsWith("awhk") || a.startsWith("aw hk")) block = "AWHK";
    else if (a.startsWith("awvn") || a.startsWith("aw vn")) block = "AWVN";
    else if (a.startsWith("bank rieng")) block = "BANKRIENG";
    if (!block) continue;
    const u = num(c[4]);
    const name = (c[2] ?? "").trim();
    const numStr = String(c[1] ?? "").replace(/'/g, "").trim();
    // bỏ dòng tiêu đề và dòng "Tổng thu" của khối
    if (!u || (!name && !numStr) || /^(bank nhan tien|tong)/.test(norm(numStr))) continue;
    // số TK dạng 9.6312420785753E13 → chữ số đầy đủ
    const number = /e\+?\d+$/i.test(numStr) ? BigInt(Math.round(Number(numStr))).toString() : numStr;
    out.push({ block, row, number, shop: name, manager: (c[3] ?? "").trim(), usd: u, vnd: num(c[5]), note: (c[6] ?? "").trim() });
  }
  return out;
}

const CATEGORY_RULES: [RegExp, string][] = [
  [/luong/, "LUONG"],
  [/bao hiem|bhxh/, "BHXH"],
  [/thue van phong|thue vp/, "THUE_VP"],
  [/dien|nuoc/, "DIEN_NUOC"],
  [/vps|chat gpt|gpt|ai credit|tool|canva|capcut|adobe/, "VPS_TOOL"],
  [/rut tien|fee|card number|phi rut/, "PHI_TT"],
  [/tiktok|inf|kol|meta ads|ads|quang cao|marketing/, "MARKETING"],
  [/amz charge|charge|chi phi amz|chi phi esty|chi phi etsy|phi san/, "PHI_SAN"],
  [/gia han|thue ho kinh doanh|thue hkd|llc|cong ty/, "PHAP_NHAN"],
  [/hr |tuyen dung|thue ngoai/, "THUE_NGOAI"],
  [/ban ghe|may tinh|thiet bi|van phong pham/, "THIET_BI"],
  [/dao tao|master mind|khoa hoc|dki/, "DAO_TAO"],
];
export function guessCategory(label: string): string {
  const t = ` ${norm(label)} `;
  return CATEGORY_RULES.find(([re]) => re.test(t))?.[1] ?? "KHAC";
}

const SUPPLIER_RULES: [RegExp, string][] = [
  [/merchize/, "MERCHIZE"],
  [/printway/, "PRINTWAY"],
  [/printify/, "PRINTIFY"],
  [/gearment/, "GEARMENT"],
  [/rapid/, "RAPID"],
  [/hanh phuc/, "HANHPHUC"],
  [/\beg\b/, "EG"],
  [/printposs/, "PRINTPOSS"],
  [/falcon/, "FALCON"],
  [/\bhub\b/, "HUB"],
  [/dreamship/, "DREAMSHIP"],
  [/popcustom/, "POPCUSTOM"],
  [/pgprint/, "PGPRINT"],
  [/\bgke\b/, "GKE"],
  [/hgt/, "HGT"],
];
export const guessSupplier = (label: string) => SUPPLIER_RULES.find(([re]) => re.test(norm(label)))?.[1];

const AMZ_ACCOUNT = (name: string) => {
  const t = norm(name).replace(/^amz\s*/, "");
  return t ? `AMZ-${t.toUpperCase().replace(/\s+/g, "-")}` : undefined;
};

export function parseMonthlyReport(buf: Buffer, p: { year: number; month: number }): ParsedReport {
  const sheets = readXlsx(buf);
  const main = sheet(sheets, "Doanh thu");
  if (!main) throw new Error('Không thấy sheet "Doanh thu- chi phí"');
  const { items, totals } = summaryItems(main);
  const monthEnd = new Date(Date.UTC(p.year, p.month, 0));
  const inMonth = (d: Date) => d.getUTCFullYear() === p.year && d.getUTCMonth() + 1 === p.month;
  const lines: DraftLine[] = [];
  const warnings: string[] = [];
  const ref = (r: number, sh = "Tổng") => `${sh}!${r}`;

  // Tỷ giá tháng = chi cố định VND / chi cố định USD (dòng tổng của mục ghi USD)
  const fixedVnd = items.filter((i) => i.section === "FIXED").reduce((a, i) => a + (i.e ?? 0), 0);
  const fxRate = totals.CHI_CO_DINH > 0 && fixedVnd > 0 ? Math.round(fixedVnd / totals.CHI_CO_DINH) : null;
  if (!fxRate) warnings.push("Không suy ra được tỷ giá tháng từ chi cố định — điền tỷ giá trên màn hình");

  // ── THU AMZ: theo tài khoản AMZ (USD)
  for (const i of items.filter((x) => x.section === "AMZ" && (x.e ?? 0) > 0)) {
    const refund = /refund/i.test(i.name);
    lines.push({
      section: "AMZ", label: i.name, ref: ref(i.row), date: monthEnd, direction: "IN", amount: usd(i.e!), currency: "USD",
      note: i.f && num(i.f) ? `Cột F: ${i.f}` : null,
      hint: refund ? { incomeGl: "501", category: undefined } : /^amz/i.test(i.name) ? { account: AMZ_ACCOUNT(i.name), incomeGl: "402" } : { incomeGl: "402" },
    });
  }

  // ── THU ETSY: chi tiết theo số TK nếu cộng khớp dòng tổng của từng nguồn
  const detail = sheet(sheets, "Chi tiết") ? accountDetail(sheet(sheets, "Chi tiết")!) : [];
  // "AW HK" ở sheet tổng ứng với khối AWHK (Team 1) hoặc AWVN (Team 2) ở sheet chi tiết
  const BLOCK_OF: Record<string, ("BANKVN" | "AWHK" | "AWVN" | "BANKRIENG")[]> = { "bank viet": ["BANKVN"], "aw hk": ["AWHK", "AWVN"], "bank rieng khac": ["BANKRIENG"] };
  for (const i of items.filter((x) => x.section === "ETSY" && (x.e ?? 0) > 0)) {
    const blocks = BLOCK_OF[norm(i.name)] ?? [];
    const rows = detail.filter((d) => blocks.includes(d.block));
    const block = rows[0]?.block ?? blocks[0];
    const sum = rows.reduce((a, d) => a + d.usd, 0);
    // lệch ≤ 1%: vẫn lấy chi tiết (để gắn được shop) — phần lệch hiện ở bảng đối chiếu
    if (block && rows.length && close(sum, i.e!, Math.max(0.05, i.e! * 0.01))) {
      if (!close(sum, i.e!, 0.05)) warnings.push(`Thu Etsy "${i.name}": chi tiết theo TK cộng ${sum.toFixed(2)} ≠ dòng tổng ${i.e!.toFixed(2)} USD (lệch ${(sum - i.e!).toFixed(2)}) — lấy chi tiết`);
      for (const d of rows) {
        const isVnd = d.block === "BANKVN";
        lines.push({
          section: "ETSY", label: `${i.name} · ${d.shop || d.number}`, ref: d.number ? `TK ${d.number}` : null, date: monthEnd, direction: "IN",
          amount: isVnd && d.vnd ? vnd(d.vnd) : usd(d.usd), currency: isVnd && d.vnd ? "VND" : "USD",
          note: [isVnd && d.vnd ? `${d.usd.toFixed(2)} USD` : null, d.manager ? `Quản lý: ${d.manager}` : null, d.note || null].filter(Boolean).join(" · ") || null,
          hint: { account: d.block, shopName: d.shop },
        });
      }
    } else {
      if (block) warnings.push(`Thu Etsy "${i.name}": chi tiết theo TK cộng ${sum.toFixed(2)} ≠ dòng tổng ${i.e!.toFixed(2)} USD — lấy dòng tổng, chưa gắn shop`);
      const vndConv = num(i.f);
      const isVnd = block === "BANKVN" && vndConv && vndConv > 1000;
      lines.push({
        section: "ETSY", label: i.name, ref: ref(i.row), date: monthEnd, direction: "IN",
        amount: isVnd ? vnd(vndConv!) : usd(i.e!), currency: isVnd ? "VND" : "USD", note: isVnd ? `${i.e!.toFixed(2)} USD` : null,
        hint: /refund/i.test(i.name) ? { incomeGl: "501" } : { account: block, incomeGl: "401" },
      });
    }
  }

  // ── THU KHÁC: sheet "Thu nhập khác" (A ngày, B nội dung, C USD, D tỷ giá, E VND) nếu khớp
  const other = sheet(sheets, "Thu nhập khác");
  const otherRows = other
    ? [...other.rows].filter(([, c]) => num(c[0]) && num(c[0])! > 40000 && num(c[2])).map(([row, c]) => ({ row, date: excelDate(num(c[0])!), label: c[1], usd: num(c[2])!, rate: num(c[3]), vnd: num(c[4]) }))
    : [];
  const otherSum = items.filter((x) => x.section === "OTHER_IN").reduce((a, x) => a + (x.e ?? 0), 0);
  if (otherRows.length && close(otherRows.reduce((a, r) => a + r.usd, 0), otherSum, 0.05)) {
    for (const r of otherRows) {
      lines.push({
        section: "OTHER_IN", label: r.label || "Thu nhập khác", ref: ref(r.row, "Thu nhập khác"), date: inMonth(r.date) ? r.date : monthEnd, direction: "IN",
        amount: r.vnd ? vnd(r.vnd) : usd(r.usd), currency: r.vnd ? "VND" : "USD",
        note: `${r.usd.toFixed(2)} USD × ${r.rate ?? "?"}${inMonth(r.date) ? "" : ` · ngày gốc ${r.date.toISOString().slice(0, 10)}`}`,
        hint: { incomeGl: "409" },
      });
    }
  } else {
    if (otherRows.length) warnings.push(`Thu khác: sheet chi tiết cộng ${otherRows.reduce((a, r) => a + r.usd, 0).toFixed(2)} ≠ dòng tổng ${otherSum.toFixed(2)} USD — lấy dòng tổng`);
    for (const i of items.filter((x) => x.section === "OTHER_IN" && (x.e ?? 0) > 0)) {
      const v = num(i.f);
      lines.push({ section: "OTHER_IN", label: i.name, ref: ref(i.row), date: monthEnd, direction: "IN", amount: v && v > 1000 ? vnd(v) : usd(i.e!), currency: v && v > 1000 ? "VND" : "USD", note: null, hint: { incomeGl: "409" } });
    }
  }

  // ── CHI CỐ ĐỊNH (VND)
  for (const i of items.filter((x) => x.section === "FIXED" && (x.e ?? 0) > 0)) {
    lines.push({ section: "FIXED", label: i.name, ref: ref(i.row), date: monthEnd, direction: "OUT", amount: vnd(i.e!), currency: "VND", note: null, hint: { category: guessCategory(i.name) } });
  }

  // ── CHI PHÍ CHUNG: sheet chi tiết (A ngày, B nội dung, C VND, D ghi chú) thay các dòng tổng tương ứng nếu khớp
  const chung = sheet(sheets, "Chi phí chung");
  const chungRows = chung
    ? [...chung.rows].filter(([, c]) => num(c[0]) && num(c[0])! > 40000 && num(c[2])).map(([row, c]) => ({ row, date: excelDate(num(c[0])!), label: c[1], vnd: num(c[2])!, note: c[3] }))
    : [];
  const isChungSummary = (n: string) => /chi phi chung|chi phi amz|chi phi esty|chi phi etsy|tiktok/.test(norm(n));
  const opex = items.filter((x) => x.section === "OPEX" && (x.e ?? 0) > 0);
  const candidates = opex.filter((x) => isChungSummary(x.name));
  // Sheet chi tiết có tháng gồm cả 4 dòng (chung / AMZ / Etsy / tiktok), có tháng chỉ một phần → tìm tổ hợp cộng khớp.
  const detailSum = chungRows.reduce((a, r) => a + r.vnd, 0);
  let replaced: Item[] | null = null;
  for (let mask = 1; chungRows.length && mask < 1 << candidates.length; mask++) {
    const pick = candidates.filter((_, i) => mask & (1 << i));
    if (close(pick.reduce((a, x) => a + x.e!, 0), detailSum, 1000)) {
      replaced = pick;
      break;
    }
  }
  if (chungRows.length && !replaced) {
    warnings.push(
      `Chi phí chung: sheet chi tiết cộng ${Math.round(detailSum).toLocaleString("vi-VN")} ₫ không khớp tổ hợp nào của các dòng tổng (${candidates.map((x) => `${x.name} ${Math.round(x.e!).toLocaleString("vi-VN")}`).join(", ")}) — lấy dòng tổng, không lấy chi tiết`,
    );
  }
  const chungOk = !!replaced;
  for (const i of opex) {
    if (replaced?.includes(i)) continue;
    const skip = /bao hiem/.test(norm(i.name)) ? "Tạm bỏ qua BHXH" : undefined;
    const account = /aw hk/.test(norm(i.name)) ? "AWHK" : /wealify/.test(norm(i.name)) ? "WEALIFY" : /au amz/.test(norm(i.name)) ? "AMZ-AU1" : /bank viet/.test(norm(i.name)) ? "BANKVN" : undefined;
    lines.push({
      section: "OPEX", label: i.name, ref: ref(i.row), date: monthEnd, direction: "OUT", amount: vnd(i.e!), currency: "VND",
      note: i.f && !/^https?:/.test(i.f) && num(i.f) ? `Cột F: ${i.f}` : null,
      hint: { category: guessCategory(i.name), account, skip },
    });
  }
  if (chungOk) {
    for (const r of chungRows) {
      lines.push({
        section: "CHUNG", label: r.label, ref: ref(r.row, "Chi phí chung"), date: inMonth(r.date) ? r.date : monthEnd, direction: "OUT",
        amount: vnd(r.vnd), currency: "VND", note: [r.note && r.note !== "0.0" ? `Ghi chú: ${r.note}` : null, inMonth(r.date) ? null : `ngày gốc ${r.date.toISOString().slice(0, 10)}`].filter(Boolean).join(" · ") || null,
        hint: { category: guessCategory(r.label) },
      });
    }
  }

  // ── FULFILL (USD)
  for (const i of items.filter((x) => x.section === "FULFILL" && (x.e ?? 0) > 0)) {
    lines.push({
      section: "FULFILL", label: i.name, ref: ref(i.row), date: monthEnd, direction: "OUT", amount: usd(i.e!), currency: "USD",
      note: num(i.f) ? `Cột F: ${i.f}` : null, hint: { category: "FULFILL", supplier: guessSupplier(i.name) },
    });
  }

  return { lines, totals, fxRate, warnings };
}
