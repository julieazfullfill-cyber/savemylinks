import { useEffect, useState } from "react";
import {
  adminAllShops,
  adminAutoScrape,
  adminGetReport,
  adminGetSchedule,
  adminGetSettings,
  adminGetShop,
  adminGetUsers,
  adminImportHtml,
  adminQueue,
  adminUpdateSchedule,
  adminUpdateSettings,
} from "./api.js";
import ShopDetail from "./ListingGrid.jsx";
import ReportPanel from "./ReportPanel.jsx";
import SortControl, { sortShops } from "./SortControl.jsx";
import { useI18n } from "./i18n.jsx";

const ACTIVE_STATUSES = new Set(["pending", "scraping"]);

function SettingsPanel() {
  const { t } = useI18n();
  const [maxConcurrent, setMaxConcurrent] = useState(1);
  const [proxies, setProxies] = useState([""]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    adminGetSettings()
      .then((s) => {
        setMaxConcurrent(s.max_concurrent);
        setProxies(
          Array.from({ length: s.max_concurrent }, (_, i) => s.proxies[i] || "")
        );
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleCountChange = (n) => {
    n = Math.min(100, Math.max(1, n));
    setMaxConcurrent(n);
    setProxies((prev) => {
      const next = prev.slice(0, n);
      while (next.length < n) next.push("");
      return next;
    });
  };

  const handleProxyChange = (i, value) => {
    setProxies((prev) => prev.map((p, idx) => (idx === i ? value : p)));
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await adminUpdateSettings(
        maxConcurrent,
        proxies.map((p) => p.trim() || null)
      );
      setSuccess(t("adminSettings.savedSuccess"));
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="muted">{t("adminSettings.loading")}</p>;

  return (
    <div className="panel">
      <h2>{t("adminSettings.title")}</h2>
      <p className="hint">{t("adminSettings.hint")}</p>
      <form onSubmit={handleSave} className="scrape-form" style={{ flexDirection: "column", alignItems: "flex-start", gap: "12px" }}>
        <label>
          {t("adminSettings.windowsLabel")}{" "}
          <input
            type="number"
            min="1"
            max="100"
            value={maxConcurrent}
            onChange={(e) => handleCountChange(Number(e.target.value) || 1)}
            className="max-pages"
          />
        </label>

        <div style={{ width: "100%" }}>
          {proxies.map((proxy, i) => (
            <div key={i} className="scrape-form" style={{ marginBottom: "6px" }}>
              <span className="muted" style={{ minWidth: "90px" }}>
                {t("adminSettings.windowLabel", { n: i + 1 })}
              </span>
              <input
                type="text"
                placeholder={t("adminSettings.proxyPlaceholder")}
                value={proxy}
                onChange={(e) => handleProxyChange(i, e.target.value)}
                style={{ flex: 1 }}
              />
            </div>
          ))}
        </div>
        <p className="hint">{t("adminSettings.proxyFormatHint")}</p>

        <button type="submit" disabled={saving}>
          {saving ? t("adminSettings.saving") : t("adminSettings.save")}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {success && <p className="success">{success}</p>}
    </div>
  );
}

function SchedulePanel() {
  const { t } = useI18n();
  const [mode, setMode] = useState("off");
  const [fixedTime, setFixedTime] = useState("03:00");
  const [reviewMode, setReviewMode] = useState("off");
  const [reviewFixedTime, setReviewFixedTime] = useState("03:00");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    adminGetSchedule()
      .then((s) => {
        setMode(s.mode);
        if (s.fixed_time) setFixedTime(s.fixed_time);
        setReviewMode(s.review_mode);
        if (s.review_fixed_time) setReviewFixedTime(s.review_fixed_time);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await adminUpdateSchedule(
        mode,
        mode === "fixed_time" ? fixedTime : null,
        reviewMode,
        reviewMode === "fixed_time" ? reviewFixedTime : null
      );
      setSuccess(t("adminSchedule.savedSuccess"));
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="muted">{t("adminSchedule.loading")}</p>;

  return (
    <div className="panel">
      <h2>{t("adminSchedule.title")}</h2>
      <p className="hint">{t("adminSchedule.hint")}</p>
      <form onSubmit={handleSave} className="scrape-form" style={{ flexDirection: "column", alignItems: "flex-start", gap: "12px" }}>
        <label>
          <input
            type="radio"
            name="schedule-mode"
            checked={mode === "off"}
            onChange={() => setMode("off")}
          />{" "}
          {t("adminSchedule.off")}
        </label>
        <label>
          <input
            type="radio"
            name="schedule-mode"
            checked={mode === "fixed_time"}
            onChange={() => setMode("fixed_time")}
          />{" "}
          {t("adminSchedule.fixedTimeLabel")}{" "}
          <input
            type="time"
            value={fixedTime}
            onChange={(e) => setFixedTime(e.target.value)}
            disabled={mode !== "fixed_time"}
          />
        </label>
        <label>
          <input
            type="radio"
            name="schedule-mode"
            checked={mode === "auto"}
            onChange={() => setMode("auto")}
          />{" "}
          {t("adminSchedule.autoLabel")}
        </label>
        <p className="hint">
          {t("adminSchedule.explainFixed")}
          <br />
          {t("adminSchedule.explainAuto")}
        </p>
        <h3>{t("adminSchedule.reviewTitle")}</h3>
        <p className="hint">{t("adminSchedule.reviewHint")}</p>
        <label>
          <input
            type="radio"
            name="review-schedule-mode"
            checked={reviewMode === "off"}
            onChange={() => setReviewMode("off")}
          />{" "}
          {t("adminSchedule.off")}
        </label>
        <label>
          <input
            type="radio"
            name="review-schedule-mode"
            checked={reviewMode === "fixed_time"}
            onChange={() => setReviewMode("fixed_time")}
          />{" "}
          {t("adminSchedule.fixedTimeLabel")}{" "}
          <input
            type="time"
            value={reviewFixedTime}
            onChange={(e) => setReviewFixedTime(e.target.value)}
            disabled={reviewMode !== "fixed_time"}
          />
        </label>
        <label>
          <input
            type="radio"
            name="review-schedule-mode"
            checked={reviewMode === "auto"}
            onChange={() => setReviewMode("auto")}
          />{" "}
          {t("adminSchedule.autoLabel")}
        </label>
        <p className="hint">
          {t("adminSchedule.explainReviewFixed")}
          <br />
          {t("adminSchedule.explainReviewAuto")}
        </p>
        <button type="submit" disabled={saving}>
          {saving ? t("adminSchedule.saving") : t("adminSchedule.save")}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {success && <p className="success">{success}</p>}
    </div>
  );
}

function UsersPanel() {
  const { t, formatDate } = useI18n();
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    adminGetUsers()
      .then(setUsers)
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (users === null) return <p className="muted">{t("adminUsers.loading")}</p>;

  return (
    <div className="panel">
      <h2>{t("adminUsers.title", { count: users.length })}</h2>
      {users.length === 0 ? (
        <p className="muted">{t("adminUsers.empty")}</p>
      ) : (
        <div className="table-scroll">
          <table className="users-table">
            <thead>
              <tr>
                <th>{t("adminUsers.email")}</th>
                <th>{t("adminUsers.registeredAt")}</th>
                <th>{t("adminUsers.lastLogin")}</th>
                <th>{t("adminUsers.shopCount")}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{formatDate(u.created_at)}</td>
                  <td>{u.last_login ? formatDate(u.last_login) : t("adminUsers.neverLoggedIn")}</td>
                  <td>{u.shop_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function AdminDashboard() {
  const { t, formatDate } = useI18n();
  const [tab, setTab] = useState("pending");
  const [items, setItems] = useState([]);
  const [sortField, setSortField] = useState("");
  const [sortDirection, setSortDirection] = useState("desc");
  const [usersOverview, setUsersOverview] = useState([]);
  const [selected, setSelected] = useState(null); // full ShopDetailOut
  const [pageNum, setPageNum] = useState(1);
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(false);
  const [autoLoading, setAutoLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const refreshList = () => {
    if (tab === "settings" || tab === "users" || tab === "report") return;
    const fetcher = tab === "pending" ? adminQueue : adminAllShops;
    fetcher().then(setItems).catch(() => {});
    if (tab === "all") {
      adminGetUsers().then(setUsersOverview).catch(() => {});
    }
  };

  const sortedItems = sortShops(items, sortField, sortDirection);

  // Groups the flat "all shops" list by owner so admin sees, per user: how
  // many shops they're tracking and when they last logged in -- rather than
  // one long undifferentiated list. Order follows `sortedItems`'s order
  // (newest-shop-first by default, or whatever SortControl picked).
  const groupedByUser = () => {
    const groups = new Map();
    for (const s of sortedItems) {
      if (!groups.has(s.owner_email)) groups.set(s.owner_email, []);
      groups.get(s.owner_email).push(s);
    }
    return Array.from(groups.entries()).map(([email, shops]) => {
      const info = usersOverview.find((u) => u.email === email);
      return {
        email,
        shops,
        shopCount: info?.shop_count ?? shops.length,
        lastLogin: info?.last_login ?? null,
      };
    });
  };

  useEffect(() => {
    refreshList();
    const interval = setInterval(refreshList, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Keep the open detail panel's status fresh while a scrape is in flight,
  // same idea as UserDashboard -- avoids the admin having to re-click the
  // shop to see it flip from "pending"/"scraping" to "done"/"failed".
  useEffect(() => {
    if (selected && ACTIVE_STATUSES.has(selected.status)) {
      const interval = setInterval(async () => {
        try {
          const shop = await adminGetShop(selected.id);
          setSelected(shop);
        } catch {
          // ignore transient poll errors
        }
      }, 3000);
      return () => clearInterval(interval);
    }
  }, [selected]);

  const openShop = async (id) => {
    setError(null);
    setSuccess(null);
    setHtml("");
    setPageNum(1);
    try {
      const shop = await adminGetShop(id);
      setSelected(shop);
    } catch (err) {
      setError(err.message);
    }
  };

  const refreshSelected = async () => {
    if (!selected) return;
    const shop = await adminGetShop(selected.id);
    setSelected(shop);
  };

  const handleImportPage = async (e) => {
    e.preventDefault();
    if (!selected || !html.trim()) return;
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await adminImportHtml(selected.id, html);
      setSuccess(t("admin.savedSuccess", { page: pageNum }));
      setHtml("");
      setPageNum((n) => n + 1);
      await refreshSelected();
      refreshList();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const renderShopItem = (s) => (
    <li key={s.id} className={selected?.id === s.id ? "active" : ""}>
      <button className="link-button" onClick={() => openShop(s.id)}>
        {s.shop_name || s.shop_url}
      </button>
      <div className="shop-list-meta">
        <span className="muted">{t("admin.addedBy", { email: s.owner_email })}</span>
      </div>
      {s.niche && <span className="niche-tag">{s.niche}</span>}
      <div className="shop-list-meta">
        <span
          className={
            s.status === "done"
              ? "status-badge status-done"
              : s.status === "failed"
              ? "status-badge status-failed"
              : "status-badge status-pending"
          }
        >
          {s.status === "done" && t("shops.statusDone")}
          {s.status === "scraping" && t("shops.statusScraping")}
          {s.status === "failed" && t("shops.statusFailed")}
          {s.status === "pending" && t("shops.statusPending")}
        </span>
      </div>
    </li>
  );

  const handleAutoScrape = async () => {
    if (!selected) return;
    setAutoLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const shop = await adminAutoScrape(selected.id);
      setSelected(shop);
      setSuccess(t("admin.autoScrapeSuccess"));
      refreshList();
    } catch (err) {
      setError(err.message + t("admin.autoScrapeErrorSuffix"));
    } finally {
      setAutoLoading(false);
    }
  };

  return (
    <div className="dashboard">
      <div className="tab-toggle">
        <button
          type="button"
          className={tab === "pending" ? "active" : ""}
          onClick={() => setTab("pending")}
        >
          {t("tabs.queue")}
        </button>
        <button type="button" className={tab === "all" ? "active" : ""} onClick={() => setTab("all")}>
          {t("tabs.allShops")}
        </button>
        <button type="button" className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>
          {t("tabs.users")}
        </button>
        <button type="button" className={tab === "report" ? "active" : ""} onClick={() => setTab("report")}>
          {t("tabs.report")}
        </button>
        <button
          type="button"
          className={tab === "settings" ? "active" : ""}
          onClick={() => setTab("settings")}
        >
          {t("tabs.settings")}
        </button>
      </div>

      {tab === "settings" ? (
        <>
          <SettingsPanel />
          <SchedulePanel />
        </>
      ) : tab === "users" ? (
        <UsersPanel />
      ) : tab === "report" ? (
        <ReportPanel fetcher={adminGetReport} showOwner />
      ) : (
        <div className="layout">
          <aside>
            <h2>
              {tab === "pending" ? t("admin.queueHeader") : t("admin.allShopsHeader")} ({items.length})
            </h2>
            <SortControl
              field={sortField}
              setField={setSortField}
              direction={sortDirection}
              setDirection={setSortDirection}
              t={t}
            />
            {tab === "all" ? (
              <>
                {groupedByUser().map((group) => (
                  <div key={group.email} className="user-group">
                    <div className="user-group-header">
                      <strong>{group.email}</strong>
                      <div className="muted">
                        {t("admin.shopCountSuffix", { count: group.shopCount })} ·{" "}
                        {t("admin.lastLoginPrefix", {
                          time: group.lastLogin ? formatDate(group.lastLogin) : t("adminUsers.neverLoggedIn"),
                        })}
                      </div>
                    </div>
                    <ul className="shop-list">{group.shops.map(renderShopItem)}</ul>
                  </div>
                ))}
                {items.length === 0 && <p className="muted">{t("admin.noShops")}</p>}
              </>
            ) : (
              <ul className="shop-list">
                {sortedItems.map(renderShopItem)}
                {items.length === 0 && <p className="muted">{t("admin.noQueueItems")}</p>}
              </ul>
            )}
          </aside>

          <main>
            {selected ? (
              <>
                <h2>{t("admin.processing", { name: selected.shop_name || selected.shop_url })}</h2>
                <p className="muted">
                  {t("admin.importedCount", { done: selected.listings.length, total: selected.total_listings ?? "?" })}
                  {selected.scraped_at && t("admin.lastUpdated", { time: formatDate(selected.scraped_at) })}
                </p>
                {selected.status === "failed" && selected.error_message && (
                  <p className="error">{t("admin.lastFailedError", { error: selected.error_message })}</p>
                )}
                {ACTIVE_STATUSES.has(selected.status) && (
                  <p className="muted">
                    {selected.status === "scraping" ? t("admin.scrapingNow") : t("admin.waitingTurn")}
                  </p>
                )}

                <div className="panel">
                  <h3>{t("admin.autoScrapeTitle")}</h3>
                  <div className="scrape-form">
                    <button type="button" onClick={handleAutoScrape} disabled={autoLoading}>
                      {autoLoading ? t("admin.autoScrapeLoading") : t("admin.autoScrapeButton")}
                    </button>
                  </div>
                </div>

                <div className="panel">
                  <h3>{t("admin.manualImportTitle", { page: pageNum })}</h3>
                  <p className="hint">
                    {t("admin.manualImportHint")}
                    <br />
                    {t("admin.manualImportHint2")}
                  </p>
                  <form onSubmit={handleImportPage} className="scrape-form">
                    <textarea
                      placeholder={t("admin.manualImportPlaceholder", { page: pageNum })}
                      value={html}
                      onChange={(e) => setHtml(e.target.value)}
                      className="html-input"
                      rows={10}
                      required
                    />
                    <button type="submit" disabled={loading}>
                      {loading ? t("admin.saving") : t("admin.savePage", { page: pageNum })}
                    </button>
                  </form>
                </div>

                {error && <p className="error">{error}</p>}
                {success && <p className="success">{success}</p>}

                {selected.listings.length > 0 && <ShopDetail shop={selected} />}
              </>
            ) : (
              <p className="muted">{t("shops.chooseShopToView")}</p>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
