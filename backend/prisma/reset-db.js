const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Reset the SQLite DB file used by Prisma (dev/prototype only).
// This is useful if the DB file exists but has a schema that Prisma cannot alter.
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
  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    // ignore missing
  }
  fs.closeSync(fs.openSync(filePath, 'w'));
  process.stdout.write(`reset ${filePath}\n`);
}

main();

