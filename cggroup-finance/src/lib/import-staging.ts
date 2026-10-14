// Màn 30 — dữ liệu ban đầu chờ chốt. CSV seed-data/ vào bảng ImportRow (dòng thiếu vẫn vào),
// người dùng điền nốt trên web, "Chốt" = kiểm đủ → ghi vào bảng thật → khoá dòng (trigger import_row_locked).
// Không đoán, không điền mặc định thay người dùng.
import { audit } from "./audit";
import { CHANNEL_CODES, channelLabel } from "./channels";
import type { Tx } from "./db";
import { addContract } from "./hr";

export type Kind = "ENTITY" | "ACCOUNT" | "EMPLOYEE" | "SHOP" | "CONTRACT";
export const KINDS: Kind[] = ["ENTITY", "ACCOUNT", "EMPLOYEE", "SHOP", "CONTRACT"];
export const KIND_VI: Record<Kind, string> = { ENTITY: "Pháp nhân", ACCOUNT: "Tài khoản tiền", EMPLOYEE: "Nhân viên", SHOP: "Shop", CONTRACT: "Hợp đồng" };
/** Thứ tự chốt: dòng sau tham chiếu dòng trước. */
export const CSV_FILE: Record<Kind, string> = {
  ENTITY: "legal-entities.csv",
  ACCOUNT: "payout-accounts.csv",
  EMPLOYEE: "employees.csv",
  SHOP: "shops.csv",
  CONTRACT: "contracts.csv",
};

export type FieldType = "text" | "date" | "money" | "int" | "select";
export type Field = { name: string; label: string; required?: boolean; type: FieldType; options?: string; help?: string };

/** options = tên danh sách lựa chọn (xem loadOptions). */
export const FIELDS: Record<Kind, Field[]> = {
  ENTITY: [
    { name: "name", label: "Tên", required: true, type: "text" },
    { name: "kind", label: "Loại", required: true, type: "select", options: "entityKind" },
    { name: "country", label: "Quốc gia", required: true, type: "text", help: "VD: US, VN" },
    { name: "taxCode", label: "Mã số thuế", type: "text" },
    { name: "renewalDate", label: "Ngày gia hạn", type: "date", help: "Vào dự báo dòng tiền" },
    { name: "annualCostVnd", label: "Phí duy trì/năm (VND)", type: "money" },
  ],
  ACCOUNT: [
    { name: "name", label: "Tên", required: true, type: "text" },
    { name: "providerCode", label: "Nhóm", required: true, type: "select", options: "provider" },
    { name: "kind", label: "Loại", required: true, type: "select", options: "accountKind" },
    { name: "currency", label: "Tiền", required: true, type: "select", options: "currency" },
    { name: "glAccount", label: "TK kế toán", required: true, type: "select", options: "assetGl" },
    { name: "email", label: "Email đăng nhập", type: "text" },
    { name: "entityCode", label: "Pháp nhân", type: "select", options: "entity" },
  ],
  EMPLOYEE: [
    { name: "fullName", label: "Họ tên", required: true, type: "text" },
    { name: "status", label: "Tình trạng", required: true, type: "select", options: "empStatus" },
    { name: "workMode", label: "Hình thức", required: true, type: "select", options: "workMode" },
    { name: "joinedAt", label: "Ngày vào làm", required: true, type: "date" },
    { name: "leftAt", label: "Ngày nghỉ", type: "date" },
    { name: "departmentCode", label: "Phòng ban", type: "select", options: "department" },
    { name: "positionCode", label: "Chức danh", type: "select", options: "position" },
    { name: "managerCode", label: "Quản lý", type: "select", options: "employee" },
    { name: "bankAccount", label: "Số TK ngân hàng", type: "text" },
    { name: "bankName", label: "Ngân hàng", type: "text" },
  ],
  SHOP: [
    { name: "name", label: "Tên", required: true, type: "text" },
    { name: "channel", label: "Kênh", required: true, type: "select", options: "channel" },
    { name: "status", label: "Trạng thái", required: true, type: "select", options: "shopStatus" },
    { name: "payoutAccountCode", label: "Tài khoản nhận tiền", required: true, type: "select", options: "account" },
    { name: "entityCode", label: "Pháp nhân", type: "select", options: "entity" },
    { name: "ownerCode", label: "Người phụ trách", type: "select", options: "employee", help: "Cần nhân viên có tài khoản đăng nhập" },
    { name: "openedAt", label: "Ngày mở", type: "date" },
  ],
  CONTRACT: [
    { name: "effectiveFrom", label: "Hiệu lực từ", required: true, type: "date", help: "Tính lương tháng nào thì phải ≤ ngày 1 tháng đó" },
    { name: "baseSalaryVnd", label: "Lương cứng", required: true, type: "money" },
    { name: "allowanceVnd", label: "Phụ cấp", type: "money" },
    { name: "mealVnd", label: "Tiền ăn", type: "money" },
    { name: "transportVnd", label: "Xăng xe", type: "money" },
    { name: "dutyVnd", label: "Trách nhiệm", type: "money" },
    { name: "insuranceSalaryVnd", label: "Mức đóng BHXH", required: true, type: "money", help: "0 nếu không đóng" },
    { name: "dependents", label: "Người phụ thuộc", type: "int" },
  ],
};

/** Cột CSV là gợi ý / ghi chú — gộp vào note để đọc, không ghi vào bảng thật. */
const NOTE_COLS = ["ghi_chu", "nguoi_phu_trach_trong_file", "insuranceSalaryVnd_goi_y", "bhxh_thang8_tham_khao", "bankAccountNo", "currency_trong_file"];
const NOTE_VI: Record<string, string> = {
  ghi_chu: "Ghi chú",
  nguoi_phu_trach_trong_file: "Phụ trách trong file",
  insuranceSalaryVnd_goi_y: "Gợi ý mức BHXH",
  bhxh_thang8_tham_khao: "BHXH T8 đã trừ",
  bankAccountNo: "Số TK nhận",
  currency_trong_file: "Tiền trong file",
};

export const STATIC_OPTIONS: Record<string, { value: string; label: string }[]> = {
  entityKind: [
    { value: "LLC", label: "LLC" },
    { value: "HO_KINH_DOANH", label: "Hộ kinh doanh" },
    { value: "CONG_TY_TNHH", label: "Công ty TNHH" },
  ],
  accountKind: [
    { value: "BANK", label: "Ngân hàng" },
    { value: "EWALLET", label: "Ví điện tử" },
    { value: "PLATFORM", label: "Số dư trên sàn" },
    { value: "CASH", label: "Tiền mặt" },
  ],
  currency: [
    { value: "VND", label: "VND" },
    { value: "USD", label: "USD" },
  ],
  empStatus: [
    { value: "PROBATION", label: "Thử việc" },
    { value: "OFFICIAL", label: "Chính thức" },
    { value: "RESIGNED", label: "Đã nghỉ" },
  ],
  workMode: [
    { value: "OFFICE", label: "Văn phòng" },
    { value: "ONLINE", label: "Online" },
  ],
  channel: CHANNEL_CODES.map((c) => ({ value: c, label: channelLabel(c) })),
  shopStatus: ["ACTIVE", "UNDER_REVIEW", "SUSPENDED", "DEACTIVATED", "CLOSED"].map((s) => ({ value: s, label: s })),
};

/** Lựa chọn tham chiếu: bản ghi thật + dòng đang chờ chốt (đánh dấu "chưa chốt"). */
export async function loadOptions(tx: Tx) {
  const [providers, gls, entities, accounts, employees, depts, positions, staged] = await Promise.all([
    tx.cashProvider.findMany({ orderBy: { name: "asc" } }),
    tx.account.findMany({ where: { type: "ASSET" }, orderBy: { code: "asc" } }),
    tx.legalEntity.findMany({ orderBy: { code: "asc" } }),
    tx.cashAccount.findMany({ orderBy: { code: "asc" } }),
    tx.employee.findMany({ orderBy: { code: "asc" } }),
    tx.department.findMany({ orderBy: { code: "asc" } }),
    tx.position.findMany({ orderBy: { code: "asc" } }),
    tx.importRow.findMany({ where: { status: "DRAFT" }, select: { kind: true, key: true, data: true } }),
  ]);
  const withStaged = (real: { value: string; label: string }[], kind: Kind, label: (d: Record<string, string>) => string) => {
    const have = new Set(real.map((r) => r.value));
    const extra = staged.filter((s) => s.kind === kind && !have.has(s.key)).map((s) => ({ value: s.key, label: `${s.key} · ${label(s.data as Record<string, string>)} (chưa chốt)` }));
    return [...real, ...extra];
  };
  return {
    ...STATIC_OPTIONS,
    provider: providers.map((p) => ({ value: p.code, label: p.name })),
    assetGl: gls.map((a) => ({ value: a.code, label: `${a.code} ${a.name}` })),
    entity: withStaged(entities.map((e) => ({ value: e.code, label: `${e.code} · ${e.name}` })), "ENTITY", (d) => d.name ?? ""),
    account: withStaged(accounts.map((a) => ({ value: a.code, label: `${a.code} · ${a.name} (${a.currency})` })), "ACCOUNT", (d) => d.name ?? ""),
    employee: withStaged(employees.map((e) => ({ value: e.code, label: `${e.code} · ${e.fullName}` })), "EMPLOYEE", (d) => d.fullName ?? ""),
    department: depts.map((d) => ({ value: d.code, label: d.name })),
    position: positions.map((p) => ({ value: p.code, label: p.name })),
  } as Record<string, { value: string; label: string }[]>;
}

// ─────────────────────────── kiểm tra

const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const isMoney = (v: string) => /^\d+$/.test(v.replace(/[.\s,]/g, ""));

/** Lỗi hình thức của một dòng (thiếu trường bắt buộc, sai định dạng, giá trị ngoài danh sách). */
export function validate(kind: Kind, data: Record<string, string>): string[] {
  const errs: string[] = [];
  for (const f of FIELDS[kind]) {
    const v = (data[f.name] ?? "").trim();
    if (!v) {
      if (f.required) errs.push(`Thiếu ${f.label.toLowerCase()}`);
      continue;
    }
    if (f.type === "date" && !isDate(v)) errs.push(`${f.label}: ngày phải dạng YYYY-MM-DD`);
    if (f.type === "money" && !isMoney(v)) errs.push(`${f.label}: số tiền không hợp lệ`);
    if (f.type === "int" && !/^\d+$/.test(v)) errs.push(`${f.label}: phải là số nguyên`);
    const opts = f.options ? STATIC_OPTIONS[f.options] : undefined;
    if (opts && !opts.some((o) => o.value === v)) errs.push(`${f.label}: "${v}" không hợp lệ`);
  }
  if (kind === "EMPLOYEE" && data.status === "RESIGNED" && !data.leftAt) errs.push("Đã nghỉ thì cần ngày nghỉ");
  if (kind === "EMPLOYEE" && data.leftAt && data.joinedAt && data.leftAt < data.joinedAt) errs.push("Ngày nghỉ trước ngày vào làm");
  return errs;
}

// ─────────────────────────── đưa CSV vào vùng chờ

export type CsvRow = Record<string, string>;

/** Một dòng CSV → (key, data, note). Cột không thuộc FIELDS mà là gợi ý thì vào note. */
export function fromCsv(kind: Kind, r: CsvRow): { key: string; data: Record<string, string>; note: string | null } {
  const key = kind === "CONTRACT" ? r.employeeCode : r.code;
  const data: Record<string, string> = {};
  for (const f of FIELDS[kind]) data[f.name] = (r[f.name] ?? "").trim();
  if (kind === "SHOP" && !data.status) data.status = "ACTIVE"; // file chỉ ghi trạng thái khi khác bình thường
  const extra: CsvRow = { ...r, ...(kind === "SHOP" && r.currency ? { currency_trong_file: r.currency } : {}) };
  const note = NOTE_COLS.filter((c) => extra[c]?.trim()).map((c) => `${NOTE_VI[c]}: ${extra[c].trim()}`).join(" · ");
  return { key: (key ?? "").trim(), data, note: note || null };
}

/**
 * Thêm dòng chờ chốt. Dòng đã có (đang sửa trên web hoặc đã chốt) giữ nguyên — chạy lại import
 * không đè chỗ người dùng đã sửa. Tài khoản tiền: gợi ý sẵn nhóm theo TK kế toán / tài khoản đã có.
 */
export async function stageRows(tx: Tx, kind: Kind, rows: CsvRow[], actorId: string) {
  let added = 0;
  let kept = 0;
  const providers = kind === "ACCOUNT" ? await tx.cashProvider.findMany() : [];
  for (const r of rows) {
    const s = fromCsv(kind, r);
    if (!s.key) continue;
    if (await tx.importRow.findUnique({ where: { kind_key: { kind, key: s.key } } })) {
      kept++;
      continue;
    }
    if (kind === "ACCOUNT") {
      const existing = await tx.cashAccount.findUnique({ where: { code: s.key }, include: { provider: true } });
      const p = existing?.provider ?? providers.find((x) => x.glAccount === s.data.glAccount) ?? providers.find((x) => x.kind === s.data.kind && ["PLATFORM", "CASH"].includes(x.kind));
      if (p) s.data.providerCode = p.code;
      if (!s.data.email && existing?.email) s.data.email = existing.email;
    }
    await tx.importRow.create({ data: { kind, key: s.key, data: s.data, note: s.note, updatedBy: actorId } });
    added++;
  }
  return { added, kept };
}

/** Lưu nháp từ form web. */
export async function saveDraft(tx: Tx, p: { id: string; data: Record<string, string>; actorId: string }) {
  const row = await tx.importRow.findUniqueOrThrow({ where: { id: p.id } });
  if (row.status === "LOCKED") throw new Error("Dòng đã chốt — không sửa được nữa");
  const kind = row.kind as Kind;
  const data: Record<string, string> = {};
  for (const f of FIELDS[kind]) data[f.name] = (p.data[f.name] ?? "").trim();
  return tx.importRow.update({ where: { id: row.id }, data: { data, updatedBy: p.actorId } });
}

// ─────────────────────────── chốt: ghi bảng thật rồi khoá

const date = (v: string) => new Date(`${v}T00:00:00Z`);
const money = (v: string) => (v ? BigInt(v.replace(/[.\s,]/g, "")) : 0n);
const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

async function mustRef<T>(p: Promise<T | null>, what: string): Promise<T> {
  const x = await p;
  if (!x) throw new Error(`${what} chưa có trong danh mục — chốt dòng đó trước`);
  return x;
}

/** Ghi một dòng vào bảng thật. Trả id bản ghi + cảnh báo (không chặn). */
async function writeTarget(tx: Tx, kind: Kind, key: string, d: Record<string, string>, actorId: string): Promise<{ id: string; warnings: string[] }> {
  const warnings: string[] = [];
  if (kind === "ENTITY") {
    const data = { name: d.name, kind: d.kind, country: d.country, taxCode: opt(d.taxCode), renewalDate: d.renewalDate ? date(d.renewalDate) : null, annualCostVnd: d.annualCostVnd ? money(d.annualCostVnd) : null };
    const e = await tx.legalEntity.upsert({ where: { code: key }, update: data, create: { code: key, ...data } });
    await audit(tx, { actorId, tableName: "LegalEntity", recordId: e.id, action: "UPDATE", after: e });
    return { id: e.id, warnings };
  }
  if (kind === "ACCOUNT") {
    const provider = await mustRef(tx.cashProvider.findUnique({ where: { code: d.providerCode } }), `Nhóm ${d.providerCode}`);
    if (!(await tx.account.findUnique({ where: { code: d.glAccount } }))) throw new Error(`TK kế toán ${d.glAccount} không tồn tại`);
    const entity = d.entityCode ? await mustRef(tx.legalEntity.findUnique({ where: { code: d.entityCode } }), `Pháp nhân ${d.entityCode}`) : null;
    const existing = await tx.cashAccount.findUnique({ where: { code: key }, include: { _count: { select: { txns: true } } } });
    if (existing && existing.currency !== d.currency && existing._count.txns > 0) {
      throw new Error(`Tài khoản đã có ${existing._count.txns} giao dịch bằng ${existing.currency} — không đổi sang ${d.currency} được`);
    }
    const data = { name: d.name, kind: d.kind as never, currency: d.currency as never, glAccount: d.glAccount, providerId: provider.id, entityId: entity?.id ?? null, email: opt(d.email) };
    const a = await tx.cashAccount.upsert({ where: { code: key }, update: data, create: { code: key, ...data } });
    await audit(tx, { actorId, tableName: "CashAccount", recordId: a.id, action: "UPDATE", after: a });
    return { id: a.id, warnings };
  }
  if (kind === "EMPLOYEE") {
    const dept = d.departmentCode ? await mustRef(tx.department.findUnique({ where: { code: d.departmentCode } }), `Phòng ban ${d.departmentCode}`) : null;
    const pos = d.positionCode ? await mustRef(tx.position.findUnique({ where: { code: d.positionCode } }), `Chức danh ${d.positionCode}`) : null;
    const mgr = d.managerCode ? await mustRef(tx.employee.findUnique({ where: { code: d.managerCode } }), `Quản lý ${d.managerCode}`) : null;
    const data = {
      fullName: d.fullName,
      status: d.status as never,
      workMode: d.workMode as never,
      joinedAt: date(d.joinedAt),
      leftAt: d.leftAt ? date(d.leftAt) : null,
      departmentId: dept?.id ?? null,
      positionId: pos?.id ?? null,
      managerId: mgr?.id ?? null,
      bankAccount: opt(d.bankAccount),
      bankName: opt(d.bankName),
    };
    const e = await tx.employee.upsert({ where: { code: key }, update: data, create: { code: key, ...data } });
    await audit(tx, { actorId, tableName: "Employee", recordId: e.id, action: "UPDATE", after: e });
    return { id: e.id, warnings };
  }
  if (kind === "SHOP") {
    const acc = await mustRef(tx.cashAccount.findUnique({ where: { code: d.payoutAccountCode } }), `Tài khoản ${d.payoutAccountCode}`);
    const entity = d.entityCode ? await mustRef(tx.legalEntity.findUnique({ where: { code: d.entityCode } }), `Pháp nhân ${d.entityCode}`) : null;
    if (!entity) warnings.push("chưa có pháp nhân — điền ở màn 16");
    let ownerId: string | null = null;
    if (d.ownerCode) {
      const emp = await mustRef(tx.employee.findUnique({ where: { code: d.ownerCode } }), `Nhân viên ${d.ownerCode}`);
      if (emp.userId) ownerId = emp.userId;
      else warnings.push(`${d.ownerCode} chưa có tài khoản đăng nhập — chưa gán người phụ trách`);
    }
    const data = { name: d.name, channel: d.channel, status: d.status, payoutAccountId: acc.id, entityId: entity?.id ?? null, ownerId, openedAt: d.openedAt ? date(d.openedAt) : null };
    const s = await tx.shop.upsert({ where: { code: key }, update: data, create: { code: key, ...data } });
    await audit(tx, { actorId, tableName: "Shop", recordId: s.id, action: "UPDATE", after: s });
    return { id: s.id, warnings };
  }
  // CONTRACT
  const emp = await mustRef(tx.employee.findUnique({ where: { code: key } }), `Nhân viên ${key}`);
  const from = date(d.effectiveFrom);
  const same = await tx.employmentContract.findFirst({ where: { employeeId: emp.id, effectiveFrom: from } });
  if (same) return { id: same.id, warnings: ["đã có hợp đồng cùng ngày hiệu lực — giữ nguyên"] };
  const c = await addContract(tx, {
    employeeId: emp.id,
    effectiveFrom: from,
    baseSalaryVnd: money(d.baseSalaryVnd),
    allowanceVnd: money(d.allowanceVnd),
    mealVnd: money(d.mealVnd),
    transportVnd: money(d.transportVnd),
    dutyVnd: money(d.dutyVnd),
    insuranceSalaryVnd: money(d.insuranceSalaryVnd),
    dependents: d.dependents ? Number(d.dependents) : 0,
    note: "Dữ liệu ban đầu (màn 30)",
    actorId,
  });
  return { id: c.id, warnings };
}

/** Chốt: kiểm đủ → ghi bảng thật → khoá dòng. Lỗi thì không ghi gì (gọi trong transaction). */
export async function commitRow(tx: Tx, p: { id: string; actorId: string }) {
  const row = await tx.importRow.findUniqueOrThrow({ where: { id: p.id } });
  if (row.status === "LOCKED") throw new Error(`${row.key} đã chốt`);
  const kind = row.kind as Kind;
  const data = row.data as Record<string, string>;
  const errs = validate(kind, data);
  if (errs.length) throw new Error(`${KIND_VI[kind]} ${row.key}: ${errs.join("; ")}`);
  const { id, warnings } = await writeTarget(tx, kind, row.key, data, p.actorId);
  await tx.importRow.update({
    where: { id: row.id },
    data: {
      status: "LOCKED",
      targetId: id,
      lockedBy: p.actorId,
      lockedAt: new Date(),
      note: warnings.length ? [row.note, `Khi chốt: ${warnings.join("; ")}`].filter(Boolean).join(" · ") : row.note,
    },
  });
  return { id, warnings };
}

/** Màn nghiệp vụ để sửa tiếp sau khi chốt. */
export const TARGET_HREF: Record<Kind, string> = {
  ENTITY: "/shop",
  ACCOUNT: "/danh-muc/nhom-tai-khoan-tien",
  EMPLOYEE: "/nhan-su",
  SHOP: "/shop",
  CONTRACT: "/hop-dong",
};
