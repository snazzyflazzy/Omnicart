const { PrismaClient } = require('@prisma/client');
const catalog = require('../src/data/mockCatalog.json');
const vendors = require('../src/data/mockVendors.json');

const prisma = new PrismaClient();

function basePriceForTitle(title) {
  const lower = String(title || '').toLowerCase();
  if (lower.includes('sony wh-1000xm5')) return 32999;
  if (lower.includes('airpods')) return 24999;
  if (lower.includes('switch oled')) return 34999;
  if (lower.includes('dyson v15')) return 74999;
  if (lower.includes('stanley')) return 4500;
  if (lower.includes('pringles')) return 399;
  if (lower.includes('oreo')) return 409;
  return 19999;
}

async function main() {
  await prisma.pendingNotification.deleteMany();
  await prisma.order.deleteMany();
  await prisma.watchlist.deleteMany();
  await prisma.offer.deleteMany();
  await prisma.address.deleteMany();
  await prisma.product.deleteMany();
  await prisma.user.deleteMany();

  const user = await prisma.user.create({
    data: {
      name: 'TreeHacks Demo User',
      email: 'demo@omnicart.app',
      preference: 'BALANCED',
      visaTestToken: 'visa_test_tok_4242',
      defaultPctDropThreshold: 15,
      shippingImprovementOn: false
    }
  });

  const address = await prisma.address.create({
    data: {
      userId: user.id,
      name: 'Demo User',
      line1: '450 Serra Mall',
      city: 'Stanford',
      state: 'CA',
      zip: '94305'
    }
  });

  const createdProducts = [];

  for (const product of catalog) {
    const created = await prisma.product.create({
      data: {
        title: product.title,
        brand: product.brand,
        upc: product.upc || null,
        imageUrl: product.imageUrl || null
      }
    });

    createdProducts.push(created);

    const basePrice = basePriceForTitle(product.title);

    for (const vendor of vendors) {
      const price = Math.round(basePrice * vendor.priceMultiplier);
      const pseudoId = created.id.slice(-10).toUpperCase();
      await prisma.offer.create({
        data: {
          productId: created.id,
          vendorId: vendor.vendorId,
          vendorName: vendor.vendorName,
          title: created.title,
          priceCents: price,
          shippingCents: vendor.shippingCents,
          etaDays: vendor.etaDays,
          inStock: true,
          productUrl: `${vendor.baseUrl}${pseudoId}`
        }
      });
    }
  }

  console.log('Seed complete');
  console.log('Demo userId:', user.id);
  console.log('Demo addressId:', address.id);
  console.log('Products:', createdProducts.length);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
