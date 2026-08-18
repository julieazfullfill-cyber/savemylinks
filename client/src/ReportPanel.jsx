import { useEffect, useState } from "react";
import { getShopsReport } from "./api.js";
import { useI18n } from "./i18n.jsx";

function ListingMini({ listing, t }) {
  return (
    <a className="report-listing" href={listing.url || "#"} target="_blank" rel="noreferrer">
      {listing.image_url ? (
        <img src={listing.image_url} alt={listing.title || ""} loading="lazy" />
      ) : (
        <div className="card-img-placeholder report-listing-img">{t("shopDetail.noImage")}</div>
      )}
      <span className="report-listing-title">{listing.title || t("report.untitledListing")}</span>
    </a>
  );
}

export default function ReportPanel({ fetcher = getShopsReport, showOwner = false }) {
  const { t, formatDate } = useI18n();
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetcher()
      .then(setReport)
      .catch((err) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (report === null) return <p className="muted">{t("report.loading")}</p>;

  if (report.length === 0) {
    return <p className="muted">{t("report.empty")}</p>;
  }

  const unavailable = report.filter((r) => !r.is_available);
  const changed = report.filter(
    (r) => r.is_available && (r.added_listings.length > 0 || r.removed_listings.length > 0)
  );

  return (
    <div className="report-panel">
      {unavailable.length > 0 && (
        <section className="panel">
          <h2>{t("report.unavailableSection", { count: unavailable.length })}</h2>
          <ul className="shop-list">
            {unavailable.map((r) => (
              <li key={r.id}>
                <strong>{r.shop_name || r.shop_url}</strong>
                {showOwner && <div className="muted">{t("admin.addedBy", { email: r.owner_email })}</div>}
                <div className="shop-list-meta">
                  <span className="error">{r.unavailable_reason || t("report.unknownReason")}</span>
                  {r.scraped_at && (
                    <span className="muted"> · {t("report.checkedAt", { time: formatDate(r.scraped_at) })}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {changed.map((r) => (
        <section key={r.id} className="panel">
          <h2>{r.shop_name || r.shop_url}</h2>
          {showOwner && <p className="muted">{t("admin.addedBy", { email: r.owner_email })}</p>}
          <p className="muted">{t("report.updatedAt", { time: formatDate(r.scraped_at) })}</p>

          {r.added_listings.length > 0 && (
            <>
              <h3>{t("report.newProducts", { count: r.added_listings.length })}</h3>
              <div className="grid report-grid">
                {r.added_listings.map((l) => (
                  <ListingMini key={l.etsy_listing_id} listing={l} t={t} />
                ))}
              </div>
            </>
          )}

          {r.removed_listings.length > 0 && (
            <>
              <h3>{t("report.removedProducts", { count: r.removed_listings.length })}</h3>
              <div className="grid report-grid">
                {r.removed_listings.map((l) => (
                  <ListingMini key={l.etsy_listing_id} listing={l} t={t} />
                ))}
              </div>
            </>
          )}
        </section>
      ))}
    </div>
  );
}
