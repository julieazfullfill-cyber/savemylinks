// Đọc giá trị ô của file .xlsx (đã tính sẵn, không chạy công thức) — đủ cho file báo cáo tháng.
// Không thêm thư viện: .xlsx là zip + XML; zip đọc qua central directory, giải nén bằng zlib.
import { inflateRawSync } from "node:zlib";

export type Sheet = { name: string; rows: Map<number, string[]> };

function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("Không phải file .xlsx (zip) hợp lệ");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Zip hỏng");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    out.set(name, method === 0 ? raw : inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const dec = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const colIndex = (ref: string) => [...ref.replace(/\d+/g, "")].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;

/** Mọi sheet: số dòng Excel → mảng giá trị ô (chuỗi; số giữ nguyên dạng trong file). */
export function readXlsx(buf: Buffer): Sheet[] {
  const files = unzip(buf);
  const text = (n: string) => files.get(n)?.toString("utf8") ?? "";
  const shared = [...text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    dec([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")),
  );
  const rels = new Map([...text("xl/_rels/workbook.xml.rels").matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  return [...text("xl/workbook.xml").matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map((m) => {
    const file = `xl/${(rels.get(m[2]) ?? "").replace(/^\/?xl\//, "")}`;
    const rows = new Map<number, string[]>();
    for (const r of text(file).matchAll(/<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of r[2].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const t = /t="(\w+)"/.exec(c[2])?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(c[3] ?? "")?.[1];
        const inl = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(c[3] ?? "")?.[1];
        const val = v === undefined ? (inl ? dec(inl) : "") : t === "s" ? shared[Number(v)] ?? "" : t === "str" || t === "inlineStr" ? dec(v) : v;
        cells[colIndex(c[1])] = val.replace(/\s+/g, " ").trim();
      }
      rows.set(Number(r[1]), Array.from(cells, (x) => x ?? ""));
    }
    return { name: dec(m[1]), rows };
  });
}

/** Ngày Excel (số sê-ri) → Date UTC 00:00. */
export function excelDate(serial: number): Date {
  const d = new Date(Math.round((serial - 25569) * 86400000));
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
