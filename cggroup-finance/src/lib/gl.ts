// Sổ cái tổng hợp — đặc tả GĐ4 mục 03 (lib/ledger.ts của đặc tả; ở đây ledger.ts là chỗ GHI bút toán,
// nên phần ĐỌC đặt tên gl.ts). Bảng cân đối thử, P&L, bảng cân đối kế toán là TRUY VẤN trên bút toán.

export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "COGS" | "EXPENSE" | "OTHER";

export type LineRow = {
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  debitVnd: bigint;
  creditVnd: bigint;
  shopId?: string | null;
};

/** Tài khoản tăng bên nợ hay bên có. */
export function isDebitNatured(t: AccountType): boolean {
  return t === "ASSET" || t === "COGS" || t === "EXPENSE";
}

/** Số dư theo chiều tự nhiên của tài khoản — luôn dương khi bình thường. */
export function naturalBalance(t: AccountType, debit: bigint, credit: bigint): bigint {
  return isDebitNatured(t) ? debit - credit : credit - debit;
}

// ─────────────────────────── bảng cân đối thử

export type TrialRow = {
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  debitVnd: bigint;
  creditVnd: bigint;
  balanceVnd: bigint;
};

export type TrialBalance = {
  rows: TrialRow[];
  totalDebitVnd: bigint;
  totalCreditVnd: bigint;
  balanced: boolean;
  diffVnd: bigint;
};

export function trialBalance(lines: LineRow[]): TrialBalance {
  const acc = new Map<string, TrialRow>();
  for (const l of lines) {
    const r = acc.get(l.accountCode) ?? {
      accountCode: l.accountCode,
      accountName: l.accountName,
      accountType: l.accountType,
      debitVnd: 0n,
      creditVnd: 0n,
      balanceVnd: 0n,
    };
    r.debitVnd += l.debitVnd;
    r.creditVnd += l.creditVnd;
    acc.set(l.accountCode, r);
  }
  let totalDebitVnd = 0n;
  let totalCreditVnd = 0n;
  for (const r of acc.values()) {
    r.balanceVnd = naturalBalance(r.accountType, r.debitVnd, r.creditVnd);
    totalDebitVnd += r.debitVnd;
    totalCreditVnd += r.creditVnd;
  }
  const diffVnd = totalDebitVnd - totalCreditVnd;
  return {
    rows: [...acc.values()].sort((a, b) => a.accountCode.localeCompare(b.accountCode)),
    totalDebitVnd,
    totalCreditVnd,
    balanced: diffVnd === 0n,
    diffVnd,
  };
}

// ─────────────────────────── P&L

export type PnlLine = { accountCode: string; accountName: string; amountVnd: bigint };

export type Pnl = {
  revenue: PnlLine[];
  cogs: PnlLine[];
  expense: PnlLine[];
  other: PnlLine[];
  revenueVnd: bigint;
  cogsVnd: bigint;
  grossProfitVnd: bigint;
  expenseVnd: bigint;
  otherVnd: bigint;
  netProfitVnd: bigint;
  grossMarginPct: number;
  netMarginPct: number;
};

export function profitAndLoss(lines: LineRow[]): Pnl {
  const tb = trialBalance(lines);
  const pick = (t: AccountType): PnlLine[] =>
    tb.rows
      .filter((r) => r.accountType === t && r.balanceVnd !== 0n)
      .map((r) => ({ accountCode: r.accountCode, accountName: r.accountName, amountVnd: r.balanceVnd }));

  const revenue = pick("REVENUE");
  const cogs = pick("COGS");
  const expense = pick("EXPENSE");
  const other = pick("OTHER");
  const sum = (xs: PnlLine[]) => xs.reduce((a, x) => a + x.amountVnd, 0n);
  const revenueVnd = sum(revenue);
  const cogsVnd = sum(cogs);
  const expenseVnd = sum(expense);
  // OTHER ghi theo chiều có: dương là thu nhập, âm là chi phí
  const otherVnd = sum(other);
  const grossProfitVnd = revenueVnd - cogsVnd;
  const netProfitVnd = grossProfitVnd - expenseVnd + otherVnd;
  const r = Number(revenueVnd);
  return {
    revenue,
    cogs,
    expense,
    other,
    revenueVnd,
    cogsVnd,
    grossProfitVnd,
    expenseVnd,
    otherVnd,
    netProfitVnd,
    grossMarginPct: r > 0 ? Number(grossProfitVnd) / r : 0,
    netMarginPct: r > 0 ? Number(netProfitVnd) / r : 0,
  };
}

// ─────────────────────────── bảng cân đối kế toán

export type BalanceSheet = {
  assetsVnd: bigint;
  liabilitiesVnd: bigint;
  equityVnd: bigint;
  /** lãi lỗ chưa kết chuyển (số dư còn lại trên các TK kết quả) */
  retainedThisPeriodVnd: bigint;
  balanced: boolean;
  diffVnd: bigint;
};

export function balanceSheet(lines: LineRow[]): BalanceSheet {
  const tb = trialBalance(lines);
  const by = (t: AccountType) => tb.rows.filter((r) => r.accountType === t).reduce((a, r) => a + r.balanceVnd, 0n);
  const assetsVnd = by("ASSET");
  const liabilitiesVnd = by("LIABILITY");
  const equityVnd = by("EQUITY");
  const retainedThisPeriodVnd = profitAndLoss(lines).netProfitVnd;
  const diffVnd = assetsVnd - (liabilitiesVnd + equityVnd + retainedThisPeriodVnd);
  return { assetsVnd, liabilitiesVnd, equityVnd, retainedThisPeriodVnd, balanced: diffVnd === 0n, diffVnd };
}

/** Số dư một tài khoản — đối chiếu với sao kê. */
export function accountBalance(lines: LineRow[], accountCode: string, type: AccountType): bigint {
  const f = lines.filter((l) => l.accountCode === accountCode);
  return naturalBalance(
    type,
    f.reduce((a, l) => a + l.debitVnd, 0n),
    f.reduce((a, l) => a + l.creditVnd, 0n),
  );
}
