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

function hostnameFromUrl(url) {
  try {
    return String(new URL(String(url || '')).hostname || '').toLowerCase().replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function canonicalizeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    // Ensure https for iOS ATS + consistency
    if (u.protocol !== 'https:') u.protocol = 'https:';
    // Drop fragments
    u.hash = '';
    return u.toString();
  } catch {
    return raw;
  }
}

function canonicalizeVendorUrl(vendorId, url) {
  const raw = canonicalizeUrl(url);
  if (!raw) return '';
  const lower = raw.toLowerCase();

  if (vendorId === 'web:amazon') {
    const asin = extractAmazonAsinFromUrl(raw);
    return asin ? `https://www.amazon.com/dp/${asin}` : raw;
  }

  if (vendorId === 'web:ebay') {
    // Prefer direct listing pages only: https://www.ebay.com/itm/<id>
    const m = raw.match(/https?:\/\/(?:www\.)?ebay\.com\/itm\/(\d+)/i);
    if (m?.[1]) return `https://www.ebay.com/itm/${m[1]}`;
    return raw;
  }

  if (vendorId === 'web:walmart') {
    // Keep only canonical /ip/... path (drop query)
    try {
      const u = new URL(raw);
      if (u.hostname.toLowerCase().includes('walmart.com') && u.pathname.includes('/ip/')) {
        u.search = '';
        return u.toString();
      }
    } catch {}
    return raw;
  }

  if (vendorId === 'web:target') {
    // Keep /p/ path, drop query when present
    try {
      const u = new URL(raw);
      if (u.hostname.toLowerCase().includes('target.com') && u.pathname.includes('/p/')) {
        u.search = '';
        return u.toString();
      }
    } catch {}
    return raw;
  }

  if (vendorId === 'web:bestbuy') {
    try {
      const u = new URL(raw);
      if (u.hostname.toLowerCase().includes('bestbuy.com') && u.pathname.includes('/site/')) {
        u.search = '';
        return u.toString();
      }
    } catch {}
    return raw;
  }

  if (vendorId === 'web:newegg') {
    try {
      const u = new URL(raw);
      if (u.hostname.toLowerCase().includes('newegg.com') && u.pathname.includes('/p/')) {
        u.search = '';
        return u.toString();
      }
    } catch {}
    return raw;
  }

  return raw;
}

function isExactListingUrl(url) {
  const u = String(url || '').toLowerCase();
  if (!u.startsWith('http')) return false;
  if (u.includes('/s?') || u.includes('/search') || u.includes('?q=') || u.includes('&q=') || u.includes('_nkw=')) {
    return false;
  }
  if (
    u.includes('/dp/') ||
    u.includes('/gp/product/') ||
    u.includes('/itm/') ||
    u.includes('walmart.com/ip/') ||
    u.includes('target.com/p/') ||
    u.includes('bestbuy.com/site/') ||
    u.includes('newegg.com/p/')
  ) {
    return true;
  }
  // For other domains, accept non-search, non-query URLs as "listing-ish".
  // (Shopping engines often return canonical product pages.)
  try {
    const parsed = new URL(u);
    return parsed.pathname.length >= 2;
  } catch {
    return false;
  }
}

function slugifyDomain(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/^www\./i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function friendlyVendorName(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^www\./i, '');
  if (!h) return 'Vendor';
  if (h.endsWith('ebay.com')) return 'eBay';
  if (h.endsWith('walmart.com')) return 'Walmart';
  if (h.endsWith('target.com')) return 'Target';
  if (h.endsWith('bestbuy.com')) return 'Best Buy';
  if (h.endsWith('newegg.com')) return 'Newegg';
  if (h.endsWith('amazon.com')) return 'Amazon';
  // Use the registrable-ish first label as a readable name.
  const first = h.split('.')[0] || h;
  return first.slice(0, 1).toUpperCase() + first.slice(1);
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
          productUrl: canonicalizeVendorUrl('web:amazon', r.link),
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
      productUrl: canonicalizeVendorUrl('web:amazon', url || bestSeed.productUrl),
      listingVerified: Boolean(url && url.includes('/dp/')),
      listingType: url && url.includes('/dp/') ? 'EXACT' : bestSeed.listingType
    };
  } catch {
    return bestSeed;
  }
}

async function fetchShoppingVendors(query, strategy) {
  // One SerpAPI call that often includes prices for multiple vendors.
  // We then pick up to 2 distinct non-Amazon vendors (prefer eBay if present).
  const timeoutMs = Math.max(3500, config.webSearchRequestTimeoutMs || 5500);
  const serp = await searchOffersViaSerpApi({
    query,
    host: '',
    engine: 'google_shopping',
    timeoutMs,
    limit: 12
  });

  const candidates = serp
    .map((r, idx) => {
      const link = String(r.link || '').trim();
      if (!isExactListingUrl(link)) return null;
      const host = hostnameFromUrl(link);
      if (!host) return null;

      // Skip Amazon here (handled by dedicated Amazon flow + ASIN hydration).
      if (host.includes('amazon.')) return null;

      // Only allow known retailers to avoid broken/redirector links.
      let vendorId = '';
      let vendorName = '';
      if (host.endsWith('ebay.com')) {
        vendorId = 'web:ebay';
        vendorName = 'eBay';
        if (!link.includes('/itm/')) return null;
      } else if (host.endsWith('walmart.com')) {
        vendorId = 'web:walmart';
        vendorName = 'Walmart';
        if (!link.includes('/ip/')) return null;
      } else if (host.endsWith('target.com')) {
        vendorId = 'web:target';
        vendorName = 'Target';
        if (!link.includes('/p/')) return null;
      } else if (host.endsWith('bestbuy.com')) {
        vendorId = 'web:bestbuy';
        vendorName = 'Best Buy';
        if (!link.includes('/site/')) return null;
      } else if (host.endsWith('newegg.com')) {
        vendorId = 'web:newegg';
        vendorName = 'Newegg';
        if (!link.includes('/p/')) return null;
      } else {
        return null;
      }

      const eta = estimateEtaDaysFromText(r.delivery || r.snippet) || 5;
      return {
        ...normalizeOfferBase({
          vendorId,
          vendorName,
          title: r.title,
          productUrl: canonicalizeVendorUrl(vendorId, link),
          priceCents: parsePriceCents(r.extracted_price || r.price),
          etaDays: eta
        }),
        rank: idx
      };
    })
    .filter((c) => c && Number.isFinite(c.priceCents) && c.priceCents > 0);

  // Pick up to 2 distinct vendors; prefer including eBay if we have it.
  const out = [];
  const seen = new Set();

  const ebay = pickBestOffer(candidates.filter((c) => c.vendorId === 'web:ebay'), strategy);
  if (ebay && !seen.has(ebay.vendorId)) {
    out.push(ebay);
    seen.add(ebay.vendorId);
  }

  // Then fill remaining slot(s) by overall best, skipping duplicates.
  const sorted = candidates.slice().sort((a, b) => (a.priceCents || 1e12) - (b.priceCents || 1e12));
  for (const c of sorted) {
    if (seen.has(c.vendorId)) continue;
    out.push(c);
    seen.add(c.vendorId);
    if (out.length >= 2) break;
  }

  return out;
}

async function fetchTopOffers({ query, strategy }) {
  if (!config.enableWebSearchOffers) return [];
  if (!config.enableSerpApiProxy || !config.serpApiApiKey) return [];

  const capped = normalizeWhitespace(query);
  if (!capped) return [];

  // Hard cap: 3 searches total
  // 1) Amazon search engine call (+ ASIN hydration inside)
  // 2) Google Shopping call (returns eBay + other retailer when available)
  const [amazon, shopping] = await Promise.allSettled([
    fetchAmazonOffer(capped, strategy),
    fetchShoppingVendors(capped, strategy)
  ]);

  const out = [];
  if (amazon.status === 'fulfilled' && amazon.value) out.push(amazon.value);
  if (shopping.status === 'fulfilled' && Array.isArray(shopping.value)) out.push(...shopping.value);

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
