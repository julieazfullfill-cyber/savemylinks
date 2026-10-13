// Màn 27 — đóng sổ tháng trên dữ liệu thật: nạp số liệu cho 7 kiểm tra (datachecks.ts),
// checklist (period-close.ts), bút toán kết chuyển, khoá kỳ, mở lại kỳ.
import { audit } from "./audit";
import { addDays } from "./dates";
import { toJsonSafe, type Tx } from "./db";
import { runDataChecks, type CheckResult, type DataCheckInput } from "./datachecks";
import { balanceSheet, profitAndLoss } from "./gl";
import { loadGlLines, monthRange } from "./gl-data";
import { createJournal } from "./journal";
import { assertBalanced, reverseLines } from "./ledger";
import { toVnd, type Currency } from "./money";
import { bookBalance, type LedgerTxn } from "./overview";
import { buildClosingJournal, canClose, closeChecklist, type ClosePrecondition } from "./period-close";

const usdCentsToVnd = (usd: number, rate: string | null) => (rate ? toVnd(BigInt(Math.round(usd * 100)), "USD", rate) : 0n);

/** Số dư chốt (màn 5) gần cuối tháng nhất: từ 3 ngày trước đến 5 ngày sau ngày cuối tháng. */
async function statementsNear(tx: Tx, monthEnd: Date) {
  const rows = await tx.accountBalance.findMany({
    where: { date: { gte: addDays(monthEnd, -3), lte: addDays(monthEnd, 5) } },
    orderBy: { date: "asc" },
  });
  const best = new Map<string, (typeof rows)[number]>();
  const dist = (d: Date) => Math.abs(d.getTime() - monthEnd.getTime());
  for (const r of rows) {
    const cur = best.get(r.accountId);
    if (!cur || dist(r.date) < dist(cur.date)) best.set(r.accountId, r);
  }
  return best;
}

/** Tài khoản tiền có phát sinh tính đến cuối tháng — chỉ những TK này mới cần chốt số dư. */
async function usedAccounts(tx: Tx, monthEnd: Date) {
  const [accounts, txns] = await Promise.all([
    tx.cashAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    tx.cashTxn.findMany({
      where: { voidedAt: null, date: { lte: addDays(monthEnd, 5) } },
      select: { accountId: true, date: true, direction: true, amount: true, currency: true },
    }),
  ]);
  const ledger: LedgerTxn[] = txns.map((t) => ({ ...t, currency: t.currency as Currency }));
  const used = new Set(txns.filter((t) => t.date <= monthEnd).map((t) => t.accountId));
  return { accounts: accounts.filter((a) => used.has(a.id)), ledger };
}

export async function loadCheckInput(tx: Tx, year: number, month: number): Promise<DataCheckInput> {
  const { from, to } = monthRange(year, month);
  const [all, monthLines, rateRow, period, statements, used, bills, ffs, orders, history] = await Promise.all([
    loadGlLines(tx, { to }),
    loadGlLines(tx, { from, to, excludeClosing: true }),
    tx.fxRate.findFirst({ where: { base: "USD", quote: "VND", date: { lte: to } }, orderBy: { date: "desc" } }),
    tx.payrollPeriod.findUnique({ where: { year_month: { year, month } }, include: { lines: true } }),
    statementsNear(tx, to),
    usedAccounts(tx, to),
    tx.supplierBill.groupBy({ by: ["supplierId"], where: { issueDate: { gte: from, lte: to } }, _sum: { amountVnd: true } }),
    tx.fulfillmentOrder.groupBy({ by: ["supplierId"], where: { submittedAt: { gte: from, lte: to } }, _sum: { costUsd: true, shipUsd: true } }),
    tx.order.findMany({ where: { orderedAt: { gte: from, lte: to }, status: { not: "CANCELLED" } }, select: { _count: { select: { fulfillments: true } } } }),
    // từng TK kết quả theo tháng, 6 tháng trước — cho kiểm tra sai bậc độ lớn
    tx.$queryRaw<{ m: string; code: string; v: bigint }[]>`
      SELECT to_char(e."date", 'YYYY-MM') AS m, l."accountCode" AS code,
             ABS(SUM(l."debitVnd") - SUM(l."creditVnd"))::bigint AS v
      FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId" JOIN "Account" a ON a.code = l."accountCode"
      WHERE e."date" >= ${monthRange(year, month - 6).from} AND e."date" < ${from} AND e.source <> 'CLOSING'
        AND a."type"::text IN ('REVENUE', 'COGS', 'EXPENSE')
      GROUP BY 1, 2`,
  ]);
  const rate = rateRow?.rate.toString() ?? null;
  const supplierNames = new Map(
    (await tx.supplier.findMany({ where: { id: { in: ffs.map((f) => f.supplierId) } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]),
  );

  const tbAll = all.reduce((a, l) => a + l.debitVnd - l.creditVnd, 0n);
  const pnl = profitAndLoss(monthLines);
  const ledgerSalaryVnd = monthLines.filter((l) => l.accountCode === "601" || l.accountCode === "602").reduce((a, l) => a + l.debitVnd - l.creditVnd, 0n);
  const payrollOk = period && ["APPROVED", "PAID", "CLOSED"].includes(period.status);
  const payrollTotalVnd = payrollOk
    ? period!.lines.reduce((a, l) => a + l.netVnd + l.insuranceEmpVnd + l.pitVnd + l.penaltyVnd + l.insuranceCoVnd, 0n)
    : null;

  const cashAccounts = used.accounts.map((a) => {
    const st = statements.get(a.id);
    const cur = a.currency as Currency;
    const conv = (v: bigint) => (cur === "VND" ? v : rate ? toVnd(v, cur, rate) : 0n);
    return {
      code: a.code,
      name: a.name,
      ledgerVnd: conv(bookBalance(used.ledger, a.id, st?.date ?? to)),
      statementVnd: st ? conv(st.available) : null,
    };
  });

  const billed = new Map(bills.map((b) => [b.supplierId, b._sum.amountVnd ?? 0n]));
  const suppliers = ffs.map((f) => ({
    name: supplierNames.get(f.supplierId) ?? f.supplierId,
    billedVnd: billed.get(f.supplierId) ?? 0n,
    fulfillmentVnd: usdCentsToVnd(Number(f._sum.costUsd ?? 0) + Number(f._sum.shipUsd ?? 0), rate),
  }));

  // Sai bậc độ lớn: từng TK kết quả tháng này so với 6 tháng trước
  const prior = new Map<string, bigint[]>();
  for (const h of history) prior.set(h.code, [...(prior.get(h.code) ?? []), h.v]);
  const tb = new Map<string, { name: string; v: bigint }>();
  for (const l of monthLines) {
    if (!["REVENUE", "COGS", "EXPENSE"].includes(l.accountType)) continue;
    const cur = tb.get(l.accountCode) ?? { name: l.accountName, v: 0n };
    cur.v += l.debitVnd - l.creditVnd;
    tb.set(l.accountCode, cur);
  }
  const magnitudeChecks = [...tb.entries()].map(([code, x]) => ({
    label: `TK ${code} ${x.name}`,
    currentVnd: x.v < 0n ? -x.v : x.v,
    priorVnd: prior.get(code) ?? [],
    href: `/so-cai?tk=${code}&thang=${year}-${String(month).padStart(2, "0")}`,
  }));

  return {
    payrollTotalVnd,
    ledgerSalaryVnd,
    cashAccounts,
    suppliers,
    magnitudeChecks,
    totalOrders: orders.length,
    ordersWithCost: orders.filter((o) => o._count.fulfillments > 0).length,
    netProfitVnd: pnl.netProfitVnd,
    bonusPaidVnd: payrollOk ? period!.lines.reduce((a, l) => a + l.salesBonusVnd + l.perfPayVnd, 0n) : 0n,
    trialDiffVnd: tbAll,
  };
}

/** Chạy 7 kiểm tra và lưu lại. WARN/INFO đã đánh dấu "đã xem" ở lần chạy trước giữ nguyên trạng thái. */
export async function runChecks(tx: Tx, p: { year: number; month: number; actorId: string }) {
  const input = await loadCheckInput(tx, p.year, p.month);
  const results = runDataChecks(input);
  const last = await tx.dataCheckRun.findFirst({ where: { year: p.year, month: p.month }, orderBy: { runAt: "desc" }, include: { results: true } });
  const seen = new Map((last?.results ?? []).filter((r) => r.resolved && r.level !== "ERROR").map((r) => [`${r.code}|${r.title}`, r]));
  const closing = await tx.periodClosing.upsert({
    where: { year_month: { year: p.year, month: p.month } },
    create: { year: p.year, month: p.month, status: "CHECKING" },
    update: {},
  });
  const run = await tx.dataCheckRun.create({
    data: {
      year: p.year,
      month: p.month,
      runBy: p.actorId,
      closingId: closing.id,
      passed: 7 - new Set(results.map((r) => r.code.replace("CASH_NO_STATEMENT", "CASH_MISMATCH"))).size,
      failed: results.length,
      results: {
        create: results.map((r) => {
          const old = seen.get(`${r.code}|${r.title}`);
          return {
            code: r.code,
            level: r.level,
            title: r.title,
            detail: r.detail,
            diffVnd: r.diffVnd ?? null,
            href: r.href ?? null,
            resolved: !!old,
            resolvedBy: old?.resolvedBy ?? null,
            resolvedAt: old?.resolvedAt ?? null,
            note: old?.note ?? null,
          };
        }),
      },
    },
    include: { results: true },
  });
  if (closing.status === "OPEN") await tx.periodClosing.update({ where: { id: closing.id }, data: { status: "CHECKING" } });
  return { run, results };
}

/** Đánh dấu một cảnh báo WARN/INFO "đã xem, chấp nhận". Lỗi ERROR phải sửa số liệu rồi chạy lại. */
export async function resolveCheck(tx: Tx, p: { resultId: string; note: string; actorId: string }) {
  const r = await tx.dataCheckResult.findUniqueOrThrow({ where: { id: p.resultId } });
  if (r.level === "ERROR") throw new Error("Lỗi mức ERROR phải sửa số liệu rồi chạy lại kiểm tra — không đánh dấu bỏ qua được");
  if (!p.note.trim()) throw new Error("Ghi chú lý do chấp nhận");
  return tx.dataCheckResult.update({ where: { id: r.id }, data: { resolved: true, resolvedBy: p.actorId, resolvedAt: new Date(), note: p.note.trim() } });
}

export async function loadPreconditions(tx: Tx, year: number, month: number): Promise<Omit<ClosePrecondition, "checks">> {
  const { from, to } = monthRange(year, month);
  const [payouts, statements, used, period, employees, rules, runs] = await Promise.all([
    tx.payout.findMany({ where: { arrivedAt: { gte: from, lte: to } }, select: { reconciled: true, cashTxnId: true } }),
    statementsNear(tx, to),
    usedAccounts(tx, to),
    tx.payrollPeriod.findUnique({ where: { year_month: { year, month } } }),
    tx.employee.count({ where: { joinedAt: { lte: to }, OR: [{ leftAt: null }, { leftAt: { gte: from } }] } }),
    tx.allocationRule.findMany({ where: { active: true } }),
    tx.allocationRun.findMany({ where: { year, month } }),
  ]);
  const unrec = payouts.filter((x) => !x.reconciled).length;
  const missing = used.accounts.filter((a) => !statements.has(a.id)).map((a) => a.code);
  const noPeople = employees === 0;
  const ran = new Set(runs.map((r) => r.ruleId));
  const notRun = rules.filter((r) => !ran.has(r.id)).map((r) => r.name);
  return {
    payoutsReconciled: unrec === 0,
    cashStatementsEntered: missing.length === 0,
    attendanceApproved: noPeople || (!!period && period.status !== "DRAFT"),
    payrollClosed: noPeople || (!!period && ["APPROVED", "PAID", "CLOSED"].includes(period.status)),
    allocationsPosted: notRun.length === 0,
    details: {
      PAYOUT: unrec ? `${unrec}/${payouts.length} payout về trong tháng chưa khớp` : payouts.length ? `${payouts.length} payout đều khớp` : "Không có payout trong tháng",
      CASH: missing.length ? `Chưa chốt: ${missing.join(", ")}` : `${used.accounts.length} tài khoản đã chốt`,
      ATTENDANCE: noPeople ? "Không có nhân viên" : !period ? "Chưa tạo kỳ lương tháng này" : `Kỳ lương: ${period.status}`,
      PAYROLL: noPeople ? "Không có nhân viên" : !period ? "Chưa tạo kỳ lương" : `Kỳ lương: ${period.status} (cần đã duyệt — bút toán lương đã vào sổ)`,
      ALLOC: !rules.length ? "Chưa có quy tắc phân bổ nào" : notRun.length ? `Chưa chạy: ${notRun.join(", ")}` : `${rules.length} quy tắc đã chạy`,
    },
  };
}

/** Trạng thái màn 27: checklist + kết quả kiểm tra gần nhất (không chạy lại). */
export async function closingStatus(tx: Tx, year: number, month: number) {
  const [closing, lastRun, pre] = await Promise.all([
    tx.periodClosing.findUnique({ where: { year_month: { year, month } } }),
    tx.dataCheckRun.findFirst({ where: { year, month }, orderBy: { runAt: "desc" }, include: { results: { orderBy: [{ level: "desc" }, { code: "asc" }] } } }),
    loadPreconditions(tx, year, month),
  ]);
  const checks: CheckResult[] = (lastRun?.results ?? []).map((r) => ({ code: r.code, level: r.level, title: r.title, detail: r.detail }));
  const steps = closeChecklist({ ...pre, checks });
  if (!lastRun) {
    const s = steps.find((x) => x.code === "CHECKS")!;
    s.done = false;
    s.detail = "Chưa chạy kiểm tra";
  }
  return { closing, lastRun, steps, canClose: !!lastRun && canClose(steps, checks) };
}

/** Đóng sổ: chạy lại kiểm tra, kiểm checklist, ghi bút toán kết chuyển về 302, chụp báo cáo, khoá kỳ. */
export async function closePeriod(tx: Tx, p: { year: number; month: number; actorId: string }) {
  const existing = await tx.periodClosing.findUnique({ where: { year_month: { year: p.year, month: p.month } } });
  if (existing?.status === "CLOSED") throw new Error(`Kỳ ${p.month}/${p.year} đã đóng sổ`);
  const { results } = await runChecks(tx, p);
  const pre = await loadPreconditions(tx, p.year, p.month);
  const steps = closeChecklist({ ...pre, checks: results });
  if (!canClose(steps, results)) {
    const why = steps.filter((s) => s.blocking && !s.done).map((s) => `${s.title}${s.detail ? ` (${s.detail})` : ""}`);
    throw new Error(`Chưa đóng sổ được: ${why.join("; ")}`);
  }

  const { from, to } = monthRange(p.year, p.month);
  const pnl = profitAndLoss(await loadGlLines(tx, { from, to, excludeClosing: true }));
  const draft = buildClosingJournal(pnl);
  let journalId: string | null = null;
  if (draft.length >= 2) {
    assertBalanced(draft);
    const j = await createJournal(tx, {
      data: { date: to, memo: `Kết chuyển lãi lỗ ${p.month}/${p.year}`, source: "CLOSING", createdBy: p.actorId, lines: { create: draft } },
    });
    journalId = j.id;
  }
  const bs = balanceSheet(await loadGlLines(tx, { to }));
  for (const [kind, payload] of [
    ["PNL", pnl],
    ["BALANCE", bs],
  ] as const) {
    await tx.reportSnapshot.upsert({
      where: { kind_year_month: { kind, year: p.year, month: p.month } },
      create: { kind, year: p.year, month: p.month, payload: toJsonSafe(payload) as object },
      update: { payload: toJsonSafe(payload) as object, createdAt: new Date() },
    });
  }
  const closing = await tx.periodClosing.update({
    where: { year_month: { year: p.year, month: p.month } },
    data: {
      status: "CLOSED",
      revenueVnd: pnl.revenueVnd,
      cogsVnd: pnl.cogsVnd,
      expenseVnd: pnl.expenseVnd,
      profitVnd: pnl.netProfitVnd,
      journalId,
      closedBy: p.actorId,
      closedAt: new Date(),
    },
  });
  await audit(tx, { actorId: p.actorId, tableName: "PeriodClosing", recordId: closing.id, action: "UPDATE", before: existing, after: closing });
  return { closing, pnl };
}

/** Mở lại kỳ (chỉ Admin): đảo bút toán kết chuyển, kỳ về OPEN. Ghi lý do vào audit. */
export async function reopenPeriod(tx: Tx, p: { year: number; month: number; reason: string; actorId: string }) {
  if (!p.reason.trim()) throw new Error("Ghi lý do mở lại kỳ");
  const before = await tx.periodClosing.findUniqueOrThrow({ where: { year_month: { year: p.year, month: p.month } } });
  if (before.status !== "CLOSED") throw new Error("Kỳ chưa đóng");
  const later = await tx.periodClosing.findFirst({
    where: { status: "CLOSED", OR: [{ year: { gt: p.year } }, { year: p.year, month: { gt: p.month } }] },
  });
  if (later) throw new Error(`Phải mở lại kỳ ${later.month}/${later.year} trước (mở từ kỳ mới nhất về)`);
  // mở khoá trước để trigger cho ghi bút toán đảo vào chính kỳ này
  await tx.periodClosing.update({ where: { id: before.id }, data: { status: "OPEN" } });
  if (before.journalId) {
    const j = await tx.journalEntry.findUniqueOrThrow({ where: { id: before.journalId }, include: { lines: true } });
    await createJournal(tx, {
      data: {
        date: j.date,
        memo: `Mở lại kỳ ${p.month}/${p.year}: ${p.reason.trim()}`,
        source: "CLOSING",
        reversalOf: j.id,
        createdBy: p.actorId,
        lines: { create: reverseLines(j.lines.map((l) => ({ accountCode: l.accountCode, debitVnd: l.debitVnd, creditVnd: l.creditVnd }))) },
      },
    });
  }
  const after = await tx.periodClosing.update({ where: { id: before.id }, data: { journalId: null, closedAt: null, closedBy: null } });
  await audit(tx, { actorId: p.actorId, tableName: "PeriodClosing", recordId: before.id, action: "UPDATE", before, after: { ...after, reason: p.reason.trim() } });
  return after;
}
