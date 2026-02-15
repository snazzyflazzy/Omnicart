const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Ensure `DATABASE_URL` is available when invoked via npm scripts.
// (Prisma CLI loads `.env` automatically, but our pre-step does not.)
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function databaseFilePath() {
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!url.startsWith('file:')) {
    throw new Error('DATABASE_URL must be a SQLite file: URL (e.g. file:./dev.db)');
  }
  const rawPath = url.slice('file:'.length);
  if (!rawPath) {
    throw new Error('DATABASE_URL is missing a path');
  }
  // SQLite file paths in Prisma are resolved relative to the schema directory (`./prisma`).
  if (rawPath.startsWith('/')) return rawPath;
  return path.resolve(__dirname, rawPath);
}

function main() {
  const filePath = databaseFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.closeSync(fs.openSync(filePath, 'a'));
  process.stdout.write(`touched ${filePath}\n`);
}

main();
