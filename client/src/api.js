const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const TOKEN_KEY = "etsy_scraper_token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function handle(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function authFetch(path, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(`${API_URL}${path}`, { ...options, headers }).then(handle);
}

// --- auth ---

export function register(email, password) {
  return authFetch("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function login(email, password) {
  return authFetch("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function me() {
  return authFetch("/api/auth/me");
}

export function getFxRates() {
  return authFetch("/api/fx-rates");
}

// --- user shops ---

export function addShop(shopUrl, niche) {
  return authFetch("/api/shops", {
    method: "POST",
    body: JSON.stringify({ shop_url: shopUrl, niche: niche || null }),
  });
}

export function listMyShops() {
  return authFetch("/api/shops");
}

export function getMyShop(shopId) {
  return authFetch(`/api/shops/${shopId}`);
}

export function updateShopNiche(shopId, niche) {
  return authFetch(`/api/shops/${shopId}`, {
    method: "PATCH",
    body: JSON.stringify({ niche: niche || null }),
  });
}

export function deleteShop(shopId) {
  return authFetch(`/api/shops/${shopId}`, { method: "DELETE" });
}

export function retryShop(shopId) {
  return authFetch(`/api/shops/${shopId}/retry`, { method: "POST" });
}

export function getShopsReport() {
  return authFetch("/api/shops/report");
}

export function getShopsOverview() {
  return authFetch("/api/shops/overview");
}

// --- admin ---

export function adminQueue() {
  return authFetch("/api/admin/queue");
}

export function adminAllShops() {
  return authFetch("/api/admin/shops");
}

export function adminGetUsers() {
  return authFetch("/api/admin/users");
}

export function adminGetReport() {
  return authFetch("/api/admin/report");
}

export function adminGetShop(shopId) {
  return authFetch(`/api/admin/shops/${shopId}`);
}

export function adminImportHtml(shopId, html) {
  return authFetch(`/api/admin/shops/${shopId}/import`, {
    method: "POST",
    body: JSON.stringify({ html }),
  });
}

export function adminAutoScrape(shopId) {
  return authFetch(`/api/admin/shops/${shopId}/scrape`, { method: "POST" });
}

export function adminGetSettings() {
  return authFetch("/api/admin/settings");
}

export function adminUpdateSettings(maxConcurrent, proxies) {
  return authFetch("/api/admin/settings", {
    method: "PUT",
    body: JSON.stringify({ max_concurrent: maxConcurrent, proxies }),
  });
}

export function adminGetSchedule() {
  return authFetch("/api/admin/schedule");
}

export function adminUpdateSchedule(mode, fixedTime, reviewMode, reviewFixedTime) {
  return authFetch("/api/admin/schedule", {
    method: "PUT",
    body: JSON.stringify({
      mode,
      fixed_time: fixedTime || null,
      review_mode: reviewMode,
      review_fixed_time: reviewFixedTime || null,
    }),
  });
}
