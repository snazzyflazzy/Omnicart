const config = require('../config');

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/g, '');
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return '';
  if (!email.includes('@')) return '';
  if (email.length > 254) return '';
  return email;
}

function domainFromUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    return String(parsed.host || '').replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function normalizePath(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function isEnabled() {
  return Boolean(config.enableSharedRemoteWatchlistSync && normalizeBaseUrl(config.sharedRemoteWatchlistBaseUrl));
}

function isPullEnabled() {
  return Boolean(config.enableSharedRemoteWatchlistPull && normalizeBaseUrl(config.sharedRemoteWatchlistBaseUrl));
}

function normalizeRemoteItems(payload) {
  const candidates =
    (Array.isArray(payload?.items) && payload.items) ||
    (Array.isArray(payload?.watchlist) && payload.watchlist) ||
    (payload?.lists && Array.isArray(payload.lists.manual) && payload.lists.manual) ||
    [];

  return candidates
    .map((item) => {
      const url = String(item?.url || item?.productUrl || '').trim();
      const title = String(item?.title || '').trim();
      const domain = String(item?.domain || '').trim().toLowerCase();
      const price = item?.price;
      const currency = String(item?.currency || 'USD').trim().toUpperCase() || 'USD';
      if (!url || !title) return null;
      return {
        url,
        title,
        domain,
        price,
        currency,
        image_url: item?.image_url || item?.imageUrl || null
      };
    })
    .filter(Boolean);
}

async function fetchRemoteWatchlistItems({ email }) {
  if (!isPullEnabled()) return { ok: false, skipped: true, reason: 'disabled', items: [] };

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return { ok: false, skipped: true, reason: 'invalid_email', items: [] };

  const base = normalizeBaseUrl(config.sharedRemoteWatchlistBaseUrl);
  const path = normalizePath(config.sharedRemoteWatchlistPullPath, '/items');
  const endpoint = `${base}${path}?email=${encodeURIComponent(normalizedEmail)}`;

  const controller = new AbortController();
  const timeoutMs = Math.max(1200, Number(config.sharedRemoteWatchlistTimeoutMs) || 7000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const err = new Error(`Remote watchlist fetch failed (${res.status})`);
      err.httpStatus = res.status;
      err.responseText = text.slice(0, 240);
      throw err;
    }

    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    const items = normalizeRemoteItems(parsed);
    return { ok: true, endpoint, items, raw: parsed };
  } finally {
    clearTimeout(timer);
  }
}

async function pushRemoteWatchlist({ email, items }) {
  if (!isEnabled()) return { ok: false, skipped: true, reason: 'disabled' };

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return { ok: false, skipped: true, reason: 'invalid_email' };

  const base = normalizeBaseUrl(config.sharedRemoteWatchlistBaseUrl);
  const endpoint = `${base}/watchlist/sync?email=${encodeURIComponent(normalizedEmail)}`;

  const controller = new AbortController();
  const timeoutMs = Math.max(1200, Number(config.sharedRemoteWatchlistTimeoutMs) || 7000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: Array.isArray(items) ? items : [] }),
      signal: controller.signal
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const err = new Error(`Remote watchlist sync failed (${res.status})`);
      err.httpStatus = res.status;
      err.responseText = text.slice(0, 240);
      throw err;
    }
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { ok: true, endpoint, response: parsed };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  isEnabled,
  isPullEnabled,
  domainFromUrl,
  fetchRemoteWatchlistItems,
  pushRemoteWatchlist
};

