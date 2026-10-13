export const STATUS_VI = {
  DRAFT: ["Nháp", "muted"],
  CALCULATED: ["Đã tính", "accent"],
  APPROVED: ["Đã duyệt", "accent"],
  PAID: ["Đã chi", "good"],
  CLOSED: ["Đã khoá", "good"],
} as const;

export const STEPS = ["DRAFT", "CALCULATED", "APPROVED", "PAID", "CLOSED"] as const;
