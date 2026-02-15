const { prisma } = require('../db');

function randomPercent(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

async function queueNotification({ userId, productId, message, type, payload }) {
  await prisma.pendingNotification.create({
    data: {
      userId,
      productId,
      message,
      type,
      payload: JSON.stringify(payload)
    }
  });
}

async function getBestOfferForProduct(productId) {
  const offers = await prisma.offer.findMany({
    where: { productId, inStock: true }
  });
  if (offers.length === 0) return null;
  return offers.reduce((best, next) => {
    if (!best) return next;
    const bestTotal = best.priceCents + best.shippingCents;
    const nextTotal = next.priceCents + next.shippingCents;
    if (nextTotal < bestTotal) return next;
    if (nextTotal === bestTotal && next.etaDays < best.etaDays) return next;
    return best;
  }, null);
}

async function runPriceTick() {
  const offers = await prisma.offer.findMany();
  const changedItems = [];

  for (const offer of offers) {
    const drift = randomPercent(-0.02, 0.02);
    const newPrice = clamp(Math.round(offer.priceCents * (1 + drift)), 50, 500000);
    const etaShift = Math.random() < 0.2 ? (Math.random() < 0.5 ? -1 : 1) : 0;
    const newEta = clamp(offer.etaDays + etaShift, 1, 10);

    await prisma.offer.update({
      where: { id: offer.id },
      data: {
        priceCents: newPrice,
        etaDays: newEta
      }
    });

    changedItems.push({
      offerId: offer.id,
      productId: offer.productId,
      oldPriceCents: offer.priceCents,
      newPriceCents: newPrice,
      oldEtaDays: offer.etaDays,
      newEtaDays: newEta
    });
  }

  const watchItems = await prisma.watchlist.findMany({
    include: { product: true }
  });

  const notifications = [];

  for (const item of watchItems) {
    const bestOffer = await getBestOfferForProduct(item.productId);
    if (!bestOffer) continue;

    const baseline = item.lastSeenBestPriceCents || bestOffer.priceCents;
    const dropPct = baseline > 0 ? ((baseline - bestOffer.priceCents) / baseline) * 100 : 0;
    const targetHit = item.targetPriceCents && bestOffer.priceCents <= item.targetPriceCents;
    const shippingImproved =
      item.shippingImprovementOn &&
      item.lastSeenBestEtaDays !== null &&
      item.lastSeenBestEtaDays !== undefined &&
      bestOffer.etaDays < item.lastSeenBestEtaDays;

    const shouldNotify = dropPct >= item.pctDropThreshold || !!targetHit || !!shippingImproved;
    if (!shouldNotify) continue;

    const priceText = `$${(bestOffer.priceCents / 100).toFixed(2)}`;
    const roundedDrop = Number(dropPct.toFixed(1));
    const dropLabel = roundedDrop > 0 ? `dropped ${roundedDrop}%` : 'has a new best offer';
    const message = `Deal found: ${item.product.title} ${dropLabel} to ${priceText}. Ships in ${bestOffer.etaDays} days.`;
    const payload = {
      watchlistId: item.id,
      productId: item.productId,
      bestOfferId: bestOffer.id,
      priceCents: bestOffer.priceCents,
      etaDays: bestOffer.etaDays,
      dropPct: roundedDrop
    };

    await queueNotification({
      userId: item.userId,
      productId: item.productId,
      message,
      type: 'DEAL_ALERT',
      payload
    });

    notifications.push({ watchlistId: item.id, message, payload });

    await prisma.watchlist.update({
      where: { id: item.id },
      data: {
        lastNotifiedAt: new Date(),
        lastSeenBestPriceCents: bestOffer.priceCents,
        lastSeenBestEtaDays: bestOffer.etaDays
      }
    });
  }

  return { changedItems, notifications };
}

module.exports = { runPriceTick };

