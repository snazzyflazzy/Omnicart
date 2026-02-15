const { prisma } = require('../db');
const config = require('../config');
const mockCatalog = require('../data/mockCatalog.json');
const { lookupUpc } = require('./upcLookupService');
const { analyzeProductPhoto } = require('./aiVisionService');

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeUpc(value) {
  return String(value || '').replace(/\D/g, '');
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function overlapScore(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const setB = new Set(tokensB);
  let hits = 0;
  for (const t of tokensA) {
    if (setB.has(t)) hits += 1;
  }
  return hits / tokensA.length;
}

async function ensureProduct({ title, brand, upc, imageUrl }) {
  const cleanUpc = upc ? normalizeUpc(upc) : '';
  if (cleanUpc) {
    const existing = await prisma.product.findFirst({ where: { upc: cleanUpc } });
    if (existing) {
      // opportunistically fill imageUrl/brand/title if missing
      const shouldUpdate =
        (!existing.imageUrl && imageUrl) ||
        (existing.brand === 'Unknown' && brand) ||
        (existing.title !== title && title);
      if (!shouldUpdate) return existing;
      return prisma.product.update({
        where: { id: existing.id },
        data: {
          title: title || existing.title,
          brand: brand || existing.brand,
          imageUrl: imageUrl || existing.imageUrl
        }
      });
    }
  }

  // Dedupe by exact title+brand when UPC is unavailable.
  const cleanTitle = normalizeWhitespace(title);
  const cleanBrand = normalizeWhitespace(brand) || 'Unknown';
  if (!cleanTitle) return null;

  const byTitleBrand = await prisma.product.findFirst({
    where: { title: cleanTitle, brand: cleanBrand }
  });
  if (byTitleBrand) return byTitleBrand;

  return prisma.product.create({
    data: {
      title: cleanTitle,
      brand: cleanBrand,
      upc: cleanUpc || null,
      imageUrl: imageUrl ? String(imageUrl) : null
    }
  });
}

async function recognizeByUpc(upc) {
  const cleanUpc = normalizeUpc(upc);
  if (!cleanUpc) return null;

  const local = await prisma.product.findFirst({ where: { upc: cleanUpc } });
  if (local) {
    return {
      id: local.id,
      title: local.title,
      brand: local.brand,
      upc: local.upc,
      imageUrl: local.imageUrl,
      confidence: 1
    };
  }

  const mock = mockCatalog.find((p) => normalizeUpc(p.upc) === cleanUpc) || null;
  if (mock) {
    const created = await ensureProduct({
      title: mock.title,
      brand: mock.brand,
      upc: mock.upc,
      imageUrl: mock.imageUrl
    });
    if (!created) return null;
    return {
      id: created.id,
      title: created.title,
      brand: created.brand,
      upc: created.upc,
      imageUrl: created.imageUrl,
      confidence: 1
    };
  }

  const lookedUp = await lookupUpc(cleanUpc);
  if (lookedUp) {
    const created = await ensureProduct(lookedUp);
    if (!created) return null;
    return {
      id: created.id,
      title: created.title,
      brand: created.brand,
      upc: created.upc,
      imageUrl: created.imageUrl,
      confidence: 0.92
    };
  }

  return null;
}

async function recognizeByTextHints(textHints) {
  const hints = Array.isArray(textHints)
    ? textHints.map((t) => normalizeWhitespace(t)).filter(Boolean).slice(0, 25)
    : [];
  if (hints.length === 0) return null;

  const queryTokens = tokenize(hints.join(' '));
  if (queryTokens.length === 0) return null;

  const products = await prisma.product.findMany({ take: 80 });
  let best = null;
  let bestScore = 0;
  for (const p of products) {
    const score = overlapScore(queryTokens, tokenize(`${p.brand} ${p.title} ${p.upc || ''}`));
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }

  if (!best || bestScore < 0.35) return null;
  return {
    id: best.id,
    title: best.title,
    brand: best.brand,
    upc: best.upc,
    imageUrl: best.imageUrl,
    confidence: Number(bestScore.toFixed(2))
  };
}

async function recognizeByImage(imageBase64, textHints) {
  if (!config.enableAIRecognition || !imageBase64) return null;

  const ai = await analyzeProductPhoto({ imageBase64, ocrHints: textHints || [] });
  if (!ai?.ok) return null;
  const parsed = ai.parsedModelOutput;
  if (!parsed || typeof parsed !== 'object') return null;

  const title = normalizeWhitespace(parsed.title);
  const brand = normalizeWhitespace(parsed.brand) || 'Unknown';
  const upc = parsed.upc ? normalizeUpc(parsed.upc) : '';
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : null;

  if (upc) {
    const byUpc = await recognizeByUpc(upc);
    if (byUpc) {
      return {
        ...byUpc,
        confidence: confidence !== null ? confidence : byUpc.confidence
      };
    }
  }

  if (!title) return null;
  const created = await ensureProduct({ title, brand, upc: upc || null, imageUrl: null });
  if (!created) return null;

  return {
    id: created.id,
    title: created.title,
    brand: created.brand,
    upc: created.upc,
    imageUrl: created.imageUrl,
    confidence: confidence !== null ? confidence : 0.62
  };
}

async function recognizeProduct({ imageBase64, upc, textHints }) {
  const candidates = [];

  if (upc) {
    const byUpc = await recognizeByUpc(upc);
    if (byUpc) {
      return {
        recognizedProduct: byUpc,
        candidates: [byUpc],
        status: 'ok',
        visualHints: [],
        visualQuery: `${byUpc.brand} ${byUpc.title}`.trim()
      };
    }
  }

  const byText = await recognizeByTextHints(textHints);
  if (byText) candidates.push(byText);

  const byImage = await recognizeByImage(imageBase64, textHints);
  if (byImage) candidates.unshift(byImage);

  const recognizedProduct = candidates[0] || null;
  const visualHints = [];
  const visualQuery = recognizedProduct
    ? `${recognizedProduct.brand} ${recognizedProduct.title}`.trim()
    : '';

  return {
    recognizedProduct,
    candidates,
    status: recognizedProduct ? 'ok' : 'no_match',
    visualHints,
    visualQuery
  };
}

module.exports = { recognizeProduct };

