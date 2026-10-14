// Nạp danh mục thật từ các CSV trong seed-data/ (pháp nhân, tài khoản tiền, shop, nhân viên, hợp đồng).
// Bản gốc: import-seed-data.ts gửi kèm CAN-NHAP-TAY.md — sửa cho khớp schema hiện tại:
//   - tài khoản tiền phải thuộc một nhóm (CashProvider) → tra theo TK kế toán / loại, không đoán
//   - shop gắn tài khoản nhận tiền (payoutAccountCode) và người phụ trách (ownerCode → User của nhân viên)
//   - hợp đồng qua addContract (đóng hợp đồng cũ, chạy lại không tạo trùng)
//   - ghi trong MỘT transaction: lỗi một chỗ thì không ghi gì
//
// Nguyên tắc giữ nguyên: dòng thiếu trường bắt buộc thì BỎ QUA và in ra, không đoán, không điền mặc định.
//
//   npm run import:seed                 chạy thử — không ghi gì
//   npm run import:seed -- --apply      ghi thật
//   npm run import:seed -- --dir <thư mục CSV>   (mặc định ./seed-data)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { audit } from "../src/lib/audit";
import { CHANNEL_CODES } from "../src/lib/channels";
import type { Tx } from "../src/lib/db";
import { addContract } from "../src/lib/hr";
import { parseCsv } from "../src/lib/order-import";

const db = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const dirArg = process.argv.indexOf("--dir");
const DIR = dirArg > 0 ? process.argv[dirArg + 1] : join(process.cwd(), "seed-data");
const ACTOR = "import-seed";

type Row = Record<string, string>;
type Issue = { file: string; key: string; why: string };
const skipped: Issue[] = [];
const warnings: Issue[] = [];

function load(name: string): Row[] {
  const p = join(DIR, name);
  if (!existsSync(p)) {
    console.log(`  (không thấy ${name}, bỏ qua)`);
    return [];
  }
  const rows = parseCsv(readFileSync(p, "utf8"));
  if (!rows.length) return [];
  const [head, ...body] = rows;
  const h = head.map((x) => x.replace(/^﻿/, "").trim());
  return body.map((r) => Object.fromEntries(h.map((k, i) => [k, (r[i] ?? "").trim()])));
}

function need(file: string, key: string, row: Row, fields: string[]): boolean {
  const missing = fields.filter((f) => !row[f]);
  if (missing.length) skipped.push({ file, key, why: `thiếu ${missing.join(", ")}` });
  return missing.length === 0;
}
const skip = (file: string, key: string, why: string) => (skipped.push({ file, key, why }), false);
const warn = (file: string, key: string, why: string) => warnings.push({ file, key, why });

const vnd = (v: string) => {
  const s = v.replace(/[.\s,]/g, "");
  if (!/^\d+$/.test(s)) throw new Error(`Số tiền "${v}" không hợp lệ`);
  return BigInt(s);
};
const date = (v: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`Ngày "${v}" phải dạng YYYY-MM-DD`);
  return new Date(`${v}T00:00:00Z`);
};

const ENTITY_KINDS = ["LLC", "HO_KINH_DOANH", "CONG_TY_TNHH"];
const ACCOUNT_KINDS = ["BANK", "EWALLET", "PLATFORM", "CASH"];
const SHOP_STATUSES = ["ACTIVE", "UNDER_REVIEW", "SUSPENDED", "DEACTIVATED", "CLOSED"];
const EMP_STATUSES = ["PROBATION", "OFFICIAL", "RESIGNED"];
const WORK_MODES = ["OFFICE", "ONLINE"];

async function run(tx: Tx) {
  const count: Record<string, string> = {};

  // 1. pháp nhân
  const entities = load("legal-entities.csv");
  let n = 0;
  for (const r of entities) {
    if (!need("legal-entities.csv", r.code, r, ["code", "name", "kind", "country"])) continue;
    if (!ENTITY_KINDS.includes(r.kind)) { skip("legal-entities.csv", r.code, `kind "${r.kind}" không hợp lệ (${ENTITY_KINDS.join(" | ")})`); continue; }
    const data = {
      name: r.name,
      kind: r.kind,
      country: r.country,
      taxCode: r.taxCode || null,
      renewalDate: r.renewalDate ? date(r.renewalDate) : null,
      annualCostVnd: r.annualCostVnd ? vnd(r.annualCostVnd) : null,
    };
    const e = await tx.legalEntity.upsert({ where: { code: r.code }, update: data, create: { code: r.code, ...data } });
    await audit(tx, { actorId: ACTOR, tableName: "LegalEntity", recordId: e.id, action: "UPDATE", after: e });
    n++;
  }
  count["Pháp nhân"] = `${n}/${entities.length}`;

  // 2. tài khoản tiền — nhóm (provider) tra theo TK kế toán, rồi theo loại; tài khoản đã có giữ nhóm cũ
  const providers = await tx.cashProvider.findMany();
  const accounts = load("payout-accounts.csv");
  n = 0;
  for (const r of accounts) {
    if (!need("payout-accounts.csv", r.code, r, ["code", "name", "kind", "currency", "glAccount"])) continue;
    if (!ACCOUNT_KINDS.includes(r.kind)) { skip("payout-accounts.csv", r.code, `kind "${r.kind}" không hợp lệ`); continue; }
    if (r.currency !== "VND" && r.currency !== "USD") { skip("payout-accounts.csv", r.code, `currency "${r.currency}" không hợp lệ`); continue; }
    if (!(await tx.account.findUnique({ where: { code: r.glAccount } }))) { skip("payout-accounts.csv", r.code, `TK kế toán ${r.glAccount} không tồn tại`); continue; }
    const existing = await tx.cashAccount.findUnique({ where: { code: r.code }, include: { _count: { select: { txns: true } } } });
    const provider =
      (existing && providers.find((p) => p.id === existing.providerId)) ??
      providers.find((p) => p.glAccount === r.glAccount) ??
      (["PLATFORM", "CASH"].includes(r.kind) ? providers.find((p) => p.kind === r.kind) : undefined);
    if (!provider) { skip("payout-accounts.csv", r.code, `không xác định được nhóm tài khoản cho TK ${r.glAccount} — tạo nhóm ở màn 8 trước`); continue; }
    if (existing && existing.currency !== r.currency) {
      if (existing._count.txns > 0) { skip("payout-accounts.csv", r.code, `đã có ${existing._count.txns} giao dịch bằng ${existing.currency} — không đổi sang ${r.currency} được`); continue; }
      warn("payout-accounts.csv", r.code, `đổi loại tiền ${existing.currency} → ${r.currency}`);
    }
    const entity = r.entityCode ? await tx.legalEntity.findUnique({ where: { code: r.entityCode } }) : null;
    if (r.entityCode && !entity) warn("payout-accounts.csv", r.code, `pháp nhân ${r.entityCode} chưa có — để trống`);
    const data = { name: r.name, kind: r.kind as never, currency: r.currency as never, glAccount: r.glAccount, providerId: provider.id, entityId: entity?.id ?? null };
    const a = await tx.cashAccount.upsert({ where: { code: r.code }, update: data, create: { code: r.code, ...data } });
    await audit(tx, { actorId: ACTOR, tableName: "CashAccount", recordId: a.id, action: "UPDATE", after: a });
    n++;
  }
  count["Tài khoản tiền"] = `${n}/${accounts.length}`;

  // 3. nhân viên (trước shop, để gán người phụ trách)
  const emps = load("employees.csv");
  n = 0;
  for (const r of emps) {
    if (!need("employees.csv", r.code, r, ["code", "fullName", "status", "workMode", "joinedAt"])) continue;
    if (!EMP_STATUSES.includes(r.status)) { skip("employees.csv", r.code, `status "${r.status}" không hợp lệ`); continue; }
    if (!WORK_MODES.includes(r.workMode)) { skip("employees.csv", r.code, `workMode "${r.workMode}" không hợp lệ`); continue; }
    if (r.status === "RESIGNED" && !r.leftAt) warn("employees.csv", r.code, "đã nghỉ nhưng chưa có leftAt — kỳ lương sau vẫn tính người này");
    const dept = r.departmentCode ? await tx.department.findUnique({ where: { code: r.departmentCode } }) : null;
    const pos = r.positionCode ? await tx.position.findUnique({ where: { code: r.positionCode } }) : null;
    if (r.departmentCode && !dept) warn("employees.csv", r.code, `phòng ban ${r.departmentCode} chưa có`);
    if (r.positionCode && !pos) warn("employees.csv", r.code, `chức danh ${r.positionCode} chưa có`);
    const data = {
      fullName: r.fullName,
      status: r.status as never,
      workMode: r.workMode as never,
      departmentId: dept?.id ?? null,
      positionId: pos?.id ?? null,
      joinedAt: date(r.joinedAt),
      leftAt: r.leftAt ? date(r.leftAt) : null,
      bankAccount: r.bankAccount || null,
      bankName: r.bankName || null,
    };
    const e = await tx.employee.upsert({ where: { code: r.code }, update: data, create: { code: r.code, ...data } });
    await audit(tx, { actorId: ACTOR, tableName: "Employee", recordId: e.id, action: "UPDATE", after: e });
    n++;
  }
  // người quản lý — lượt hai, khi mọi nhân viên đã có
  for (const r of emps.filter((x) => x.managerCode)) {
    const [e, m] = await Promise.all([tx.employee.findUnique({ where: { code: r.code } }), tx.employee.findUnique({ where: { code: r.managerCode } })]);
    if (!e) continue;
    if (!m) { warn("employees.csv", r.code, `quản lý ${r.managerCode} chưa có`); continue; }
    await tx.employee.update({ where: { id: e.id }, data: { managerId: m.id } });
  }
  count["Nhân viên"] = `${n}/${emps.length}`;

  // 4. shop — kênh bắt buộc; GĐ3 cần tài khoản nhận tiền; pháp nhân / người phụ trách thiếu thì cảnh báo
  const shops = load("shops.csv");
  n = 0;
  for (const r of shops) {
    if (!need("shops.csv", r.code, r, ["code", "name", "channel", "payoutAccountCode"])) continue;
    if (!CHANNEL_CODES.includes(r.channel as never)) { skip("shops.csv", r.code, `channel "${r.channel}" không hợp lệ (${CHANNEL_CODES.join(" | ")})`); continue; }
    const status = r.status || "ACTIVE";
    if (!SHOP_STATUSES.includes(status)) { skip("shops.csv", r.code, `status "${status}" không hợp lệ`); continue; }
    const acc = await tx.cashAccount.findUnique({ where: { code: r.payoutAccountCode } });
    if (!acc) { skip("shops.csv", r.code, `tài khoản nhận tiền ${r.payoutAccountCode} chưa có`); continue; }
    const entity = r.entityCode ? await tx.legalEntity.findUnique({ where: { code: r.entityCode } }) : null;
    if (!entity) warn("shops.csv", r.code, r.entityCode ? `pháp nhân ${r.entityCode} chưa có — để trống` : "chưa có pháp nhân — điền ở màn 16");
    let ownerId: string | null = null;
    if (r.ownerCode) {
      const emp = await tx.employee.findUnique({ where: { code: r.ownerCode } });
      if (!emp) warn("shops.csv", r.code, `người phụ trách ${r.ownerCode} chưa có`);
      else if (!emp.userId) warn("shops.csv", r.code, `${r.ownerCode} chưa có tài khoản đăng nhập — chưa gán phụ trách`);
      else ownerId = emp.userId;
    } else warn("shops.csv", r.code, `chưa có người phụ trách (file ghi "${r.nguoi_phu_trach_trong_file || "—"}")`);
    const data = {
      name: r.name,
      channel: r.channel,
      status,
      entityId: entity?.id ?? null,
      ownerId,
      payoutAccountId: acc.id,
      openedAt: r.openedAt ? date(r.openedAt) : null,
    };
    const s = await tx.shop.upsert({ where: { code: r.code }, update: data, create: { code: r.code, ...data } });
    await audit(tx, { actorId: ACTOR, tableName: "Shop", recordId: s.id, action: "UPDATE", after: s });
    n++;
  }
  count["Shop"] = `${n}/${shops.length}`;

  // 5. hợp đồng — cùng nhân viên + ngày hiệu lực đã có thì bỏ qua (chạy lại không tạo trùng)
  const contracts = load("contracts.csv");
  n = 0;
  for (const r of contracts) {
    if (!need("contracts.csv", r.employeeCode, r, ["employeeCode", "effectiveFrom", "baseSalaryVnd", "insuranceSalaryVnd"])) continue;
    const emp = await tx.employee.findUnique({ where: { code: r.employeeCode } });
    if (!emp) { skip("contracts.csv", r.employeeCode, "nhân viên chưa có (dòng employees.csv bị bỏ qua?)"); continue; }
    const from = date(r.effectiveFrom);
    if (await tx.employmentContract.findFirst({ where: { employeeId: emp.id, effectiveFrom: from } })) {
      warn("contracts.csv", r.employeeCode, "đã có hợp đồng cùng ngày hiệu lực — giữ nguyên");
      continue;
    }
    // effectiveTo không nhập: hợp đồng chỉ đóng khi có hợp đồng mới (addContract tự đóng), như màn 10
    if (r.effectiveTo) warn("contracts.csv", r.employeeCode, "bỏ qua effectiveTo — nghỉ việc ghi leftAt ở employees.csv");
    await addContract(tx, {
      employeeId: emp.id,
      effectiveFrom: from,
      baseSalaryVnd: vnd(r.baseSalaryVnd),
      allowanceVnd: r.allowanceVnd ? vnd(r.allowanceVnd) : 0n,
      mealVnd: r.mealVnd ? vnd(r.mealVnd) : 0n,
      transportVnd: r.transportVnd ? vnd(r.transportVnd) : 0n,
      dutyVnd: r.dutyVnd ? vnd(r.dutyVnd) : 0n,
      insuranceSalaryVnd: vnd(r.insuranceSalaryVnd),
      dependents: r.dependents ? Number(r.dependents) : 0,
      note: "Nhập từ seed-data",
      actorId: ACTOR,
    });
    n++;
  }
  count["Hợp đồng"] = `${n}/${contracts.length}`;
  return count;
}

class DryRun extends Error {}

async function main() {
  console.log(APPLY ? ">> GHI THẬT\n" : ">> CHẠY THỬ — không ghi gì vào database\n");
  console.log(`Thư mục CSV: ${DIR}\n`);
  let count: Record<string, string> = {};
  try {
    // Chạy thử cũng đi hết logic trong transaction (bắt được lỗi ràng buộc DB) rồi rollback.
    await db.$transaction(
      async (tx) => {
        count = await run(tx);
        if (!APPLY) throw new DryRun();
      },
      { timeout: 120_000 },
    );
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
  }
  for (const [k, v] of Object.entries(count)) console.log(`${k.padEnd(15)}: ${v}`);

  const report = (title: string, list: Issue[]) => {
    if (!list.length) return;
    console.log(`\n=== ${title} (${list.length}) ===`);
    const byFile = new Map<string, Issue[]>();
    for (const s of list) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
    for (const [file, items] of byFile) {
      console.log(`\n${file}`);
      const byWhy = new Map<string, string[]>();
      for (const s of items) byWhy.set(s.why, [...(byWhy.get(s.why) ?? []), s.key]);
      for (const [why, keys] of byWhy) console.log(`  ${why}\n    ${keys.join(", ")}`);
    }
  };
  report("DÒNG BỊ BỎ QUA — điền rồi chạy lại", skipped);
  report("CẢNH BÁO — đã nhập nhưng nên bổ sung", warnings);
  if (!skipped.length) console.log("\nMọi dòng đều đủ trường bắt buộc.");
  if (!APPLY) console.log("\n(Chạy thử — chưa ghi gì. Thêm --apply để ghi thật.)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
