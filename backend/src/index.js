const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const { prisma } = require('./db');
const config = require('./config');

const { recognizeProduct } = require('./services/recognitionService');
const {
  isEnabled: aiEnabled,
  getAIMetrics,
  pingOpenAI,
  getLastAIDebug
} = require('./services/aiVisionService');
const {
  isEnabled: serpEnabled,
  getMetrics: getSerpMetrics
} = require('./services/brightDataProxyService');
const {
  getRankedOffers,
  searchOfferCandidates,
  normalizeOffer,
  ensureActionableOffer
} = require('./services/offerService');
const { createPaymentService } = require('./services/payment');
const { runPriceTick } = require('./services/priceMonitor');
const {
  isEnabled: sharedRemoteSyncEnabled,
  isPullEnabled: sharedRemotePullEnabled,
  domainFromUrl: sharedRemoteDomainFromUrl,
  fetchRemoteWatchlistItems,
  pushRemoteWatchlist
} = require('./services/sharedRemoteWatchlistService');

const app = express();
const paymentService = createPaymentService();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function respondError(res, req, status, publicMessage, error) {
  const payload = {
    error: String(publicMessage || 'Server error'),
    requestId: req?.requestId || null
  };
  if (config.nodeEnv !== 'production' && error) {
    payload.detail = String(error?.message || error);
  }
  return res.status(status).json(payload);
}

function respond500(res, req, publicMessage, error) {
  return respondError(res, req, 500, publicMessage, error);
}

// Add a requestId and simple access log (useful for debugging 500s from the iOS app).
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  res.setHeader('x-request-id', req.requestId);

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(
      `[${req.requestId}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs.toFixed(1)}ms)`
    );
  });

  next();
});

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return '';
  if (!email.includes('@')) return '';
  if (email.length > 254) return '';
  return email;
}

function headerToken(req) {
  const direct =
    req.get('x-omnicart-webhook-secret') ||
    req.get('x-windowtap-webhook-secret') ||
    req.get('x-webhook-secret');
  if (direct) return String(direct).trim();
  const auth = String(req.get('authorization') || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return '';
}

function normalizeCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num);
}

function dollarsToCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num * 100);
}

function centsToDollars(priceCents) {
  const cents = Number(priceCents);
  if (!Number.isFinite(cents) || cents <= 0) return null;
  return Number((cents / 100).toFixed(2));
}

function slugifyToken(value, fallback) {
  const token = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return token || fallback;
}

function vendorIdForSharedDomain(domain) {
  const normalized = String(domain || '').trim().toLowerCase().replace(/^www\./i, '');
  if (!normalized) return 'shared:unknown';
  return `shared:${slugifyToken(normalized, 'site')}`;
}

async function ensureUserByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const existing = await prisma.user.findUnique({ where: { email: normalized } });
  if (existing) return existing;
  const name = normalized.split('@')[0].slice(0, 48) || 'OmniCart User';
  return prisma.user.create({
    data: {
      name,
      email: normalized,
      preference: 'BALANCED',
      visaTestToken: 'visa_test_tok_4242',
      defaultPctDropThreshold: 15,
      shippingImprovementOn: false
    }
  });
}

async function ensureProductFromSharedItem(sharedItem) {
  const listingUrl = String(
    sharedItem?.productUrl ||
      sharedItem?.preferredProductUrl ||
      sharedItem?.url ||
      ''
  ).trim();
  if (listingUrl) {
    const existingByUrl = await prisma.offer.findFirst({
      where: { productUrl: listingUrl },
      include: { product: true }
    });
    if (existingByUrl?.product) return existingByUrl.product;
  }

  const upc = String(sharedItem?.upc || '').replace(/\D/g, '');
  if (upc) {
    const byUpc = await prisma.product.findFirst({ where: { upc } });
    if (byUpc) return byUpc;
  }

  const title = normalizeWhitespace(sharedItem?.title);
  const brand = normalizeWhitespace(sharedItem?.brand) || 'Unknown';
  if (!title) return null;

  const existing = await prisma.product.findFirst({ where: { title, brand } });
  if (existing) return existing;

  return prisma.product.create({
    data: {
      title,
      brand,
      upc: upc || null,
      imageUrl: sharedItem?.imageUrl
        ? String(sharedItem.imageUrl)
        : sharedItem?.image_url
          ? String(sharedItem.image_url)
          : null
    }
  });
}

function normalizeSharedAlertRules(sharedItem, user) {
  const directRules =
    sharedItem?.alertRules && typeof sharedItem.alertRules === 'object' ? sharedItem.alertRules : {};
  const pctDropThreshold = Number(
    directRules.pctDropThreshold ??
      sharedItem?.pctDropThreshold ??
      user?.defaultPctDropThreshold ??
      15
  );
  const targetPriceCents =
    directRules.targetPriceCents !== undefined
      ? normalizeCents(directRules.targetPriceCents)
      : sharedItem?.targetPriceCents !== undefined
        ? normalizeCents(sharedItem.targetPriceCents)
        : null;
  const shippingImprovementOn = Boolean(
    directRules.shippingImprovementOn ??
      sharedItem?.shippingImprovementOn ??
      user?.shippingImprovementOn ??
      false
  );

  return {
    pctDropThreshold: Number.isFinite(pctDropThreshold) ? pctDropThreshold : 15,
    targetPriceCents,
    shippingImprovementOn
  };
}

async function applySharedWatchlistSync({ email, items, replace }) {
  const normalizedEmail = normalizeEmail(email);
  const list = Array.isArray(items) ? items : [];
  const shouldReplace = Boolean(replace);

  if (!normalizedEmail) return { ok: false, error: 'email is required' };
  const user = await ensureUserByEmail(normalizedEmail);
  if (!user) return { ok: false, error: 'Invalid email' };

  const existing = await prisma.watchlist.findMany({
    where: { userId: user.id },
    include: { product: true }
  });

  const keptProductIds = new Set();
  let importedCount = 0;
  let skippedCount = 0;

  for (const sharedItem of list) {
    const product = await ensureProductFromSharedItem(sharedItem);
    if (!product) {
      skippedCount += 1;
      continue;
    }
    keptProductIds.add(product.id);

    const { pctDropThreshold, targetPriceCents, shippingImprovementOn } = normalizeSharedAlertRules(
      sharedItem,
      user
    );

    const preferredProductUrl =
      String(
        sharedItem?.productUrl ||
          sharedItem?.preferredProductUrl ||
          sharedItem?.url ||
          ''
      ).trim() || null;
    const preferredVendorName =
      String(sharedItem?.vendorName || sharedItem?.domain || '').trim() ||
      (preferredProductUrl ? sharedRemoteDomainFromUrl(preferredProductUrl) : '') ||
      null;

    const listingDomain =
      String(sharedItem?.domain || '').trim().toLowerCase().replace(/^www\./i, '') ||
      (preferredProductUrl ? sharedRemoteDomainFromUrl(preferredProductUrl) : '');
    const listingPriceCents =
      sharedItem?.priceCents !== undefined
        ? normalizeCents(sharedItem.priceCents)
        : dollarsToCents(sharedItem?.price);
    if (preferredProductUrl && listingDomain && listingPriceCents) {
      const vendorId = vendorIdForSharedDomain(listingDomain);
      await prisma.offer.upsert({
        where: {
          productId_vendorId: {
            productId: product.id,
            vendorId
          }
        },
        update: {
          vendorName: listingDomain,
          title: normalizeWhitespace(sharedItem?.title) || product.title,
          priceCents: listingPriceCents,
          shippingCents: 0,
          etaDays: 5,
          inStock: true,
          productUrl: preferredProductUrl
        },
        create: {
          productId: product.id,
          vendorId,
          vendorName: listingDomain,
          title: normalizeWhitespace(sharedItem?.title) || product.title,
          priceCents: listingPriceCents,
          shippingCents: 0,
          etaDays: 5,
          inStock: true,
          productUrl: preferredProductUrl
        }
      });
    }

    await prisma.watchlist.upsert({
      where: {
        userId_productId: {
          userId: user.id,
          productId: product.id
        }
      },
      update: {
        pctDropThreshold,
        targetPriceCents,
        shippingImprovementOn,
        preferredVendorName,
        preferredProductUrl
      },
      create: {
        userId: user.id,
        productId: product.id,
        pctDropThreshold,
        targetPriceCents,
        shippingImprovementOn,
        preferredVendorName,
        preferredProductUrl
      }
    });

    importedCount += 1;
  }

  let removedCount = 0;
  if (shouldReplace) {
    const keepList = [...keptProductIds];
    const toRemove = existing.filter((item) => !keptProductIds.has(item.productId));
    removedCount = toRemove.length;
    if (keepList.length === 0) {
      await prisma.watchlist.deleteMany({ where: { userId: user.id } });
    } else {
      await prisma.watchlist.deleteMany({
        where: {
          userId: user.id,
          productId: { notIn: keepList }
        }
      });
    }
  }

  return {
    ok: true,
    userId: user.id,
    email: normalizedEmail,
    replace: shouldReplace,
    importedCount,
    skippedCount,
    removedCount
  };
}

async function buildWatchlistItemsResponse(items, userId) {
  const productIds = [...new Set(items.map((item) => item.productId))];
  const offers = await prisma.offer.findMany({
    where: { productId: { in: productIds }, inStock: true }
  });

  const offersByProductId = new Map();
  for (const offer of offers) {
    const normalized = normalizeOffer(offer);
    const existing = offersByProductId.get(offer.productId) || [];
    existing.push(normalized);
    offersByProductId.set(offer.productId, existing);
  }

  const bestByProductId = new Map();
  for (const offer of offers) {
    const normalized = normalizeOffer(offer);
    const existing = bestByProductId.get(offer.productId);
    if (!existing) {
      bestByProductId.set(offer.productId, normalized);
      continue;
    }
    const existingTotal = existing.priceCents + existing.shippingCents;
    const nextTotal = normalized.priceCents + normalized.shippingCents;
    if (nextTotal < existingTotal || (nextTotal === existingTotal && normalized.etaDays < existing.etaDays)) {
      bestByProductId.set(offer.productId, normalized);
    }
  }

  return Promise.all(
    items.map(async (item) => {
      const productOffers = offersByProductId.get(item.productId) || [];
      const preferredOffer =
        (item.preferredOfferId &&
          productOffers.find((o) => o.id === item.preferredOfferId)) ||
        (item.preferredVendorId &&
          productOffers.find((o) => o.vendorId === item.preferredVendorId)) ||
        (item.preferredProductUrl &&
          productOffers.find((o) => String(o.productUrl || '') === String(item.preferredProductUrl || ''))) ||
        null;

      const bestOfferRaw = preferredOffer || bestByProductId.get(item.productId) || null;
      const bestOffer = bestOfferRaw ? await ensureActionableOffer(bestOfferRaw) : null;
      const lastSeen = item.lastSeenBestPriceCents || bestOffer?.priceCents || 0;
      const deltaPct =
        lastSeen > 0 && bestOffer
          ? Number((((bestOffer.priceCents - lastSeen) / lastSeen) * 100).toFixed(1))
          : 0;

      return {
        ...item,
        bestOffer,
        deltaPct
      };
    })
  );
}

async function syncRemoteWatchlistFromLocal(userId) {
  if (!sharedRemoteSyncEnabled()) return;

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.email) return;

    const watchItems = await prisma.watchlist.findMany({
      where: { userId },
      include: { product: true },
      orderBy: { createdAt: 'desc' }
    });

    const productIds = [...new Set(watchItems.map((w) => w.productId))];
    const offers = await prisma.offer.findMany({
      where: { productId: { in: productIds }, inStock: true }
    });
    const offersByProductId = new Map();
    for (const offer of offers) {
      const existing = offersByProductId.get(offer.productId) || [];
      existing.push(offer);
      offersByProductId.set(offer.productId, existing);
    }

    const remoteItems = [];
    for (const item of watchItems) {
      const productOffers = offersByProductId.get(item.productId) || [];
      const preferredUrl = String(item.preferredProductUrl || '').trim();
      const preferredOffer = preferredUrl
        ? productOffers.find((o) => String(o.productUrl || '') === preferredUrl) || null
        : null;

      let bestOffer = preferredOffer;
      if (!bestOffer && productOffers.length > 0) {
        bestOffer = productOffers.reduce((best, next) => {
          if (!best) return next;
          const bt = best.priceCents + best.shippingCents;
          const nt = next.priceCents + next.shippingCents;
          if (nt < bt) return next;
          if (nt === bt && next.etaDays < best.etaDays) return next;
          return best;
        }, null);
      }

      const url = preferredUrl || String(bestOffer?.productUrl || '').trim();
      if (!url) continue;
      const domain = sharedRemoteDomainFromUrl(url) || String(item.preferredVendorName || '').trim().toLowerCase();
      const price = centsToDollars(bestOffer?.priceCents);
      if (!domain || !price) continue;

      remoteItems.push({
        url,
        title: item.product.title,
        domain,
        price,
        currency: 'USD'
      });
    }

    await pushRemoteWatchlist({ email: user.email, items: remoteItems });
  } catch (error) {
    console.warn('[SharedWatchlist:remote] upsync failed', error?.message || error);
  }
}

app.get('/health', async (req, res) => {
  const counts = {
    users: await prisma.user.count(),
    products: await prisma.product.count(),
    offers: await prisma.offer.count()
  };
  res.json({ status: 'ok', counts });
});

app.get('/debug/ai-status', (req, res) => {
  const keySet = Boolean(config.openaiApiKey);
  const keyPrefix = keySet ? `${String(config.openaiApiKey).slice(0, 7)}...` : null;
  res.json({
    enabledByConfig: config.enableAIRecognition,
    keySet,
    keyPrefix,
    aiRecognitionEnabled: aiEnabled(),
    model: config.openaiVisionModel,
    reasoningEffort: config.openaiVisionReasoningEffort || null,
    maxOutputTokens: config.openaiVisionMaxOutputTokens,
    apiBaseUrl: config.openaiApiBaseUrl,
    timeoutMs: config.aiRecognitionTimeoutMs,
    metrics: getAIMetrics()
  });
});

app.post('/debug/ai-ping', async (req, res) => {
  try {
    const result = await pingOpenAI();
    return res.json(result);
  } catch (error) {
    return respond500(res, req, error?.message || 'OpenAI ping failed', error);
  }
});

app.get('/debug/ai-last', (req, res) => {
  return res.json(getLastAIDebug());
});

app.get('/debug/serpapi-status', (req, res) => {
  return res.json({
    enabled: serpEnabled(),
    apiBaseUrl: config.serpApiBaseUrl,
    apiKeySet: Boolean(config.serpApiApiKey),
    engine: config.serpApiEngine,
    metrics: getSerpMetrics()
  });
});

app.get('/debug/offers-status', (req, res) => {
  return res.json({
    webSearchEnabled: config.enableWebSearchOffers,
    serpapi: {
      enabled: serpEnabled(),
      apiKeySet: Boolean(config.serpApiApiKey),
      engine: config.serpApiEngine,
      metrics: getSerpMetrics()
    }
  });
});

app.get('/demo/bootstrap', async (req, res) => {
  const requested = normalizeEmail((req.query.email || '').toString());
  const email = requested || 'demo@omnicart.app';

  try {
    let user = await prisma.user.findUnique({
      where: { email },
      include: { addresses: true }
    });
    if (!user) {
      const name = email.split('@')[0].slice(0, 48) || 'OmniCart User';
      const created = await prisma.user.create({
        data: {
          name,
          email,
          preference: 'BALANCED',
          visaTestToken: 'visa_test_tok_4242',
          defaultPctDropThreshold: 15,
          shippingImprovementOn: false
        }
      });
      await prisma.address.create({
        data: {
          userId: created.id,
          name,
          line1: '450 Serra Mall',
          city: 'Stanford',
          state: 'CA',
          zip: '94305'
        }
      });
      user = await prisma.user.findUnique({
        where: { id: created.id },
        include: { addresses: true }
      });
    }
    if (!user) return respond500(res, req, 'Could not bootstrap user');

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        preference: user.preference,
        visaTestToken: user.visaTestToken,
        defaultPctDropThreshold: user.defaultPctDropThreshold,
        defaultTargetPriceCents: user.defaultTargetPriceCents,
        shippingImprovementOn: user.shippingImprovementOn
      },
      addresses: user.addresses
    });
  } catch (error) {
    console.error('bootstrap failed', error);
    return respond500(res, req, 'Could not load bootstrap profile', error);
  }
});

app.get('/users/:id/settings', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { addresses: true }
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        preference: user.preference,
        visaTestToken: user.visaTestToken,
        defaultPctDropThreshold: user.defaultPctDropThreshold,
        defaultTargetPriceCents: user.defaultTargetPriceCents,
        shippingImprovementOn: user.shippingImprovementOn
      },
      addresses: user.addresses
    });
  } catch (error) {
    console.error('settings fetch failed', error);
    return respond500(res, req, 'Could not fetch settings', error);
  }
});

app.put('/users/:id/settings', async (req, res) => {
  const {
    name,
    preference,
    visaTestToken,
    defaultPctDropThreshold,
    defaultTargetPriceCents,
    shippingImprovementOn
  } = req.body || {};

  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        ...(name ? { name: String(name) } : {}),
        ...(preference ? { preference: String(preference) } : {}),
        ...(visaTestToken !== undefined ? { visaTestToken: String(visaTestToken) || null } : {}),
        ...(defaultPctDropThreshold !== undefined
          ? { defaultPctDropThreshold: Number(defaultPctDropThreshold) || 15 }
          : {}),
        ...(defaultTargetPriceCents !== undefined
          ? { defaultTargetPriceCents: normalizeCents(defaultTargetPriceCents) }
          : {}),
        ...(shippingImprovementOn !== undefined ? { shippingImprovementOn: Boolean(shippingImprovementOn) } : {})
      },
      include: { addresses: true }
    });

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        preference: user.preference,
        visaTestToken: user.visaTestToken,
        defaultPctDropThreshold: user.defaultPctDropThreshold,
        defaultTargetPriceCents: user.defaultTargetPriceCents,
        shippingImprovementOn: user.shippingImprovementOn
      },
      addresses: user.addresses
    });
  } catch (error) {
    console.error('settings update failed', error);
    return respond500(res, req, 'Could not update settings', error);
  }
});

app.post('/users/:id/addresses', async (req, res) => {
  const { addressId, name, line1, city, state, zip } = req.body || {};
  if (!name || !line1 || !city || !state || !zip) {
    return res.status(400).json({ error: 'name, line1, city, state, zip are required' });
  }
  try {
    let address;
    if (addressId) {
      address = await prisma.address.update({
        where: { id: addressId },
        data: { name, line1, city, state, zip }
      });
    } else {
      address = await prisma.address.create({
        data: {
          userId: req.params.id,
          name,
          line1,
          city,
          state,
          zip
        }
      });
    }
    return res.json({ address });
  } catch (error) {
    console.error('address upsert failed', error);
    return respond500(res, req, 'Could not save address', error);
  }
});

app.post('/recognize', async (req, res) => {
  const { imageBase64, upc, textHints } = req.body || {};
  try {
    const result = await recognizeProduct({ imageBase64, upc, textHints });
    return res.json(result);
  } catch (error) {
    console.error('recognize failed', error);
    return respond500(res, req, 'Recognition failed', error);
  }
});

app.get('/products', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const take = Math.min(Number(req.query.limit || 20), 50);
  try {
    if (!q) return res.json({ products: [] });

    const needle = q.toLowerCase();
    const like = `%${needle.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    const products = await prisma.$queryRaw`
      SELECT id, title, brand, upc, imageUrl
      FROM Product
      WHERE lower(title) LIKE ${like} ESCAPE '\\'
         OR lower(brand) LIKE ${like} ESCAPE '\\'
         OR (upc IS NOT NULL AND upc LIKE ${like} ESCAPE '\\')
      ORDER BY title ASC
      LIMIT ${take}
    `;
    return res.json({ products });
  } catch (error) {
    console.error('products search failed', error);
    return respond500(res, req, 'Could not search products', error);
  }
});

app.get('/offers', async (req, res) => {
  const { productId, userId, strategy } = req.query;
  if (!productId) return res.status(400).json({ error: 'productId is required' });
  try {
    const bundle = await getRankedOffers({
      productId: String(productId),
      userId: userId ? String(userId) : undefined,
      strategy: strategy ? String(strategy) : 'BALANCED',
      refreshLive: true
    });
    return res.json(bundle);
  } catch (error) {
    console.error('offers failed', error);
    return respond500(res, req, 'Could not fetch offers', error);
  }
});

app.get('/offers/search', async (req, res) => {
  const { q, brand, userId, strategy, limit } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  try {
    const result = await searchOfferCandidates({
      query: String(q),
      brandHint: brand ? String(brand) : undefined,
      userId: String(userId),
      strategy: strategy ? String(strategy) : 'BALANCED',
      limit: limit ? Number(limit) : 8
    });
    return res.json(result);
  } catch (error) {
    console.error('offers search failed', error);
    return respond500(res, req, 'Could not search offers', error);
  }
});

app.post('/watchlist', async (req, res) => {
  const { userId, productId, preferredOfferId, alertRules = {} } = req.body || {};
  if (!userId || !productId) return res.status(400).json({ error: 'userId and productId are required' });

  try {
    const user = await prisma.user.findUnique({ where: { id: String(userId) } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const bestOfferBundle = await getRankedOffers({
      productId: String(productId),
      userId: String(userId),
      strategy: 'BEST_PRICE',
      refreshLive: true
    });
    const bestOffer = bestOfferBundle.offers[0] ? await ensureActionableOffer(bestOfferBundle.offers[0]) : null;

    let preferredOffer =
      preferredOfferId
        ? bestOfferBundle.offers.find((o) => o.id === String(preferredOfferId)) || null
        : null;
    if (preferredOffer) preferredOffer = await ensureActionableOffer(preferredOffer);

    const trackedOffer = preferredOffer || bestOffer;
    const resolvedPctDrop = Number(alertRules.pctDropThreshold ?? user.defaultPctDropThreshold ?? 15);
    const resolvedTarget =
      alertRules.targetPriceCents !== undefined && alertRules.targetPriceCents !== null
        ? Number(alertRules.targetPriceCents)
        : user.defaultTargetPriceCents;
    const resolvedShippingRule = Boolean(alertRules.shippingImprovementOn ?? user.shippingImprovementOn);

    const watchItem = await prisma.watchlist.upsert({
      where: {
        userId_productId: {
          userId: String(userId),
          productId: String(productId)
        }
      },
      update: {
        pctDropThreshold: resolvedPctDrop,
        targetPriceCents: resolvedTarget,
        shippingImprovementOn: resolvedShippingRule,
        ...(preferredOffer
          ? {
              preferredOfferId: preferredOffer.id,
              preferredVendorId: preferredOffer.vendorId,
              preferredVendorName: preferredOffer.vendorName,
              preferredProductUrl: preferredOffer.productUrl,
              lastSeenBestPriceCents: trackedOffer?.priceCents,
              lastSeenBestEtaDays: trackedOffer?.etaDays
            }
          : {})
      },
      create: {
        userId: String(userId),
        productId: String(productId),
        pctDropThreshold: resolvedPctDrop,
        targetPriceCents: resolvedTarget,
        shippingImprovementOn: resolvedShippingRule,
        preferredOfferId: preferredOffer?.id || null,
        preferredVendorId: preferredOffer?.vendorId || null,
        preferredVendorName: preferredOffer?.vendorName || null,
        preferredProductUrl: preferredOffer?.productUrl || null,
        lastSeenBestPriceCents: trackedOffer?.priceCents,
        lastSeenBestEtaDays: trackedOffer?.etaDays
      },
      include: { product: true }
    });

    const watchItemEnriched = {
      ...watchItem,
      bestOffer: trackedOffer || null,
      deltaPct: 0
    };

    void syncRemoteWatchlistFromLocal(String(userId));

    return res.json({ watchItem: watchItemEnriched });
  } catch (error) {
    console.error('watchlist create failed', error);
    return respond500(res, req, 'Could not update watchlist', error);
  }
});

app.get('/watchlist', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  try {
    // Downsync: pull canonical website watchlist into local DB (merge by default).
    if (sharedRemotePullEnabled()) {
      const user = await prisma.user.findUnique({ where: { id: String(userId) } });
      if (user?.email) {
        try {
          const remote = await fetchRemoteWatchlistItems({ email: user.email });
          if (remote?.ok && Array.isArray(remote.items)) {
            await applySharedWatchlistSync({
              email: user.email,
              items: remote.items,
              replace: Boolean(config.sharedRemoteWatchlistPullReplace)
            });
          }
        } catch (error) {
          console.warn('[SharedWatchlist:remote] pull failed', error?.message || error);
        }
      }
    }

    const items = await prisma.watchlist.findMany({
      where: { userId: String(userId) },
      include: { product: true },
      orderBy: { createdAt: 'desc' }
    });
    const enriched = await buildWatchlistItemsResponse(items, String(userId));
    return res.json({ items: enriched });
  } catch (error) {
    console.error('watchlist fetch failed', error);
    return respond500(res, req, 'Could not fetch watchlist', error);
  }
});

app.post('/watchlist/refresh', async (req, res) => {
  const userId = String(req.body?.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  try {
    const items = await prisma.watchlist.findMany({
      where: { userId },
      include: { product: true },
      orderBy: { createdAt: 'desc' }
    });

    await Promise.allSettled(
      items.map((item) =>
        getRankedOffers({
          productId: item.productId,
          userId,
          strategy: 'BEST_PRICE',
          refreshLive: true
        })
      )
    );

    const refreshed = await prisma.watchlist.findMany({
      where: { userId },
      include: { product: true },
      orderBy: { createdAt: 'desc' }
    });
    const enriched = await buildWatchlistItemsResponse(refreshed, userId);
    return res.json({ ok: true, refreshedCount: items.length, items: enriched });
  } catch (error) {
    console.error('watchlist refresh failed', error);
    return respond500(res, req, 'Could not refresh watchlist prices', error);
  }
});

app.delete('/watchlist/:id', async (req, res) => {
  try {
    const deleted = await prisma.watchlist.delete({ where: { id: String(req.params.id) } });
    if (deleted?.userId) void syncRemoteWatchlistFromLocal(deleted.userId);
    return res.json({ ok: true });
  } catch (error) {
    console.error('watchlist delete failed', error);
    return respond500(res, req, 'Could not delete watch item', error);
  }
});

app.post('/purchase', async (req, res) => {
  const { userId, productId, offerId, shippingAddressId, paymentMethodToken } = req.body || {};
  if (!userId || !productId || !offerId || !shippingAddressId || !paymentMethodToken) {
    return res.status(400).json({
      error: 'userId, productId, offerId, shippingAddressId, paymentMethodToken are required'
    });
  }

  try {
    const [user, product, offer, address] = await Promise.all([
      prisma.user.findUnique({ where: { id: String(userId) } }),
      prisma.product.findUnique({ where: { id: String(productId) } }),
      prisma.offer.findUnique({ where: { id: String(offerId) } }),
      prisma.address.findUnique({ where: { id: String(shippingAddressId) } })
    ]);
    if (!user || !product || !offer || !address) {
      return res.status(404).json({ error: 'User, product, offer, or address not found' });
    }

    const effectivePaymentToken =
      paymentMethodToken === '__USE_SAVED__' ? user.visaTestToken : paymentMethodToken;
    const amount = offer.priceCents + offer.shippingCents;
    const intent = await paymentService.createPaymentIntent(amount, 'USD', {
      userId,
      productId,
      offerId
    });
    const payment = await paymentService.confirmPayment(intent.paymentIntentId, effectivePaymentToken);

    const order = await prisma.order.create({
      data: {
        userId: String(userId),
        productId: String(productId),
        offerId: String(offerId),
        totalCents: amount,
        status: payment.status === 'CONFIRMED' ? 'CONFIRMED' : 'FAILED'
      }
    });

    return res.json({
      order,
      paymentStatus: payment.status,
      vendorUrl: offer.productUrl
    });
  } catch (error) {
    console.error('purchase failed', error);
    return respond500(res, req, 'Purchase failed', error);
  }
});

app.get('/orders', async (req, res) => {
  const userId = String(req.query.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  try {
    const orders = await prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });
    return res.json({ orders });
  } catch (error) {
    console.error('orders fetch failed', error);
    return respond500(res, req, 'Could not fetch orders', error);
  }
});

app.get('/notifications/pending', async (req, res) => {
  const userId = String(req.query.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  try {
    const notifications = await prisma.pendingNotification.findMany({
      where: { userId, deliveredAt: null },
      orderBy: { createdAt: 'asc' },
      take: 25
    });
    return res.json({ notifications });
  } catch (error) {
    console.error('notifications fetch failed', error);
    return respond500(res, req, 'Could not fetch notifications', error);
  }
});

app.post('/notifications/:id/ack', async (req, res) => {
  try {
    await prisma.pendingNotification.update({
      where: { id: String(req.params.id) },
      data: { deliveredAt: new Date() }
    });
    return res.json({ ok: true });
  } catch (error) {
    console.error('notification ack failed', error);
    return respond500(res, req, 'Could not ack notification', error);
  }
});

app.post('/simulate/priceTick', async (req, res) => {
  try {
    const result = await runPriceTick();
    return res.json(result);
  } catch (error) {
    console.error('price tick failed', error);
    return respond500(res, req, 'Price tick failed', error);
  }
});

app.post('/notifications/apns/send', async (req, res) => {
  // Production stub: in a real deployment, this would call APNs with device tokens.
  return res.json({ ok: true, stub: true });
});

app.post('/integrations/shared-watchlist/sync', async (req, res) => {
  const secret = String(config.sharedWatchlistWebhookSecret || '').trim();
  const incomingSecret = headerToken(req);
  if (secret && incomingSecret !== secret) {
    return res.status(403).json({ error: 'Invalid shared watchlist secret' });
  }

  const email = normalizeEmail(req.body?.email || req.query?.email);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const replace = req.body?.replace === undefined ? true : Boolean(req.body.replace);

  if (!email) return res.status(400).json({ error: 'email is required' });

  try {
    const result = await applySharedWatchlistSync({ email, items, replace });
    if (!result.ok) return res.status(400).json({ error: result.error || 'Could not sync shared watchlist' });
    return res.json(result);
  } catch (error) {
    console.error('shared watchlist sync failed', error);
    return respond500(res, req, 'Could not sync shared watchlist', error);
  }
});

app.get('/integrations/shared-watchlist/export', async (req, res) => {
  const secret = String(config.sharedWatchlistWebhookSecret || '').trim();
  const incomingSecret = headerToken(req);
  if (secret && incomingSecret !== secret) {
    return res.status(403).json({ error: 'Invalid shared watchlist secret' });
  }

  const email = normalizeEmail(req.query.email);
  if (!email) return res.status(400).json({ error: 'email is required' });

  try {
    const user = await ensureUserByEmail(email);
    if (!user) return res.status(400).json({ error: 'Invalid email' });

    const items = await prisma.watchlist.findMany({
      where: { userId: user.id },
      include: { product: true },
      orderBy: { createdAt: 'desc' }
    });
    const enriched = await buildWatchlistItemsResponse(items, user.id);
    return res.json({ ok: true, userId: user.id, email, items: enriched });
  } catch (error) {
    console.error('shared watchlist export failed', error);
    return respond500(res, req, 'Could not export watchlist', error);
  }
});

app.post('/integrations/extension/price-drop-webhook', async (req, res) => {
  const secret = String(config.extensionWebhookSecret || '').trim();
  const incomingSecret = headerToken(req);
  if (secret && incomingSecret !== secret) {
    return res.status(403).json({ error: 'Invalid webhook secret' });
  }

  const payload = req.body || {};
  const userId = String(payload.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  try {
    const watchlistId = String(payload.watchlistId || '').trim();
    const productId = String(payload.productId || '').trim();
    const item =
      (watchlistId
        ? await prisma.watchlist.findFirst({ where: { id: watchlistId, userId }, include: { product: true } })
        : null) ||
      (productId
        ? await prisma.watchlist.findFirst({ where: { userId, productId }, include: { product: true } })
        : null);
    if (!item) return res.status(404).json({ error: 'Watchlist item not found' });

    const newPriceCents = normalizeCents(payload.newPriceCents) ?? dollarsToCents(payload.price);
    const vendorName = String(payload.vendorName || payload.domain || 'Extension Deal').trim();
    const vendorToken = slugifyToken(vendorName, 'vendor');
    const source = slugifyToken(payload.source || 'extension', 'extension');
    const vendorId = `ext:${source}:${vendorToken}`;
    const productUrl = String(payload.productUrl || payload.url || '').trim() || 'https://example.com';

    let offer = null;
    if (newPriceCents) {
      offer = await prisma.offer.upsert({
        where: {
          productId_vendorId: {
            productId: item.productId,
            vendorId
          }
        },
        update: {
          vendorName,
          title: String(payload.title || item.product.title).trim(),
          priceCents: newPriceCents,
          shippingCents: normalizeCents(payload.shippingCents) ?? 0,
          etaDays: Math.max(1, Number(payload.etaDays) || 5),
          inStock: true,
          productUrl
        },
        create: {
          productId: item.productId,
          vendorId,
          vendorName,
          title: String(payload.title || item.product.title).trim(),
          priceCents: newPriceCents,
          shippingCents: normalizeCents(payload.shippingCents) ?? 0,
          etaDays: Math.max(1, Number(payload.etaDays) || 5),
          inStock: true,
          productUrl
        }
      });
    }

    const message = `Deal found: ${item.product.title} now $${((newPriceCents || 0) / 100).toFixed(2)} via ${vendorName}.`;
    const notification = await prisma.pendingNotification.create({
      data: {
        userId,
        productId: item.productId,
        type: 'EXTENSION_PRICE_DROP',
        message,
        payload: JSON.stringify({ watchlistId: item.id, productUrl, newPriceCents })
      }
    });

    return res.json({ ok: true, offer: offer ? normalizeOffer(offer) : null, notificationId: notification.id });
  } catch (error) {
    console.error('extension webhook failed', error);
    return respond500(res, req, 'Could not process extension webhook', error);
  }
});

// JSON parse errors / payload too large, etc.
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return respondError(res, req, 413, 'Payload too large (try reducing image size)', err);
  }
  if (err instanceof SyntaxError && String(err?.message || '').toLowerCase().includes('json')) {
    return respondError(res, req, 400, 'Invalid JSON', err);
  }
  console.error(`[${req?.requestId || 'no-reqid'}] unhandled error`, err);
  return respond500(res, req, 'Server error', err);
});

let server = null;
function startServer(attempt = 0) {
  const port = config.port;
  try {
    server = app.listen(port, () => {
      console.log(`OmniCart backend listening on http://localhost:${port}`);
    });
    server.on('error', (err) => {
      // Nodemon restarts can race with the old process releasing the port on macOS.
      if (err && err.code === 'EADDRINUSE' && attempt < 6) {
        const delay = 250 * Math.max(1, attempt + 1);
        console.warn(`Port ${port} in use; retrying in ${delay}ms...`);
        setTimeout(() => startServer(attempt + 1), delay);
        return;
      }
      console.error('Server listen failed', err);
      process.exit(1);
    });
  } catch (err) {
    console.error('Server start failed', err);
    process.exit(1);
  }
}

startServer();

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
  process.exit(1);
});
