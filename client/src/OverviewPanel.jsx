import { useEffect, useState } from "react";
import { getShopsOverview } from "./api.js";
import { useI18n } from "./i18n.jsx";

function StatCard({ label, value }) {
  return (
    <div className="stat-card">
      <div className="stat-card-value">{value}</div>
      <div className="stat-card-label">{label}</div>
    </div>
  );
}

export default function OverviewPanel() {
  const { t } = useI18n();
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getShopsOverview()
      .then(setOverview)
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (overview === null) return <p className="muted">{t("overview.loading")}</p>;

  return (
    <div className="overview-panel">
      <div className="stat-card-grid">
        <StatCard label={t("overview.totalShops")} value={overview.total_shops} />
        <StatCard label={t("overview.totalListings")} value={overview.total_listings} />
        <StatCard label={t("overview.newToday")} value={`+${overview.new_listings_today}`} />
        <StatCard label={t("overview.removedToday")} value={`-${overview.removed_listings_today}`} />
      </div>

      {overview.shops_by_niche.length > 0 && (
        <div className="panel">
          <h2>{t("overview.byNiche")}</h2>
          <ul className="niche-breakdown">
            {overview.shops_by_niche.map((n) => (
              <li key={n.niche ?? "__none__"}>
                <span>{n.niche || t("overview.noNiche")}</span>
                <span className="niche-breakdown-count">{n.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
