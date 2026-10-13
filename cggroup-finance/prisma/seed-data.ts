// Danh mục khởi tạo — đặc tả mục 03. Idempotent: chạy lại chỉ cập nhật, không nhân bản.
// Rà soát lại theo thực tế trong GĐ0 (hạn 18/10 và 22/10) rồi sửa ở đây hoặc qua màn hình Danh mục.
import type { AccountType, PrismaClient } from "@prisma/client";

export const accounts: [string, string, AccountType][] = [
  ["101", "Tiền mặt", "ASSET"],
  ["102", "Ngân hàng VND", "ASSET"],
  ["103", "Airwallex HK", "ASSET"],
  ["104", "Airwallex VN", "ASSET"],
  ["105", "Wealify", "ASSET"],
  ["106", "Ví / tài khoản khác", "ASSET"],
  ["111", "Số dư trên sàn — khả dụng", "ASSET"],
  ["112", "Số dư trên sàn — bị giam", "ASSET"],
  ["131", "Phải thu", "ASSET"],
  ["141", "Tạm ứng nhân viên", "ASSET"],
  ["201", "Phải trả nhà cung cấp", "LIABILITY"],
  ["202", "Lương phải trả", "LIABILITY"],
  ["203", "BHXH phải nộp", "LIABILITY"],
  ["204", "Thuế phải nộp", "LIABILITY"],
  ["205", "Vay", "LIABILITY"],
  ["301", "Vốn chủ sở hữu", "EQUITY"],
  ["302", "Lợi nhuận giữ lại", "EQUITY"],
  ["303", "Rút vốn", "EQUITY"],
  ["401", "Doanh thu Etsy", "REVENUE"],
  ["402", "Doanh thu Amazon", "REVENUE"],
  ["403", "Doanh thu TikTok Shop", "REVENUE"],
  ["404", "Doanh thu website", "REVENUE"],
  ["405", "Doanh thu Walmart", "REVENUE"],
  ["409", "Thu nhập khác", "REVENUE"],
  ["501", "Chi phí fulfillment", "COGS"],
  ["502", "Vận chuyển", "COGS"],
  ["503", "Phí sàn", "COGS"],
  ["504", "Phí thanh toán & rút tiền", "COGS"],
  ["505", "Hoàn trả khách", "COGS"],
  ["601", "Lương", "EXPENSE"],
  ["602", "BHXH công ty", "EXPENSE"],
  ["603", "Thuê văn phòng", "EXPENSE"],
  ["604", "Điện nước", "EXPENSE"],
  ["605", "VPS & công cụ", "EXPENSE"],
  ["606", "Marketing & influencer", "EXPENSE"],
  ["607", "Thuê ngoài & tuyển dụng", "EXPENSE"],
  ["608", "Duy trì pháp nhân & thuế", "EXPENSE"],
  ["609", "Thiết bị & văn phòng phẩm", "EXPENSE"],
  ["610", "Đào tạo", "EXPENSE"],
  ["699", "Chi phí khác", "EXPENSE"],
  ["701", "Chênh lệch tỷ giá", "OTHER"],
  ["702", "Thu chi bất thường", "OTHER"],
];

export const cashAccounts = [
  { code: "TM", name: "Tiền mặt", kind: "CASH", currency: "VND", glAccount: "101" },
  { code: "BANKVN", name: "Bank Việt", kind: "BANK", currency: "VND", glAccount: "102" },
  { code: "AWHK", name: "Airwallex HK", kind: "EWALLET", currency: "USD", glAccount: "103" },
  { code: "AWVN", name: "Airwallex VN", kind: "EWALLET", currency: "USD", glAccount: "104" },
  { code: "WEALIFY", name: "Wealify", kind: "EWALLET", currency: "USD", glAccount: "105" },
  { code: "BANKRIENG", name: "Bank riêng khác", kind: "BANK", currency: "VND", glAccount: "106" },
  { code: "AMZ-AU1", name: "Amazon AU1", kind: "PLATFORM", currency: "USD", glAccount: "111" },
  { code: "AMZ-SHH", name: "Amazon SHH", kind: "PLATFORM", currency: "USD", glAccount: "111" },
  { code: "ETSY", name: "Etsy payment", kind: "PLATFORM", currency: "USD", glAccount: "111" },
] as const;

// prepaid + creditDays chạy thẳng vào dự báo dòng tiền — điền cho chuẩn (đặc tả mục 03).
export const suppliers = [
  ["MERCHIZE", "Merchize"],
  ["PRINTIFY", "Printify"],
  ["PRINTWAY", "Printway"],
  ["GEARMENT", "Gearment"],
  ["RAPID", "Rapidprintee"],
  ["GKE", "GKE"],
  ["HGT", "HGT"],
  ["PRINTPOSS", "Printposs"],
  ["FALCON", "Falcon"],
  ["DREAMSHIP", "Dreamship"],
  ["POPCUSTOM", "POPCUSTOM"],
  ["PGPRINT", "PGPRINT"],
  ["HUB", "Hub"],
  ["EG", "EG"],
  ["HANHPHUC", "Hạnh phúc"],
].map(([code, name]) => ({ code, name, service: "FULFILL", prepaid: true, creditDays: 0 }));

// Hạng mục chi phí ↔ tài khoản. dueDay/budgetVnd để trống — điền trong GĐ0.
export const expenseCategories = [
  { code: "FULFILL", name: "Fulfillment", accountCode: "501", recurring: false },
  { code: "SHIP", name: "Vận chuyển", accountCode: "502", recurring: false },
  { code: "PHI_SAN", name: "Phí sàn", accountCode: "503", recurring: false },
  { code: "PHI_TT", name: "Phí thanh toán & rút tiền", accountCode: "504", recurring: false },
  { code: "HOAN_TRA", name: "Hoàn trả khách", accountCode: "505", recurring: false },
  { code: "LUONG", name: "Lương", accountCode: "601", recurring: true },
  { code: "BHXH", name: "BHXH công ty", accountCode: "602", recurring: true },
  { code: "THUE_VP", name: "Thuê văn phòng", accountCode: "603", recurring: true },
  { code: "DIEN_NUOC", name: "Điện nước", accountCode: "604", recurring: true },
  { code: "VPS_TOOL", name: "VPS & công cụ", accountCode: "605", recurring: true },
  { code: "MARKETING", name: "Marketing & influencer", accountCode: "606", recurring: false },
  { code: "THUE_NGOAI", name: "Thuê ngoài & tuyển dụng", accountCode: "607", recurring: false },
  { code: "PHAP_NHAN", name: "Duy trì pháp nhân & thuế", accountCode: "608", recurring: false },
  { code: "THIET_BI", name: "Thiết bị & văn phòng phẩm", accountCode: "609", recurring: false },
  { code: "DAO_TAO", name: "Đào tạo", accountCode: "610", recurring: false },
  { code: "KHAC", name: "Chi phí khác", accountCode: "699", recurring: false },
];

export async function seedCatalog(db: PrismaClient) {
  for (const [code, name, type] of accounts) {
    await db.account.upsert({ where: { code }, create: { code, name, type }, update: { name, type } });
  }
  for (const a of cashAccounts) {
    await db.cashAccount.upsert({ where: { code: a.code }, create: a, update: { name: a.name, glAccount: a.glAccount } });
  }
  for (const s of suppliers) {
    // Không ghi đè prepaid/creditDays đã sửa tay qua màn hình Danh mục.
    await db.supplier.upsert({ where: { code: s.code }, create: s, update: { name: s.name } });
  }
  for (const c of expenseCategories) {
    await db.expenseCategory.upsert({ where: { code: c.code }, create: c, update: { name: c.name, accountCode: c.accountCode } });
  }
}
