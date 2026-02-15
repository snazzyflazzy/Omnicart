# OmniCart (TreeHacks Prototype)

Camera-first “window shopping -> instant online purchasing + deal watching”.

This repo currently contains a rebuilt backend in `backend/`.
The iOS app folder (`ios/`) is empty right now (it looks like it was deleted along with the old backend). If you want, I can regenerate the SwiftUI app project next.

## Backend Quickstart

```bash
cd backend
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:reset   # resets SQLite + seeds demo data
npm run dev
```

Verify:

```bash
curl -sS http://127.0.0.1:4000/health
```

## Useful Endpoints

- `GET /health`
- `POST /recognize` body: `{ "upc": "..." }` or `{ "imageBase64": "..." }`
- `GET /offers?productId=...&strategy=BALANCED|BEST_PRICE|FASTEST_SHIPPING`
- `POST /watchlist` body: `{ "userId": "...", "productId": "...", "alertRules": {...} }`
- `GET /watchlist?userId=...`
- `POST /purchase` body: `{ "userId": "...", "productId": "...", "offerId": "...", "shippingAddressId": "...", "paymentMethodToken": "visa_test_tok_4242" }`
- `GET /orders?userId=...`
- `POST /simulate/priceTick`

Debug:

- `GET /debug/ai-status`
- `GET /debug/ai-last`
- `GET /debug/serpapi-status`
- `GET /debug/offers-status`

## Shared Watchlist (Website Sync)

To sync watchlist items with your website service:

1. Set in `backend/.env`:
   - `ENABLE_SHARED_REMOTE_WATCHLIST_SYNC=true`
   - `SHARED_REMOTE_WATCHLIST_BASE_URL=https://<your-cloudflare-url>`
   - Optional downsync:
     - `ENABLE_SHARED_REMOTE_WATCHLIST_PULL=true`
     - `SHARED_REMOTE_WATCHLIST_PULL_PATH=/items`
2. Restart the backend.

