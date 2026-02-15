# OmniCart Backend

Node.js + Express + Prisma + SQLite backend for the OmniCart prototype.

## Run

```bash
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:reset
npm run dev
```

Health check:

```bash
curl -sS http://127.0.0.1:4000/health
```

## Notes

- SQLite DB file lives at `backend/prisma/dev.db` by default (`DATABASE_URL=file:./dev.db`).
- If you see Prisma errors about the DB file missing, `npm run prisma:push` will auto-create the file.
- `npm run prisma:reset` is the “make it work” button (wipes dev DB, pushes schema, reseeds).

