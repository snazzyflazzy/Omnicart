const config = require('../config');

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeUpc(value) {
  return String(value || '').replace(/\D/g, '');
}

function buildAbort(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(800, Number(timeoutMs) || 5000));
  return { controller, timeout };
}

async function lookupUpcItemDb(upc, timeoutMs) {
  if (!config.enableUpcItemDbLookup) return null;
  const normalized = normalizeUpc(upc);
  if (!normalized) return null;

  const base = String(config.upcItemDbApiBaseUrl || 'https://api.upcitemdb.com').replace(/\/+$/g, '');
  // Trial endpoint works without a key; paid endpoints use a key header.
  const url = `${base}/prod/trial/lookup?upc=${encodeURIComponent(normalized)}`;
  const { controller, timeout } = buildAbort(timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: config.upcItemDbApiKey ? { key: config.upcItemDbApiKey } : {},
      signal: controller.signal
    });
    if (!res.ok) return null;
    const payload = await res.json().catch(() => ({}));
    const item = Array.isArray(payload?.items) ? payload.items[0] : null;
    if (!item) return null;
    const title = normalizeWhitespace(item.title);
    const brand = normalizeWhitespace(item.brand);
    const imageUrl = Array.isArray(item.images) ? item.images[0] : item.image || null;
    if (!title) return null;
    return {
      source: 'upcitemdb',
      upc: normalized,
      title,
      brand: brand || 'Unknown',
      imageUrl: imageUrl ? String(imageUrl) : null
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function lookupOpenFoodFacts(upc, timeoutMs) {
  if (!config.enableOpenFoodFactsLookup) return null;
  const normalized = normalizeUpc(upc);
  if (!normalized) return null;

  const base = String(config.openFoodFactsApiBaseUrl || 'https://world.openfoodfacts.org').replace(/\/+$/g, '');
  const url = `${base}/api/v0/product/${encodeURIComponent(normalized)}.json`;
  const { controller, timeout } = buildAbort(timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!res.ok) return null;
    const payload = await res.json().catch(() => ({}));
    if (payload?.status !== 1) return null;
    const prod = payload?.product || {};
    const title = normalizeWhitespace(prod.product_name || prod.generic_name || prod.abbreviated_product_name);
    const brandRaw = normalizeWhitespace(prod.brands);
    const brand = brandRaw ? brandRaw.split(',')[0].trim() : '';
    const imageUrl = prod.image_url || prod.image_front_url || null;
    if (!title) return null;
    return {
      source: 'openfoodfacts',
      upc: normalized,
      title,
      brand: brand || 'Unknown',
      imageUrl: imageUrl ? String(imageUrl) : null
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function lookupUpc(upc) {
  if (!config.enableUpcDbLookup) return null;
  const timeoutMs = config.upcDbLookupTimeoutMs || 5000;

  // Try UPCItemDB first, then OpenFoodFacts.
  const [itemDb, off] = await Promise.allSettled([
    lookupUpcItemDb(upc, timeoutMs),
    lookupOpenFoodFacts(upc, timeoutMs)
  ]);

  const first = itemDb.status === 'fulfilled' ? itemDb.value : null;
  if (first) return first;
  const second = off.status === 'fulfilled' ? off.value : null;
  return second || null;
}

module.exports = { lookupUpc };

