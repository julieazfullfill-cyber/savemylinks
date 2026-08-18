// Shared shop-list sorting: same field/direction picker and comparator
// logic for both UserDashboard ("Shop của bạn") and AdminDashboard
// ("Hàng đợi" / "Tất cả shop"), since both render lists of ShopOut objects
// with the same sortable fields.

export const SORT_FIELDS = [
  "total_listings",
  "total_sales",
  "total_reviews",
  "sales_delta",
  "reviews_delta",
  "sales_delta_week",
  "reviews_delta_week",
  "sales_delta_month",
  "reviews_delta_month",
];

export function sortShops(shops, field, direction) {
  if (!field) return shops;
  const sign = direction === "asc" ? 1 : -1;
  return [...shops].sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    // Shops without a value yet (not scraped, or no growth baseline) sort
    // last regardless of direction -- otherwise every "not yet known" shop
    // would jump to the top on ascending sort, which reads as "worst"/
    // "smallest" rather than "unknown".
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * sign;
  });
}

export default function SortControl({ field, setField, direction, setDirection, t }) {
  return (
    <div className="sort-control">
      <select value={field} onChange={(e) => setField(e.target.value)}>
        <option value="">{t("sort.none")}</option>
        <option value="total_listings">{t("sort.listings")}</option>
        <option value="total_sales">{t("sort.sales")}</option>
        <option value="total_reviews">{t("sort.reviews")}</option>
        <option value="sales_delta">{t("sort.salesDelta")}</option>
        <option value="reviews_delta">{t("sort.reviewsDelta")}</option>
        <option value="sales_delta_week">{t("sort.salesDeltaWeek")}</option>
        <option value="reviews_delta_week">{t("sort.reviewsDeltaWeek")}</option>
        <option value="sales_delta_month">{t("sort.salesDeltaMonth")}</option>
        <option value="reviews_delta_month">{t("sort.reviewsDeltaMonth")}</option>
      </select>
      {field && (
        <button
          type="button"
          className="sort-direction-button"
          onClick={() => setDirection(direction === "asc" ? "desc" : "asc")}
          title={direction === "asc" ? t("sort.ascending") : t("sort.descending")}
        >
          {direction === "asc" ? "↑" : "↓"}
        </button>
      )}
    </div>
  );
}
