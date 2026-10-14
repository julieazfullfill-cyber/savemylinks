import { vi } from "vitest";

// Schema riêng của file này (xem tests/global-setup.ts) — phải chạy trước khi Prisma kết nối.
vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DB_URL_IMPORT_STAGING;
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { commitRow, saveDraft, stageRows } from "@/lib/import-staging";
import { seedCatalog } from "../prisma/seed-data";

const A = "tester";
const row = (kind: string, key: string) => prisma.importRow.findUniqueOrThrow({ where: { kind_key: { kind, key } } });

beforeAll(async () => {
  await seedCatalog(prisma);
  await prisma.$transaction(async (tx) => {
    await stageRows(tx, "ACCOUNT", [{ code: "AWHK2", name: "Airwallex HK 2", kind: "EWALLET", currency: "USD", glAccount: "103", ghi_chu: "69% doanh thu" }], A);
    await stageRows(tx, "SHOP", [{ code: "LTT", name: "Lê Thị Tâm", channel: "", payoutAccountCode: "AWHK2", nguoi_phu_trach_trong_file: "Quỳnh Anh" }], A);
    await stageRows(tx, "EMPLOYEE", [{ code: "T1-NV01", fullName: "Dương Thành Công", status: "OFFICIAL", workMode: "OFFICE", joinedAt: "" }], A);
  });
});
afterAll(() => prisma.$disconnect());

describe("dữ liệu ban đầu chờ chốt", () => {
  it("dòng thiếu vẫn vào vùng chờ; gợi ý sẵn nhóm tài khoản; cột ghi chú vào note", async () => {
    const acc = await row("ACCOUNT", "AWHK2");
    expect((acc.data as Record<string, string>).providerCode).toBe("AIRWALLEX");
    expect(acc.note).toBe("Ghi chú: 69% doanh thu");
    expect((await row("SHOP", "LTT")).note).toContain("Quỳnh Anh");
    expect((await row("SHOP", "LTT")).status).toBe("DRAFT");
  });

  it("chốt dòng còn thiếu thì báo lỗi, không ghi gì", async () => {
    const e = await row("EMPLOYEE", "T1-NV01");
    await expect(prisma.$transaction((tx) => commitRow(tx, { id: e.id, actorId: A }))).rejects.toThrow(/ngày vào làm/);
    expect(await prisma.employee.count({ where: { code: "T1-NV01" } })).toBe(0);
  });

  it("chốt shop trước tài khoản → báo phải chốt tài khoản trước", async () => {
    const s = await row("SHOP", "LTT");
    await prisma.$transaction((tx) => saveDraft(tx, { id: s.id, data: { ...(s.data as Record<string, string>), channel: "ETSY" }, actorId: A }));
    await expect(prisma.$transaction((tx) => commitRow(tx, { id: s.id, actorId: A }))).rejects.toThrow(/chốt dòng đó trước/);
  });

  it("chốt: ghi bảng thật rồi khoá — DB chặn sửa / xoá dòng đã chốt", async () => {
    const acc = await row("ACCOUNT", "AWHK2");
    await prisma.$transaction((tx) => commitRow(tx, { id: acc.id, actorId: A }));
    const s = await row("SHOP", "LTT");
    const r = await prisma.$transaction((tx) => commitRow(tx, { id: s.id, actorId: A }));
    expect(r.warnings).toContain("chưa có pháp nhân — điền ở màn 16");
    const shop = await prisma.shop.findUniqueOrThrow({ where: { code: "LTT" }, include: { payoutAccount: true } });
    expect(shop).toMatchObject({ channel: "ETSY", status: "ACTIVE" });
    expect(shop.payoutAccount?.code).toBe("AWHK2");
    expect((await row("SHOP", "LTT")).status).toBe("LOCKED");

    await expect(prisma.$transaction((tx) => saveDraft(tx, { id: s.id, data: {}, actorId: A }))).rejects.toThrow(/đã chốt/);
    await expect(prisma.importRow.update({ where: { id: s.id }, data: { note: "lách" } })).rejects.toThrow(/đã chốt/);
    await expect(prisma.importRow.delete({ where: { id: s.id } })).rejects.toThrow(/đã chốt/);
  });

  it("chạy import lại không đè chỗ đã sửa trên web", async () => {
    const e = await row("EMPLOYEE", "T1-NV01");
    await prisma.$transaction((tx) => saveDraft(tx, { id: e.id, data: { ...(e.data as Record<string, string>), joinedAt: "2025-03-01" }, actorId: A }));
    const r = await prisma.$transaction((tx) =>
      stageRows(tx, "EMPLOYEE", [{ code: "T1-NV01", fullName: "Dương Thành Công", status: "OFFICIAL", workMode: "OFFICE", joinedAt: "" }], A),
    );
    expect(r).toEqual({ added: 0, kept: 1 });
    expect(((await row("EMPLOYEE", "T1-NV01")).data as Record<string, string>).joinedAt).toBe("2025-03-01");
  });
});
