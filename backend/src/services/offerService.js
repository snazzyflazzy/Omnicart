const { prisma } = require('../db');
const config = require('../config');
const { fetchTopOffers } = require('./offerProviders/webSearchProvider');

const SEARCH_MODE = {
  EXACT: 'EXACT',
  SIMILAR: 'SIMILAR'
};

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isLikelySearchUrl(url) {
  const u = String(url || '').toLowerCase();
  return (
    u.includes('/s?') ||
    u.includes('/search') ||
    u.includes('?q=') ||
    u.includes('&q=') ||
    u.includes('_nkw=')
  );
}

function isExactListingUrl(url) {
  const u = String(url || '').toLowerCase();
  return (
    u.includes('/dp/') ||
    u.includes('/gp/product/') ||
    u.includes('/itm/') ||
    u.includes('walmart.com/ip/') ||
    u.includes('target.com/p/') ||
    u.includes('bestbuy.com/site/')
  );
}

function normalizeOffer(dbOffer) {
  const productUrl = String(dbOffer.productUrl || '').trim();
  const listingVerified = isExactListingUrl(productUrl) && !isLikelySearchUrl(productUrl);
  const listingType = listingVerified ? 'EXACT' : productUrl ? 'ESTIMATED' : 'ESTIMATED';

  return {
    id: dbOffer.id,
    vendorId: dbOffer.vendorId,
    vendorName: dbOffer.vendorName,
    productId: dbOffer.productId,
    title: dbOffer.title,
    priceCents: dbOffer.priceCents,
    shippingCents: dbOffer.shippingCents,
    etaDays: dbOffer.etaDays,
    inStock: dbOffer.inStock,
    productUrl,
    listingVerified,
    listingType,
    itemCondition: null
  };
}

async function ensureActionableOffer(offer) {
  if (!offer) return null;
  // For now, offers are already actionable if they have a URL.
  return offer;
}

function recommendedOfferIdForStrategy(offers, strategy) {
  const list = Array.isArray(offers) ? offers.filter((o) => o && o.inStock) : [];
  if (list.length === 0) return null;
  const pref = String(strategy || 'BALANCED').toUpperCase();

  const sorted = list.slice().sort((a, b) => {
    const at = a.priceCents + a.shippingCents;
    const bt = b.priceCents + b.shippingCents;

    if (pref === 'FASTEST_SHIPPING') {
      if (a.etaDays !== b.etaDays) return a.etaDays - b.etaDays;
      return at - bt;
    }
    if (pref === 'BEST_PRICE') {
      if (at !== bt) return at - bt;
      return a.etaDays - b.etaDays;
    }
    // BALANCED
    if (at !== bt) return at - bt;
    return a.etaDays - b.etaDays;
  });

  return sorted[0]?.id || null;
}

async function refreshWebOffersForProduct(productId, strategy) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) return;

  const query = normalizeWhitespace(`${product.brand} ${product.title}`.trim());
  if (!query) return;

  if (config.enableWebSearchOffers && config.enableSerpApiProxy && config.serpApiApiKey) {
    try {
      const webOffers = await fetchTopOffers({ query, strategy });
      await Promise.allSettled(
        (Array.isArray(webOffers) ? webOffers : []).map(async (o) => {
          if (!o?.vendorId || !o?.productUrl || !o?.priceCents) return;
          await prisma.offer.upsert({
            where: {
              productId_vendorId: {
                productId,
                vendorId: o.vendorId
              }
            },
            update: {
              vendorName: o.vendorName || o.vendorId,
              title: o.title || product.title,
              priceCents: o.priceCents,
              shippingCents: Number.isFinite(o.shippingCents) ? o.shippingCents : 0,
              etaDays: Number.isFinite(o.etaDays) ? o.etaDays : 5,
              inStock: o.inStock !== false,
              productUrl: String(o.productUrl || '').trim()
            },
            create: {
              productId,
              vendorId: o.vendorId,
              vendorName: o.vendorName || o.vendorId,
              title: o.title || product.title,
              priceCents: o.priceCents,
              shippingCents: Number.isFinite(o.shippingCents) ? o.shippingCents : 0,
              etaDays: Number.isFinite(o.etaDays) ? o.etaDays : 5,
              inStock: o.inStock !== false,
              productUrl: String(o.productUrl || '').trim()
            }
          });
        })
      );
    } catch (error) {
      // Never fail the whole request just because a web provider timed out / throttled.
      console.warn('[Offers:web] refresh failed', error?.message || error);
    }
  }

  // Demo reliability: if live search only returns 0-1 offers (common with anti-bot / missing prices),
  // synthesize additional vendor options as "estimated" search links so the UI can always show choices.
  const existing = await prisma.offer.findMany({ where: { productId, inStock: true } });
  if (existing.length >= 3) return;

  const existingVendorIds = new Set(existing.map((o) => o.vendorId));
  const minPrice = existing.reduce((m, o) => Math.min(m, o.priceCents || 1e12), 1e12);
  const basePrice = Number.isFinite(minPrice) && minPrice < 1e12 ? minPrice : 1999;

  const q = encodeURIComponent(query);
  const fallbacks = [
    {
      vendorId: 'fallback:ebay',
      vendorName: 'eBay',
      url: `https://www.ebay.com/sch/i.html?_nkw=${q}`,
      priceMult: 0.92,
      etaDays: 6
    },
    {
      vendorId: 'fallback:walmart',
      vendorName: 'Walmart',
      url: `https://www.walmart.com/search?q=${q}`,
      priceMult: 0.98,
      etaDays: 4
    },
    {
      vendorId: 'fallback:target',
      vendorName: 'Target',
      url: `https://www.target.com/s?searchTerm=${q}`,
      priceMult: 1.03,
      etaDays: 5
    },
    {
      vendorId: 'fallback:bestbuy',
      vendorName: 'Best Buy',
      url: `https://www.bestbuy.com/site/searchpage.jsp?st=${q}`,
      priceMult: 1.05,
      etaDays: 5
    }
  ];

  for (const fb of fallbacks) {
    if (existingVendorIds.has(fb.vendorId)) continue;
    const priceCents = Math.max(99, Math.round(basePrice * fb.priceMult));
    await prisma.offer.create({
      data: {
        productId,
        vendorId: fb.vendorId,
        vendorName: fb.vendorName,
        title: product.title,
        priceCents,
        shippingCents: 0,
        etaDays: fb.etaDays,
        inStock: true,
        productUrl: fb.url
      }
    });
    existingVendorIds.add(fb.vendorId);
    if (existingVendorIds.size >= 3) break;
  }
}

async function getRankedOffers({
  productId,
  userId,
  strategy = 'BALANCED',
  refreshLive = false
}) {
  if (refreshLive) {
    try {
      await refreshWebOffersForProduct(productId, strategy);
    } catch (error) {
      // Safety net: refreshWebOffersForProduct already swallows web errors,
      // but keep this to guarantee offer reads never 500.
      console.warn('[Offers] refreshLive failed', error?.message || error);
    }
  }

  const offers = await prisma.offer.findMany({
    where: { productId, inStock: true }
  });
  const normalized = offers.map(normalizeOffer);
  const recommendedOfferId = recommendedOfferIdForStrategy(normalized, strategy);
  return { offers: normalized, recommendedOfferId, strategy };
}

async function searchOfferCandidates({
  query,
  brandHint,
  userId,
  strategy = 'BALANCED',
  limit = 8
}) {
  const q = normalizeWhitespace(query).toLowerCase();
  const take = Math.max(1, Math.min(20, Number(limit) || 8));

  let products = [];
  if (q) {
    // SQLite connector does not support `mode: 'insensitive'` on string filters.
    // Use a raw LIKE query to get case-insensitive matching.
    const like = `%${q.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    products = await prisma.$queryRaw`
      SELECT id, title, brand, upc, imageUrl
      FROM Product
      WHERE lower(title) LIKE ${like} ESCAPE '\\'
         OR lower(brand) LIKE ${like} ESCAPE '\\'
      LIMIT ${take}
    `;
  }

  if (products.length === 0 && q) {
    const created = await prisma.product.create({
      data: {
        title: normalizeWhitespace(query),
        brand: normalizeWhitespace(brandHint) || 'Unknown',
        upc: null,
        imageUrl: null
      }
    });
    products = [created];
  }

  const candidates = [];
  for (const product of products) {
    const bundle = await getRankedOffers({
      productId: product.id,
      userId,
      strategy,
      refreshLive: true
    });
    const bestOffer = bundle.recommendedOfferId
      ? bundle.offers.find((o) => o.id === bundle.recommendedOfferId) || null
      : bundle.offers[0] || null;
    candidates.push({
      product,
      offers: bundle.offers,
      recommendedOfferId: bundle.recommendedOfferId,
      bestOffer
    });
  }

  return { candidates, strategy };
}

module.exports = {
  SEARCH_MODE,
  normalizeOffer,
  ensureActionableOffer,
  getRankedOffers,
  searchOfferCandidates
};
