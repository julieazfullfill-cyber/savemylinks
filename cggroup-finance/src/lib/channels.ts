// Kênh bán — 5 nhóm lớn của tiền thu về. Mỗi shop thuộc đúng một kênh; tiền thu từ shop
// ghi Có vào tài khoản doanh thu của kênh. Danh sách này khớp CHECK shop_channel ở DB.

export const CHANNELS = [
  { code: "AMAZON", label: "Amazon", revenueAccount: "402" },
  { code: "ETSY", label: "Etsy", revenueAccount: "401" },
  { code: "WALMART", label: "Walmart", revenueAccount: "405" },
  { code: "TIKTOK", label: "TikTok", revenueAccount: "403" },
  { code: "WEBSITE", label: "Website", revenueAccount: "404" },
] as const;

export type ChannelCode = (typeof CHANNELS)[number]["code"];

export const CHANNEL_CODES = CHANNELS.map((c) => c.code) as ChannelCode[];

export function channelLabel(code: string): string {
  return CHANNELS.find((c) => c.code === code)?.label ?? code;
}

export function revenueAccountFor(channel: string): string {
  const c = CHANNELS.find((x) => x.code === channel);
  if (!c) throw new Error(`Kênh bán không hợp lệ: ${channel}`);
  return c.revenueAccount;
}
