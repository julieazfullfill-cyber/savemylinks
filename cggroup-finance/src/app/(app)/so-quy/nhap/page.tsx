import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { SHEETS } from "@/lib/import-1a";
import { PageHead } from "../../ui";
import { ImportForm } from "./import-form";

export default async function ImportPage() {
  await requireUser(["ADMIN", "KE_TOAN"]);
  return (
    <div className="max-w-6xl">
      <Link href="/so-quy" className="text-sm text-accent hover:underline">← Sổ quỹ</Link>
      <div className="mt-1"><PageHead no={2} title="Nhập từ sheet giai đoạn 1a" /></div>
      <div className="mt-3 max-w-4xl space-y-1 text-sm text-ink-2">
        <p>Tên cột trùng tên trường trong hệ thống. Mã (accountCode, categoryCode, supplierCode, shopCode) phải có trong danh mục.</p>
        <p>
          Số tiền nhập theo đơn vị thường dùng: đồng cho VND, đô cho USD (1250,50). <code>direction</code> là IN hoặc OUT. Thu có <code>shopCode</code>
          mà không có hạng mục được ghi là doanh thu của kênh shop. Tỷ giá trống thì lấy tỷ giá gần nhất trong bảng.
        </p>
        <p>Nạp lại cùng dữ liệu không bị trùng — dòng giống hệt bản ghi đã có được bỏ qua. Bấm “Xem trước” trước để kiểm lỗi.</p>
        <p>
          <strong>Chi_Phi</strong> chỉ nhận status DRAFT / APPROVED; khoản đã trả thì nhập ở GD_Tien với hạng mục, để không ghi chi phí hai lần.
        </p>
      </div>
      <div className="mt-4">
        <ImportForm sheets={Object.entries(SHEETS).map(([name, columns]) => ({ name, columns }))} />
      </div>
    </div>
  );
}
