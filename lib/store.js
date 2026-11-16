// Server-side JSON store. Data lives on the server, NOT in browser localStorage.
// When Supabase is configured, this same shape is mirrored to Postgres
// (see supabase/schema.sql). The local file is the fallback for local use/testing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INGREDIENTS, RECIPES } from './seed.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'db.json');

function defaultDb() {
  return {
    ingredients: JSON.parse(JSON.stringify(INGREDIENTS)),
    recipes: JSON.parse(JSON.stringify(RECIPES)),
    bakePlans: [], // {id, name, date, items, createdAt, status: 'planned'|'completed'}
    doughBatches: [], // {id, date, batchesMade, cookiesBakedNow, ballsFrozen, ballsAdded}
  };
}

function load() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) { console.error('Failed to load db, reseeding:', e.message); }
  const db = defaultDb();
  save(db);
  return db;
}

function save(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

export { load, save, defaultDb, DB_PATH };
