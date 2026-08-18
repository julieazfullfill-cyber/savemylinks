import { useEffect, useMemo, useState } from "react";
import { addShop, deleteShop, getMyShop, listMyShops, retryShop } from "./api.js";
import ShopDetail from "./ListingGrid.jsx";
import OverviewPanel from "./OverviewPanel.jsx";
import ReportPanel from "./ReportPanel.jsx";
import SortControl, { sortShops } from "./SortControl.jsx";
import { useI18n } from "./i18n.jsx";

function StatusBadge({ status, t }) {
  if (status === "done") return <span className="status-badge status-done">{t("shops.statusDone")}</span>;
  if (status === "scraping")
    return <span className="status-badge status-pending">{t("shops.statusScraping")}</span>;
  if (status === "failed")
    return <span className="status-badge status-failed">{t("shops.statusFailed")}</span>;
  return <span className="status-badge status-pending">{t("shops.statusPending")}</span>;
}

const ACTIVE_STATUSES = new Set(["pending", "scraping"]);

export default function UserDashboard() {
  const { t, formatDate } = useI18n();
  const [tab, setTab] = useState("overview");
  const [shopUrl, setShopUrl] = useState("");
  const [niche, setNiche] = useState("");
  const [nicheFilter, setNicheFilter] = useState("");
  const [sortField, setSortField] = useState("");
  const [sortDirection, setSortDirection] = useState("desc");
  const [shops, setShops] = useState([]);
  const [activeShop, setActiveShop] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const availableNiches = useMemo(
    () => Array.from(new Set(shops.map((s) => s.niche).filter(Boolean))).sort(),
    [shops]
  );
  const visibleShops = sortShops(
    nicheFilter ? shops.filter((s) => s.niche === nicheFilter) : shops,
    sortField,
    sortDirection
  );

  const refresh = () => listMyShops().then(setShops).catch(() => {});

  useEffect(() => {
    refresh();
  }, []);

  // Poll faster while something is still being fetched so the "fetching
  // data..." status flips to done/failed without a manual refresh; back
  // off once nothing is in flight so we're not hammering the API.
  const hasActiveShop = shops.some((s) => ACTIVE_STATUSES.has(s.status));
  useEffect(() => {
    const interval = setInterval(refresh, hasActiveShop ? 3000 : 15000);
    return () => clearInterval(interval);
  }, [hasActiveShop]);

  useEffect(() => {
    if (activeShop && ACTIVE_STATUSES.has(activeShop.status)) {
      getMyShop(activeShop.id).then(setActiveShop).catch(() => {});
    }
  }, [shops]);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!shopUrl.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await addShop(shopUrl.trim(), niche.trim());
      setShopUrl("");
      setNiche("");
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const openShop = async (id) => {
    setError(null);
    try {
      const shop = await getMyShop(id);
      setActiveShop(shop);
    } catch (err) {
      setError(err.message);
    }
  };

  const removeShop = async (id) => {
    try {
      await deleteShop(id);
      if (activeShop?.id === id) setActiveShop(null);
      refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRetry = async (id) => {
    try {
      await retryShop(id);
      refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="dashboard">
      <div className="tab-toggle">
        <button
          type="button"
          className={tab === "overview" ? "active" : ""}
          onClick={() => setTab("overview")}
        >
          {t("tabs.overview")}
        </button>
        <button type="button" className={tab === "shops" ? "active" : ""} onClick={() => setTab("shops")}>
          {t("tabs.myShops")}
        </button>
        <button type="button" className={tab === "report" ? "active" : ""} onClick={() => setTab("report")}>
          {t("tabs.report")}
        </button>
      </div>

      {tab === "overview" && <OverviewPanel />}
      {tab === "report" && <ReportPanel />}
      {tab === "shops" && (
        <>
          <section className="panel">
            <h2>{t("shops.addTitle")}</h2>
            <form onSubmit={handleAdd} className="scrape-form">
              <input
                type="url"
                placeholder={t("shops.urlPlaceholder")}
                value={shopUrl}
                onChange={(e) => setShopUrl(e.target.value)}
                required
              />
              <input
                type="text"
                placeholder={t("shops.nichePlaceholder")}
                value={niche}
                onChange={(e) => setNiche(e.target.value)}
              />
              <button type="submit" disabled={loading}>
                {loading ? t("shops.adding") : t("shops.addButton")}
              </button>
            </form>
            {error && <p className="error">{error}</p>}
          </section>

          <div className="layout">
            <aside>
              <h2>
                {t("shops.yourShops")} ({visibleShops.length})
              </h2>
              {availableNiches.length > 0 && (
                <select
                  className="niche-filter"
                  value={nicheFilter}
                  onChange={(e) => setNicheFilter(e.target.value)}
                >
                  <option value="">{t("shops.allNiches")}</option>
                  {availableNiches.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              )}
              <SortControl
                field={sortField}
                setField={setSortField}
                direction={sortDirection}
                setDirection={setSortDirection}
                t={t}
              />
              <ul className="shop-list">
                {visibleShops.map((s) => (
                  <li key={s.id} className={activeShop?.id === s.id ? "active" : ""}>
                    <button className="link-button" onClick={() => openShop(s.id)}>
                      {s.shop_name || s.shop_url}
                    </button>
                    {s.niche && <span className="niche-tag">{s.niche}</span>}
                    <div className="shop-list-meta">
                      <StatusBadge status={s.status} t={t} />
                      {s.status === "done" && (
                        <span className="muted"> · {t("shops.updatedAt", { time: formatDate(s.scraped_at) })}</span>
                      )}
                      {s.status === "failed" && s.error_message && (
                        <span className="error"> · {s.error_message}</span>
                      )}
                    </div>
                    {s.status === "done" && !s.is_available && (
                      <div className="shop-list-meta">
                        <span className="error">⚠️ {s.unavailable_reason || t("shops.unavailableDefault")}</span>
                      </div>
                    )}
                    {s.status === "failed" && (
                      <button className="link-button" onClick={() => handleRetry(s.id)}>
                        {t("shops.retry")}
                      </button>
                    )}
                    <button className="remove-button" onClick={() => removeShop(s.id)}>
                      {t("shops.remove")}
                    </button>
                  </li>
                ))}
                {visibleShops.length === 0 && shops.length === 0 && (
                  <p className="muted">{t("shops.noShops")}</p>
                )}
                {visibleShops.length === 0 && shops.length > 0 && (
                  <p className="muted">{t("shops.noShopsInNiche", { niche: nicheFilter })}</p>
                )}
              </ul>
            </aside>

            <main>{activeShop && <ShopDetail shop={activeShop} />}</main>
          </div>
        </>
      )}
    </div>
  );
}
