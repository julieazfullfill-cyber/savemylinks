import { createContext, useContext, useEffect, useState } from "react";

const STORAGE_KEY = "etsy_scraper_lang";

// Dynamic content the *server* returns (error_message, unavailable_reason,
// niche the user typed, shop_name scraped from Etsy...) stays in whatever
// language the server produced it in (Vietnamese) -- only this static UI
// chrome is translated client-side.
const translations = {
  vi: {
    "app.title": "Etsy Shop Tracker",
    "app.logout": "Đăng xuất",

    "auth.title": "Etsy Shop Tracker",
    "auth.login": "Đăng nhập",
    "auth.register": "Đăng ký",
    "auth.email": "Email",
    "auth.password": "Mật khẩu",
    "auth.submitting": "Đang xử lý...",
    "auth.createAccount": "Tạo tài khoản",

    "tabs.overview": "Tổng quan",
    "tabs.myShops": "Shop của bạn",
    "tabs.report": "Báo cáo thay đổi",
    "tabs.queue": "Hàng đợi",
    "tabs.allShops": "Tất cả shop",
    "tabs.users": "Quản lý User",
    "tabs.settings": "Cài đặt",

    "overview.loading": "Đang tải tổng quan...",
    "overview.totalShops": "Tổng số shop",
    "overview.totalListings": "Tổng số listing",
    "overview.newToday": "Listing mới hôm nay",
    "overview.removedToday": "Listing đã gỡ hôm nay",
    "overview.byNiche": "Shop theo niche",
    "overview.noNiche": "(chưa gắn niche)",

    "shops.addTitle": "Thêm shop cần theo dõi",
    "shops.urlPlaceholder": "https://www.etsy.com/shop/ExampleShop",
    "shops.nichePlaceholder": "Niche (vd: Jewelry, Home Decor...)",
    "shops.addButton": "Thêm shop",
    "shops.adding": "Đang thêm...",
    "shops.yourShops": "Shop của bạn",
    "shops.allNiches": "Tất cả niche",
    "shops.noShops": "Chưa có shop nào. Thêm link ở trên.",
    "shops.noShopsInNiche": 'Không có shop nào thuộc niche "{niche}".',
    "shops.updatedAt": "Cập nhật lúc: {time}",
    "shops.retry": "Thử lại",
    "shops.remove": "Xoá",
    "shops.statusDone": "✅ Đã cập nhật",
    "shops.statusScraping": "🔄 Đang lấy thông tin...",
    "shops.statusFailed": "❌ Lỗi lấy dữ liệu",
    "shops.statusPending": "⏳ Đang chờ dữ liệu",
    "shops.unavailableDefault": "Shop hiện không khả dụng",
    "shops.chooseShopToView": "Chọn một shop bên trái để bắt đầu xử lý.",

    "report.loading": "Đang tải báo cáo...",
    "report.empty":
      'Chưa có thay đổi nào để báo cáo. Mỗi shop cần được lấy dữ liệu thêm ít nhất một lần nữa (so với lần đầu) thì mới có gì để so sánh -- dùng nút "Thử lại" ở tab Shop của bạn, hoặc chờ admin bật lịch tự động lấy lại.',
    "report.unavailableSection": "⚠️ Shop không còn lấy được dữ liệu ({count})",
    "report.unknownReason": "Không rõ lý do",
    "report.checkedAt": "Kiểm tra lúc: {time}",
    "report.updatedAt": "Cập nhật lúc: {time}",
    "report.newProducts": "🆕 Sản phẩm mới ({count})",
    "report.removedProducts": "🗑️ Sản phẩm đã gỡ ({count})",
    "report.untitledListing": "Untitled listing",

    "shopDetail.onEtsySince": "🕒 Trên Etsy: {duration}",
    "shopDetail.listings": "Listings",
    "shopDetail.sales": "Sales",
    "shopDetail.reviews": "Reviews",
    "shopDetail.rating": "Rating",
    "shopDetail.vsWeek": "So với tuần trước",
    "shopDetail.vsMonth": "So với tháng trước",
    "shopDetail.bestsellerPrediction":
      "🏆 Dự đoán bán chạy nhất: {title} ({count} review) — dựa trên listing có số review cao nhất trong shop (Etsy không công khai số lượng bán trực tiếp).",
    "shopDetail.noListings": "Chưa có dữ liệu listing cho shop này.",
    "shopDetail.viewOriginal": "Xem sản phẩm gốc ↗",
    "shopDetail.viewOriginalEtsy": "Xem sản phẩm gốc trên Etsy ↗",
    "shopDetail.close": "Đóng",
    "shopDetail.untitledListing": "Untitled listing",
    "shopDetail.noImage": "No image",
    "shopDetail.bestsellerBadge": "🏆 Bán chạy nhất",

    "admin.addedBy": "Người thêm: {email}",
    "admin.importedCount": "Đã nhập {done} / {total} listing",
    "admin.lastUpdated": " — cập nhật lần cuối: {time}",
    "admin.lastFailedError": "Lần tự động lấy gần nhất lỗi: {error}",
    "admin.scrapingNow": "🔄 Đang lấy thông tin...",
    "admin.waitingTurn": "⏳ Đang chờ tới lượt (xem tab Cài đặt để tăng số cửa sổ chạy song song).",
    "admin.autoScrapeTitle": "Cách 1: Chạy lại tự động (trình duyệt thật + stealth, thường vượt được DataDome)",
    "admin.autoScrapeButton": "Chạy tự động",
    "admin.autoScrapeLoading": "Đang đưa vào hàng đợi...",
    "admin.autoScrapeSuccess": "Đã đưa vào hàng đợi lấy dữ liệu tự động — trạng thái sẽ tự cập nhật bên dưới.",
    "admin.autoScrapeErrorSuffix": " — nếu vẫn lỗi, dùng cách dán HTML thủ công bên dưới.",
    "admin.manualImportTitle": "Cách 2: Dán HTML thủ công — trang {page}",
    "admin.manualImportHint":
      'Mở link shop (nếu cần xem trang tiếp theo thì thêm ?page=2, ?page=3... vào cuối URL) trên trình duyệt của bạn, bấm F12 → tab Console → gõ copy(document.documentElement.outerHTML) rồi nhấn Enter → dán (Ctrl+V) vào ô bên dưới. Mỗi lần lưu sẽ cộng dồn listing mới vào shop, không xoá dữ liệu trang trước.',
    "admin.manualImportHint2":
      "(Không dùng Ctrl+S lưu file HTML — Chrome sẽ đổi link ảnh Etsy thành đường dẫn máy tính của bạn khiến ảnh không hiển thị được.)",
    "admin.manualImportPlaceholder": "Dán HTML trang {page} vào đây...",
    "admin.savePage": "Lưu trang {page}",
    "admin.saving": "Đang lưu...",
    "admin.savedSuccess": 'Đã lưu trang {page}. Muốn thêm trang tiếp theo thì dán HTML trang kế và bấm "Lưu tiếp".',
    "admin.noQueueItems": "Không có yêu cầu nào đang chờ. 🎉",
    "admin.noShops": "Chưa có shop nào.",
    "admin.processing": "Xử lý: {name}",
    "admin.queueHeader": "Đang chờ xử lý",
    "admin.allShopsHeader": "Tất cả shop",
    "admin.lastLoginPrefix": "Đăng nhập gần nhất: {time}",
    "admin.shopCountSuffix": "{count} shop",

    "adminSettings.title": "Cài đặt lấy dữ liệu tự động",
    "adminSettings.loading": "Đang tải cài đặt...",
    "adminSettings.hint":
      "Mỗi lần lấy dữ liệu, server mở một cửa sổ Chrome thật trên máy chạy server. Số cửa sổ chạy đồng thời càng cao thì xử lý hàng đợi càng nhanh, nhưng tốn tài nguyên máy hơn (mỗi cửa sổ là 1 tiến trình Chrome thật — để số lớn khi máy server đủ CPU/RAM). Nếu để 1, hệ thống xử lý tuần tự — xong link này mới sang link kế tiếp.",
    "adminSettings.windowsLabel": "Số cửa sổ Chrome chạy đồng thời (1-100):",
    "adminSettings.windowLabel": "Cửa sổ #{n}:",
    "adminSettings.proxyPlaceholder": "Để trống = không dùng proxy (mặc định)",
    "adminSettings.proxyFormatHint": "Định dạng proxy: http://user:pass@host:port (hoặc host:port nếu không cần đăng nhập).",
    "adminSettings.save": "Lưu cài đặt",
    "adminSettings.saving": "Đang lưu...",
    "adminSettings.savedSuccess": "Đã lưu. Áp dụng ngay cho các lần lấy dữ liệu tiếp theo.",

    "adminSchedule.title": "Lịch tự động lấy lại dữ liệu",
    "adminSchedule.loading": "Đang tải lịch...",
    "adminSchedule.hint": "Tự động scrape lại các shop đã thêm từ trước (không phải shop mới) để cập nhật dữ liệu theo thời gian.",
    "adminSchedule.off": "Tắt",
    "adminSchedule.fixedTimeLabel": "Giờ cố định mỗi ngày:",
    "adminSchedule.autoLabel": "Tự động (rảnh thì làm)",
    "adminSchedule.explainFixed": "Giờ cố định: mỗi ngày đúng giờ này, scrape lại toàn bộ shop đã thêm một lượt.",
    "adminSchedule.explainAuto":
      "Tự động: bất cứ khi nào hệ thống đang rảnh (không có shop nào đang chờ/đang lấy dữ liệu -- tức không có link mới nào đang được xử lý), tự lấy lại 1 shop có thời gian cập nhật cũ nhất, rồi lặp lại ở lượt kiểm tra kế tiếp.",
    "adminSchedule.reviewTitle": "Lấy review từng sản phẩm",
    "adminSchedule.reviewHint":
      "Server tự mở Chrome, duyệt các trang Review của một shop để đếm số review theo từng sản phẩm. Có thể mất vài phút mỗi shop.",
    "adminSchedule.explainReviewFixed": "Giờ cố định: mỗi ngày đúng giờ này, lấy review cho 1 shop (cũ nhất/chưa lấy lần nào).",
    "adminSchedule.explainReviewAuto":
      "Tự động: bất cứ khi nào hệ thống đang rảnh, tự lấy review cho 1 shop (cũ nhất/chưa lấy lần nào), rồi lặp lại ở lượt kiểm tra kế tiếp.",
    "adminSchedule.save": "Lưu lịch",
    "adminSchedule.saving": "Đang lưu...",
    "adminSchedule.savedSuccess": "Đã lưu lịch tự động.",

    "sort.none": "Mặc định",
    "sort.listings": "Số listing",
    "sort.sales": "Số sale",
    "sort.reviews": "Số review",
    "sort.salesDelta": "Sale tăng (lần trước)",
    "sort.reviewsDelta": "Review tăng (lần trước)",
    "sort.salesDeltaWeek": "Sale tăng (7 ngày)",
    "sort.reviewsDeltaWeek": "Review tăng (7 ngày)",
    "sort.salesDeltaMonth": "Sale tăng (30 ngày)",
    "sort.reviewsDeltaMonth": "Review tăng (30 ngày)",
    "sort.ascending": "Tăng dần",
    "sort.descending": "Giảm dần",

    "adminUsers.title": "Quản lý User ({count})",
    "adminUsers.loading": "Đang tải danh sách user...",
    "adminUsers.empty": "Chưa có user thường nào đăng ký.",
    "adminUsers.email": "Email",
    "adminUsers.registeredAt": "Ngày đăng ký",
    "adminUsers.lastLogin": "Lần đăng nhập gần nhất",
    "adminUsers.shopCount": "Số shop",
    "adminUsers.neverLoggedIn": "Chưa từng đăng nhập lại",
  },

  en: {
    "app.title": "Etsy Shop Tracker",
    "app.logout": "Log out",

    "auth.title": "Etsy Shop Tracker",
    "auth.login": "Log in",
    "auth.register": "Sign up",
    "auth.email": "Email",
    "auth.password": "Password",
    "auth.submitting": "Working...",
    "auth.createAccount": "Create account",

    "tabs.overview": "Overview",
    "tabs.myShops": "Your shops",
    "tabs.report": "Change report",
    "tabs.queue": "Queue",
    "tabs.allShops": "All shops",
    "tabs.users": "Manage users",
    "tabs.settings": "Settings",

    "overview.loading": "Loading overview...",
    "overview.totalShops": "Total shops",
    "overview.totalListings": "Total listings",
    "overview.newToday": "New listings today",
    "overview.removedToday": "Removed listings today",
    "overview.byNiche": "Shops by niche",
    "overview.noNiche": "(no niche set)",

    "shops.addTitle": "Track a new shop",
    "shops.urlPlaceholder": "https://www.etsy.com/shop/ExampleShop",
    "shops.nichePlaceholder": "Niche (e.g. Jewelry, Home Decor...)",
    "shops.addButton": "Add shop",
    "shops.adding": "Adding...",
    "shops.yourShops": "Your shops",
    "shops.allNiches": "All niches",
    "shops.noShops": "No shops yet. Add a link above.",
    "shops.noShopsInNiche": 'No shops in the "{niche}" niche.',
    "shops.updatedAt": "Updated: {time}",
    "shops.retry": "Retry",
    "shops.remove": "Remove",
    "shops.statusDone": "✅ Updated",
    "shops.statusScraping": "🔄 Fetching data...",
    "shops.statusFailed": "❌ Fetch failed",
    "shops.statusPending": "⏳ Waiting for data",
    "shops.unavailableDefault": "Shop is currently unavailable",
    "shops.chooseShopToView": "Select a shop on the left to view it.",

    "report.loading": "Loading report...",
    "report.empty":
      'No changes to report yet. Each shop needs at least one more scrape (after its first) before there\'s anything to compare -- use the "Retry" button in the Your Shops tab, or wait for admin to enable the auto-refresh schedule.',
    "report.unavailableSection": "⚠️ Shops no longer fetchable ({count})",
    "report.unknownReason": "Unknown reason",
    "report.checkedAt": "Checked: {time}",
    "report.updatedAt": "Updated: {time}",
    "report.newProducts": "🆕 New products ({count})",
    "report.removedProducts": "🗑️ Removed products ({count})",
    "report.untitledListing": "Untitled listing",

    "shopDetail.onEtsySince": "🕒 On Etsy: {duration}",
    "shopDetail.listings": "Listings",
    "shopDetail.sales": "Sales",
    "shopDetail.reviews": "Reviews",
    "shopDetail.rating": "Rating",
    "shopDetail.vsWeek": "vs. last week",
    "shopDetail.vsMonth": "vs. last month",
    "shopDetail.bestsellerPrediction":
      "🏆 Predicted bestseller: {title} ({count} reviews) — based on the listing with the most reviews in the shop (Etsy doesn't publish sales counts directly).",
    "shopDetail.noListings": "No listing data for this shop yet.",
    "shopDetail.viewOriginal": "View original listing ↗",
    "shopDetail.viewOriginalEtsy": "View original listing on Etsy ↗",
    "shopDetail.close": "Close",
    "shopDetail.untitledListing": "Untitled listing",
    "shopDetail.noImage": "No image",
    "shopDetail.bestsellerBadge": "🏆 Bestseller",

    "admin.addedBy": "Added by: {email}",
    "admin.importedCount": "Imported {done} / {total} listings",
    "admin.lastUpdated": " — last updated: {time}",
    "admin.lastFailedError": "Last auto-fetch failed: {error}",
    "admin.scrapingNow": "🔄 Fetching data...",
    "admin.waitingTurn": "⏳ Waiting its turn (see the Settings tab to raise the number of parallel windows).",
    "admin.autoScrapeTitle": "Option 1: Re-run automatically (real stealth browser, usually gets past DataDome)",
    "admin.autoScrapeButton": "Run automatically",
    "admin.autoScrapeLoading": "Queuing...",
    "admin.autoScrapeSuccess": "Queued for automatic scraping — status will update below on its own.",
    "admin.autoScrapeErrorSuffix": " — if it keeps failing, use the manual HTML paste method below.",
    "admin.manualImportTitle": "Option 2: Paste HTML manually — page {page}",
    "admin.manualImportHint":
      "Open the shop link (add ?page=2, ?page=3... to the URL for later pages) in your own browser, press F12 → Console tab → type copy(document.documentElement.outerHTML) and press Enter → paste (Ctrl+V) into the box below. Each save adds new listings on top of the shop's existing ones without deleting earlier pages' data.",
    "admin.manualImportHint2":
      "(Don't use Ctrl+S to save an HTML file — Chrome rewrites Etsy's image links to local file paths, so images won't display.)",
    "admin.manualImportPlaceholder": "Paste page {page}'s HTML here...",
    "admin.savePage": "Save page {page}",
    "admin.saving": "Saving...",
    "admin.savedSuccess": 'Saved page {page}. To add another page, paste its HTML and click "Save" again.',
    "admin.noQueueItems": "Nothing waiting in the queue. 🎉",
    "admin.noShops": "No shops yet.",
    "admin.processing": "Working on: {name}",
    "admin.queueHeader": "Waiting",
    "admin.allShopsHeader": "All shops",
    "admin.lastLoginPrefix": "Last login: {time}",
    "admin.shopCountSuffix": "{count} shops",

    "adminSettings.title": "Automatic scraping settings",
    "adminSettings.loading": "Loading settings...",
    "adminSettings.hint":
      "Each fetch opens a real Chrome window on the server machine. More concurrent windows means the queue clears faster, but uses more server resources (each window is a real Chrome process -- raise this only if the server has the CPU/RAM to spare). Set it to 1 for strictly sequential processing -- one link finishes before the next starts.",
    "adminSettings.windowsLabel": "Concurrent Chrome windows (1-100):",
    "adminSettings.windowLabel": "Window #{n}:",
    "adminSettings.proxyPlaceholder": "Leave blank = no proxy (default)",
    "adminSettings.proxyFormatHint": "Proxy format: http://user:pass@host:port (or host:port if no login is needed).",
    "adminSettings.save": "Save settings",
    "adminSettings.saving": "Saving...",
    "adminSettings.savedSuccess": "Saved. Applies to the next fetches immediately.",

    "adminSchedule.title": "Auto-refresh schedule",
    "adminSchedule.loading": "Loading schedule...",
    "adminSchedule.hint": "Automatically re-scrapes previously-added shops (not new ones) to keep their data current over time.",
    "adminSchedule.off": "Off",
    "adminSchedule.fixedTimeLabel": "Fixed time every day:",
    "adminSchedule.autoLabel": "Automatic (whenever idle)",
    "adminSchedule.explainFixed": "Fixed time: every day at this time, re-scrapes every added shop once.",
    "adminSchedule.explainAuto":
      "Automatic: whenever the system is idle (no shop currently waiting/being fetched -- i.e. no freshly-added link in flight), re-fetches the 1 shop with the oldest data, then repeats on the next check.",
    "adminSchedule.reviewTitle": "Per-product review scraping",
    "adminSchedule.reviewHint":
      "The server opens Chrome and walks a shop's Review-tab pages to count reviews per product. Can take a few minutes per shop.",
    "adminSchedule.explainReviewFixed": "Fixed time: every day at this time, scrapes reviews for 1 shop (oldest/never review-scraped).",
    "adminSchedule.explainReviewAuto":
      "Automatic: whenever the system is idle, scrapes reviews for 1 shop (oldest/never review-scraped), then repeats on the next check.",
    "adminSchedule.save": "Save schedule",
    "adminSchedule.saving": "Saving...",
    "adminSchedule.savedSuccess": "Auto-refresh schedule saved.",

    "sort.none": "Default",
    "sort.listings": "Listings",
    "sort.sales": "Sales",
    "sort.reviews": "Reviews",
    "sort.salesDelta": "Sales growth (last update)",
    "sort.reviewsDelta": "Reviews growth (last update)",
    "sort.salesDeltaWeek": "Sales growth (7 days)",
    "sort.reviewsDeltaWeek": "Reviews growth (7 days)",
    "sort.salesDeltaMonth": "Sales growth (30 days)",
    "sort.reviewsDeltaMonth": "Reviews growth (30 days)",
    "sort.ascending": "Ascending",
    "sort.descending": "Descending",

    "adminUsers.title": "Manage Users ({count})",
    "adminUsers.loading": "Loading user list...",
    "adminUsers.empty": "No regular users have registered yet.",
    "adminUsers.email": "Email",
    "adminUsers.registeredAt": "Registered",
    "adminUsers.lastLogin": "Last login",
    "adminUsers.shopCount": "Shops",
    "adminUsers.neverLoggedIn": "Never logged in again",
  },
};

function getByPath(obj, key) {
  // Dictionary keys are flat strings that happen to contain dots (e.g.
  // "auth.title" is one key, not a nested auth: { title } path) -- a plain
  // lookup, not a split-and-descend, is what actually matches how the
  // `translations` object above is built.
  return obj[key];
}

const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || "vi";
    } catch {
      return "vi";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // localStorage unavailable (private mode etc.) -- language choice
      // just won't persist across reloads, not worth failing over.
    }
  }, [lang]);

  const t = (key, vars) => {
    let str = getByPath(translations[lang], key) ?? getByPath(translations.vi, key) ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replaceAll(`{${k}}`, v);
      }
    }
    return str;
  };

  const formatDate = (iso) => {
    if (!iso) return null;
    const locale = lang === "vi" ? "vi-VN" : "en-US";
    return new Date(iso + (iso.endsWith("Z") ? "" : "Z")).toLocaleString(locale);
  };

  return (
    <LanguageContext.Provider value={{ lang, setLang: setLangState, t, formatDate }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useI18n() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useI18n must be used within a LanguageProvider");
  return ctx;
}
