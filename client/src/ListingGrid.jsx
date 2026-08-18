import { useEffect, useState } from "react";
import { getFxRates } from "./api.js";
import { sortShops } from "./SortControl.jsx";
import { useI18n } from "./i18n.jsx";

// SortControl's dropdown is hardcoded to shop-level fields -- this wraps it
// with a single listing-level field (num_reviews, from the idle review
// scrape) instead, reusing the same field/direction UI and the same
// null-last sortShops() comparator (it's generic over any array + field
// name, not actually shop-specific).
function ListingSortControl({ field, setField, direction, setDirection, t }) {
  return (
    <div className="sort-control">
      <select value={field} onChange={(e) => setField(e.target.value)}>
        <option value="">{t("sort.none")}</option>
        <option value="num_reviews">{t("sort.reviews")}</option>
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

export function Stars({ rating }) {
  if (rating == null) return <span className="muted">—</span>;
  return (
    <span title={`${rating} / 5`}>
      {"★".repeat(Math.round(rating))}
      {"☆".repeat(5 - Math.round(rating))}
    </span>
  );
}

// Etsy shop pages don't expose per-listing sales counts, so review count
// (a rough proxy -- most buyers who bought do leave a review) is the best
// available signal for guessing which listing sells the most.
export function findBestseller(listings) {
  return listings.reduce((best, l) => {
    if (l.num_reviews == null) return best;
    if (!best || l.num_reviews > best.num_reviews) return l;
    return best;
  }, null);
}

// Shows the converted USD price as the headline figure with the original
// scraped price (whatever currency Etsy happened to render for the
// scraping browser -- see scraper.py) underneath for reference, since the
// conversion rate is approximate. Falls back to the raw scraped price
// string when there's no numeric value/currency/rate to convert with --
// e.g. listings saved before price_value existed, or a currency symbol
// scraper.py doesn't recognize yet.
function PriceDisplay({ listing, rates }) {
  const { price, price_value, currency } = listing;
  const rate = currency && rates ? rates[currency] : null;
  if (price_value != null && rate) {
    const usd = price_value / rate;
    return (
      <p className="card-price">
        ${usd.toFixed(2)}
        {price && <span className="card-price-original"> ({price})</span>}
      </p>
    );
  }
  if (price) return <p className="card-price">{price}</p>;
  return null;
}

function ListingCard({ listing, isBestseller, onZoom, rates, t }) {
  return (
    <div
      className="card"
      onClick={() => onZoom(listing)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onZoom(listing);
      }}
    >
      {isBestseller && <span className="badge">{t("shopDetail.bestsellerBadge")}</span>}
      {listing.image_url ? (
        <img src={listing.image_url} alt={listing.title || ""} loading="lazy" />
      ) : (
        <div className="card-img-placeholder">{t("shopDetail.noImage")}</div>
      )}
      <div className="card-body">
        <p className="card-title">{listing.title || t("shopDetail.untitledListing")}</p>
        <div className="card-meta">
          <Stars rating={listing.rating} />
          <span className="muted">
            {listing.num_reviews != null ? `(${listing.num_reviews} reviews)` : ""}
          </span>
        </div>
        <PriceDisplay listing={listing} rates={rates} />
        {listing.url && (
          <a
            className="card-original-link"
            href={listing.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {t("shopDetail.viewOriginal")}
          </a>
        )}
      </div>
    </div>
  );
}

function ListingModal({ listing, onClose, rates, t }) {
  useEffect(() => {
    if (!listing) return;
    const handleKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [listing, onClose]);

  if (!listing) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label={t("shopDetail.close")}>
          ✕
        </button>
        {listing.image_url ? (
          <img src={listing.image_url} alt={listing.title || ""} className="modal-image" />
        ) : (
          <div className="card-img-placeholder modal-image">{t("shopDetail.noImage")}</div>
        )}
        <div className="modal-info">
          <h3 className="modal-title">{listing.title || t("shopDetail.untitledListing")}</h3>
          <div className="card-meta">
            <Stars rating={listing.rating} />
            <span className="muted">
              {listing.num_reviews != null ? `(${listing.num_reviews} reviews)` : ""}
            </span>
          </div>
          <PriceDisplay listing={listing} rates={rates} />
          {listing.url && (
            <a className="card-original-link" href={listing.url} target="_blank" rel="noreferrer">
              {t("shopDetail.viewOriginalEtsy")}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// Only shown when there's a previous full scrape to compare against (the
// backend leaves the delta null on a shop's very first scrape, and resets
// it to null while the shop is unavailable) -- so a plain number with no
// "+N" badge just means "nothing to compare yet", not "no growth".
function DeltaBadge({ value }) {
  if (!value || value <= 0) return null;
  return <span className="delta-badge">+{value}</span>;
}

function formatSigned(n) {
  return n > 0 ? `+${n}` : `${n}`;
}

// Compares against the closest data point from ~7/~30 days ago (not an
// exact calendar boundary, since scrapes don't happen at a fixed cadence)
// -- see scrape_worker.py's save_scraped_data. Hidden entirely until a
// snapshot that old actually exists, rather than showing "+0" for a shop
// that's simply too new to compare yet.
function PeriodDelta({ label, salesDelta, reviewsDelta }) {
  if (salesDelta == null && reviewsDelta == null) return null;
  return (
    <p className="muted period-delta">
      {label}:{" "}
      {salesDelta != null && <span>Sales {formatSigned(salesDelta)}</span>}
      {salesDelta != null && reviewsDelta != null && " · "}
      {reviewsDelta != null && <span>Reviews {formatSigned(reviewsDelta)}</span>}
    </p>
  );
}

export default function ShopDetail({ shop }) {
  const { t } = useI18n();
  const bestseller = findBestseller(shop.listings);
  const [zoomedListing, setZoomedListing] = useState(null);
  const [rates, setRates] = useState(null);
  const [listingSortField, setListingSortField] = useState("");
  const [listingSortDirection, setListingSortDirection] = useState("desc");
  const sortedListings = sortShops(shop.listings, listingSortField, listingSortDirection);

  useEffect(() => {
    getFxRates()
      .then((r) => setRates(r.rates))
      .catch(() => setRates({}));
  }, []);

  return (
    <div className="shop-detail">
      <div className="shop-summary">
        <h2>{shop.shop_name || shop.shop_url}</h2>
        {shop.location && <p className="muted">📍 {shop.location}</p>}
        {shop.shop_tenure && (
          <p className="muted">{t("shopDetail.onEtsySince", { duration: shop.shop_tenure })}</p>
        )}
        <div className="shop-stats">
          <span>
            {t("shopDetail.listings")}: {shop.total_listings ?? "—"}
          </span>
          <span>
            {t("shopDetail.sales")}: {shop.total_sales ?? "—"} <DeltaBadge value={shop.sales_delta} />
          </span>
          <span>
            {t("shopDetail.reviews")}: {shop.total_reviews ?? "—"} <DeltaBadge value={shop.reviews_delta} />
          </span>
          <span>
            {t("shopDetail.rating")}: <Stars rating={shop.rating} />
          </span>
        </div>
        <PeriodDelta
          label={t("shopDetail.vsWeek")}
          salesDelta={shop.sales_delta_week}
          reviewsDelta={shop.reviews_delta_week}
        />
        <PeriodDelta
          label={t("shopDetail.vsMonth")}
          salesDelta={shop.sales_delta_month}
          reviewsDelta={shop.reviews_delta_month}
        />
        {bestseller && (
          <p className="bestseller-callout">
            {t("shopDetail.bestsellerPrediction", {
              title: bestseller.title || t("shopDetail.untitledListing"),
              count: bestseller.num_reviews,
            })}
          </p>
        )}
      </div>
      <ListingSortControl
        field={listingSortField}
        setField={setListingSortField}
        direction={listingSortDirection}
        setDirection={setListingSortDirection}
        t={t}
      />
      <div className="grid">
        {sortedListings.map((l) => (
          <ListingCard
            key={l.id}
            listing={l}
            isBestseller={bestseller?.id === l.id}
            onZoom={setZoomedListing}
            rates={rates}
            t={t}
          />
        ))}
      </div>
      {shop.listings.length === 0 && <p className="muted">{t("shopDetail.noListings")}</p>}
      <ListingModal listing={zoomedListing} onClose={() => setZoomedListing(null)} rates={rates} t={t} />
    </div>
  );
}
