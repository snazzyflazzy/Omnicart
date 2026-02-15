const config = require('../config');

const metrics = {
  attempts: 0,
  successes: 0,
  failures: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  lastStatusCode: null,
  lastUrl: null,
  provider: 'serpapi'
};

const SERP_RESPONSE_CACHE_TTL_MS = Number(process.env.SERPAPI_RESPONSE_CACHE_TTL_MS || 5 * 60 * 1000);
const serpResponseCache = new Map();

function isEnabled() {
  return Boolean(config.enableSerpApiProxy && config.serpApiApiKey);
}

function getMetrics() {
  return {
    ...metrics,
    cacheSize: serpResponseCache.size
  };
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function positiveInteger(value, fallback, min = 1, max = 100) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function parseNumericPrice(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const match = raw.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

function getCachedSerpResponse(cacheKey) {
  if (!cacheKey) return null;
  const entry = serpResponseCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - Number(entry.ts || 0) > SERP_RESPONSE_CACHE_TTL_MS) {
    serpResponseCache.delete(cacheKey);
    return null;
  }
  return entry.payload || null;
}

function setCachedSerpResponse(cacheKey, payload) {
  if (!cacheKey || !payload) return;
  serpResponseCache.set(cacheKey, { payload, ts: Date.now() });
  if (serpResponseCache.size > 500) {
    const oldest = serpResponseCache.keys().next().value;
    if (oldest) serpResponseCache.delete(oldest);
  }
}

async function querySerpApi({
  query = '',
  host = '',
  timeoutMs,
  limit = 12,
  engine = config.serpApiEngine || 'google',
  asin = '',
  noCache = false
}) {
  if (!isEnabled()) throw new Error('SerpAPI proxy is not configured');

  const base = String(config.serpApiBaseUrl || 'https://serpapi.com').replace(/\/+$/g, '');
  const normalizedEngine = String(engine || config.serpApiEngine || 'google').toLowerCase();
  const normalizedLimit = positiveInteger(limit, 12, 1, 25);
  const normalizedAsin = String(asin || '').trim().toUpperCase();
  const safeHost = String(host || '').replace(/^www\./i, '');

  const params = new URLSearchParams({
    api_key: config.serpApiApiKey,
    gl: config.serpApiCountry || 'us',
    hl: config.serpApiLanguage || 'en'
  });

  if (normalizedEngine === 'amazon_product') {
    if (!/^[A-Z0-9]{10}$/.test(normalizedAsin)) {
      throw new Error('SerpAPI amazon_product requires a valid ASIN');
    }
    params.set('engine', 'amazon_product');
    params.set('asin', normalizedAsin);
    params.set('amazon_domain', safeHost || 'amazon.com');
  } else if (normalizedEngine === 'amazon') {
    const scopedQuery = normalizeWhitespace(query);
    if (!scopedQuery) return { search_metadata: { id: null } };
    params.set('engine', 'amazon');
    params.set('k', scopedQuery);
    params.set('amazon_domain', safeHost || 'amazon.com');
    params.set('page', '1');
  } else {
    const scopedQuery = normalizeWhitespace(host ? `site:${host} ${query}` : query);
    if (!scopedQuery) return { search_metadata: { id: null } };
    params.set('engine', normalizedEngine || 'google');
    params.set('q', scopedQuery);
    params.set('num', String(normalizedLimit));
  }
  if (noCache) params.set('no_cache', 'true');

  const cacheable = !noCache;
  const cacheKey = cacheable
    ? `engine=${normalizedEngine}|host=${safeHost}|limit=${normalizedLimit}|query=${normalizeWhitespace(query || '')}|asin=${normalizedAsin}`
    : '';
  if (cacheable) {
    const cached = getCachedSerpResponse(cacheKey);
    if (cached) return cached;
  }

  metrics.attempts += 1;
  metrics.lastAttemptAt = new Date().toISOString();
  metrics.lastError = null;
  metrics.lastStatusCode = null;
  metrics.lastUrl = `${base}/search.json?${params.toString()}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(2000, Number(timeoutMs) || config.serpApiRequestTimeoutMs || 12000));

  try {
    const res = await fetch(`${base}/search.json?${params.toString()}`, {
      method: 'GET',
      headers: { 'user-agent': 'omnicart-prototype/0.1' },
      signal: controller.signal
    });
    metrics.lastStatusCode = res.status;
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`SerpAPI HTTP ${res.status}`);
      err.httpStatus = res.status;
      err.payload = payload;
      throw err;
    }
    metrics.successes += 1;
    metrics.lastSuccessAt = new Date().toISOString();
    if (cacheable) setCachedSerpResponse(cacheKey, payload);
    return payload;
  } catch (error) {
    metrics.failures += 1;
    metrics.lastFailureAt = new Date().toISOString();
    metrics.lastError = String(error?.message || error || 'Unknown SerpAPI error');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeSerpOfferResults(payload, hostFilter, limit) {
  const out = [];
  const seen = new Set();

  const results = [];
  if (Array.isArray(payload?.organic_results)) results.push(...payload.organic_results);
  if (Array.isArray(payload?.shopping_results)) results.push(...payload.shopping_results);
  if (Array.isArray(payload?.inline_shopping_results)) results.push(...payload.inline_shopping_results);
  if (Array.isArray(payload?.organic_results)) {
    // keep; already above
  }

  for (const item of results) {
    const link = normalizeWhitespace(item?.link || item?.url);
    if (!link || !link.startsWith('http')) continue;
    if (hostFilter) {
      try {
        const parsed = new URL(link);
        if (!parsed.host.toLowerCase().includes(hostFilter.replace(/^www\./i, '').toLowerCase())) continue;
      } catch {
        continue;
      }
    }
    if (seen.has(link)) continue;
    seen.add(link);
    out.push({
      title: normalizeWhitespace(item?.title || item?.name),
      link,
      snippet: normalizeWhitespace(item?.snippet || item?.snippet_highlighted_words?.join(' ')),
      price: item?.price || item?.extracted_price || item?.price_raw || null,
      extracted_price: item?.extracted_price || null,
      delivery: item?.delivery || item?.shipping || null
    });
    if (out.length >= limit) break;
  }

  return out;
}

async function searchOffersViaSerpApi({ query, host = '', timeoutMs = config.serpApiRequestTimeoutMs, limit = 12, engine, noCache = false }) {
  const normalizedQuery = normalizeWhitespace(query);
  if (!normalizedQuery) return [];
  const payload = await querySerpApi({
    query: normalizedQuery,
    host: host || undefined,
    timeoutMs,
    limit,
    engine: engine || config.serpApiEngine || 'google',
    noCache
  });
  return normalizeSerpOfferResults(payload, host, limit);
}

function extractAmazonPriceDetails(payload) {
  const priceTextCandidates = [
    payload?.buybox_winner?.price,
    payload?.buybox_winner?.raw,
    payload?.product_results?.price,
    payload?.product_results?.prices?.[0]?.raw,
    payload?.offers?.primary?.price,
    payload?.offers?.[0]?.price
  ].map((value) => normalizeWhitespace(value));

  const numericCandidates = [
    payload?.buybox_winner?.price,
    payload?.buybox_winner?.price?.value,
    payload?.buybox_winner?.price?.raw,
    payload?.buybox_winner?.raw,
    payload?.product_results?.price,
    payload?.product_results?.prices?.[0]?.value,
    payload?.product_results?.prices?.[0]?.raw,
    payload?.offers?.primary?.price,
    payload?.offers?.[0]?.price
  ]
    .map((value) => parseNumericPrice(value))
    .filter((value) => Number.isFinite(value) && value > 0);

  return {
    priceText: priceTextCandidates.find(Boolean) || '',
    extractedPrice: numericCandidates[0] || null
  };
}

function canonicalAmazonProductUrl(asin, rawLink) {
  const cleanAsin = String(asin || '').trim().toUpperCase();
  if (/^[A-Z0-9]{10}$/.test(cleanAsin)) {
    return `https://www.amazon.com/dp/${cleanAsin}`;
  }
  const link = String(rawLink || '').trim();
  if (!link) return '';
  if (!link.startsWith('http')) return '';
  return link;
}

async function fetchAmazonProductViaSerpApi({ asin, timeoutMs = config.serpApiRequestTimeoutMs, noCache = false }) {
  const normalizedAsin = String(asin || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(normalizedAsin)) return null;

  const payload = await querySerpApi({
    query: '',
    host: 'amazon.com',
    timeoutMs: Math.max(3500, Number(timeoutMs) || 8000),
    engine: 'amazon_product',
    asin: normalizedAsin,
    noCache
  });

  const title = normalizeWhitespace(
    payload?.product_results?.title ||
      payload?.product_results?.name ||
      payload?.search_information?.query_displayed ||
      ''
  );
  const link = canonicalAmazonProductUrl(
    normalizedAsin,
    payload?.product_results?.link ||
      payload?.product_results?.url ||
      payload?.buybox_winner?.link
  );
  const { priceText, extractedPrice } = extractAmazonPriceDetails(payload);
  const delivery = normalizeWhitespace(
    payload?.buybox_winner?.delivery ||
      payload?.buybox_winner?.shipping ||
      payload?.buybox_winner?.ships_from ||
      ''
  );

  return {
    asin: normalizedAsin,
    title,
    link,
    priceText,
    extractedPrice,
    delivery,
    source: 'Amazon'
  };
}

module.exports = {
  isEnabled,
  getMetrics,
  searchOffersViaSerpApi,
  fetchAmazonProductViaSerpApi
};

