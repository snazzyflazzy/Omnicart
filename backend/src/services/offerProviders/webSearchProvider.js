const config = require('../../config');
const { searchOffersViaSerpApi, fetchAmazonProductViaSerpApi } = require('../brightDataProxyService');

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function parsePriceCents(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return toCents(value);
  const raw = String(value).replace(/,/g, '').trim();
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  return toCents(Number(match[1]));
}

function estimateEtaDaysFromText(text) {
  const raw = String(text || '').toLowerCase();
  const m = raw.match(/(\d+)\s*(?:day|days)/);
  if (m?.[1]) {
    const d = Math.max(1, Math.min(14, Number(m[1])));
    if (Number.isFinite(d)) return d;
  }
  return null;
}

function extractAmazonAsinFromUrl(url) {
  const u = String(url || '');
  const m = u.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})\b/i);
  return m?.[1] ? String(m[1]).toUpperCase() : '';
}

function pickBestOffer(offers, strategy) {
  const list = Array.isArray(offers) ? offers.slice() : [];
  if (list.length === 0) return null;
  const pref = String(strategy || 'BALANCED').toUpperCase();
  if (pref === 'FASTEST_SHIPPING') {
    return list.sort((a, b) => (a.etaDays || 99) - (b.etaDays || 99))[0] || null;
  }
  if (pref === 'BEST_PRICE') {
    return list.sort((a, b) => (a.priceCents || 1e12) - (b.priceCents || 1e12))[0] || null;
  }
  // Balanced: lowest total, break ties by eta.
  return list
    .sort((a, b) => {
      const at = (a.priceCents || 1e12) + (a.shippingCents || 0);
      const bt = (b.priceCents || 1e12) + (b.shippingCents || 0);
      if (at !== bt) return at - bt;
      return (a.etaDays || 99) - (b.etaDays || 99);
    })[0] || null;
}

function normalizeOfferBase({ vendorId, vendorName, title, productUrl, priceCents, etaDays }) {
  return {
    vendorId,
    vendorName,
    title: normalizeWhitespace(title) || '',
    priceCents: Number.isFinite(priceCents) ? priceCents : null,
    shippingCents: 0,
    etaDays: Number.isFinite(etaDays) ? etaDays : 5,
    inStock: true,
    productUrl: String(productUrl || '').trim(),
    listingVerified: false,
    listingType: 'ESTIMATED',
    itemCondition: null
  };
}

async function fetchAmazonOffer(query, strategy) {
  const timeoutMs = Math.max(3500, config.webSearchRequestTimeoutMs || 5500);
  const serp = await searchOffersViaSerpApi({
    query,
    host: 'amazon.com',
    engine: 'amazon',
    timeoutMs,
    limit: 8
  });

  const candidates = serp
    .map((r, idx) => {
      const asin = extractAmazonAsinFromUrl(r.link);
      if (!asin) return null;
      const eta = estimateEtaDaysFromText(r.delivery || r.snippet) || 4;
      return {
        ...normalizeOfferBase({
          vendorId: 'web:amazon',
          vendorName: 'Amazon',
          title: r.title,
          productUrl: r.link,
          priceCents: parsePriceCents(r.extracted_price || r.price),
          etaDays: eta
        }),
        rank: idx,
        asin
      };
    })
    .filter(Boolean);

  const bestSeed = pickBestOffer(candidates, strategy);
  if (!bestSeed) return null;

  // Hydrate price + canonical listing via ASIN (1 extra call).
  try {
    const detail = await fetchAmazonProductViaSerpApi({ asin: bestSeed.asin, timeoutMs, noCache: false });
    const priceCents =
      (Number.isFinite(Number(detail?.extractedPrice)) && Number(detail.extractedPrice) > 0
        ? toCents(Number(detail.extractedPrice))
        : null) ||
      parsePriceCents(detail?.priceText) ||
      bestSeed.priceCents;
    const eta = estimateEtaDaysFromText(detail?.delivery) || bestSeed.etaDays || 4;
    const url = String(detail?.link || bestSeed.productUrl || '').trim();

    return {
      ...bestSeed,
      title: normalizeWhitespace(detail?.title) || bestSeed.title,
      priceCents,
      etaDays: eta,
      productUrl: url || bestSeed.productUrl,
      listingVerified: Boolean(url && url.includes('/dp/')),
      listingType: url && url.includes('/dp/') ? 'EXACT' : bestSeed.listingType
    };
  } catch {
    return bestSeed;
  }
}

async function fetchEbayOffer(query, strategy) {
  const timeoutMs = Math.max(3500, config.webSearchRequestTimeoutMs || 5500);
  const serp = await searchOffersViaSerpApi({
    query,
    host: 'ebay.com',
    engine: 'google',
    timeoutMs,
    limit: 8
  });

  const candidates = serp
    .map((r, idx) => {
      const link = String(r.link || '').trim();
      if (!link.includes('/itm/')) return null; // avoid search pages
      const eta = estimateEtaDaysFromText(r.delivery || r.snippet) || 5;
      return {
        ...normalizeOfferBase({
          vendorId: 'web:ebay',
          vendorName: 'eBay',
          title: r.title,
          productUrl: link,
          priceCents: parsePriceCents(r.extracted_price || r.price),
          etaDays: eta
        }),
        rank: idx
      };
    })
    .filter(Boolean);

  return pickBestOffer(candidates, strategy);
}

async function fetchMiscOffer(query, strategy) {
  const timeoutMs = Math.max(3500, config.webSearchRequestTimeoutMs || 5500);
  const scoped = `${query} (site:walmart.com/ip OR site:target.com/p OR site:bestbuy.com/site OR site:newegg.com/p)`;
  const serp = await searchOffersViaSerpApi({
    query: scoped,
    host: '',
    engine: 'google',
    timeoutMs,
    limit: 10
  });

  const candidates = serp
    .map((r, idx) => {
      const link = String(r.link || '').trim();
      if (!link) return null;
      let vendorName = '';
      let vendorId = '';
      if (link.includes('walmart.com/')) {
        vendorName = 'Walmart';
        vendorId = 'web:walmart';
      } else if (link.includes('target.com/')) {
        vendorName = 'Target';
        vendorId = 'web:target';
      } else if (link.includes('bestbuy.com/')) {
        vendorName = 'Best Buy';
        vendorId = 'web:bestbuy';
      } else if (link.includes('newegg.com/')) {
        vendorName = 'Newegg';
        vendorId = 'web:newegg';
      } else {
        return null;
      }
      const eta = estimateEtaDaysFromText(r.delivery || r.snippet) || 5;
      return {
        ...normalizeOfferBase({
          vendorId,
          vendorName,
          title: r.title,
          productUrl: link,
          priceCents: parsePriceCents(r.extracted_price || r.price),
          etaDays: eta
        }),
        rank: idx
      };
    })
    .filter(Boolean);

  return pickBestOffer(candidates, strategy);
}

async function fetchTopOffers({ query, strategy }) {
  if (!config.enableWebSearchOffers) return [];
  if (!config.enableSerpApiProxy || !config.serpApiApiKey) return [];

  const capped = normalizeWhitespace(query);
  if (!capped) return [];

  // Hard cap: 3 searches total (Amazon, eBay, misc).
  const [amazon, ebay, misc] = await Promise.allSettled([
    fetchAmazonOffer(capped, strategy),
    fetchEbayOffer(capped, strategy),
    fetchMiscOffer(capped, strategy)
  ]);

  const out = [];
  for (const settled of [amazon, ebay, misc]) {
    if (settled.status === 'fulfilled' && settled.value) out.push(settled.value);
  }

  // Ensure unique vendorIds.
  const seen = new Set();
  return out.filter((o) => {
    if (!o?.vendorId) return false;
    if (seen.has(o.vendorId)) return false;
    seen.add(o.vendorId);
    return true;
  });
}

module.exports = {
  fetchTopOffers
};

