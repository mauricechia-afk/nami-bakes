// Nami Bakes — standalone server.
// Serves the frontend, a REST API, and a standard MCP server at /mcp.
// Data is stored server-side in data/db.json (local fallback).
// When Supabase is configured, the same tables live in Postgres —
// see supabase/schema.sql. The frontend uses Supabase directly when
// SUPABASE_URL / SUPABASE_ANON_KEY are set in the browser via
// public/config.js (generated at build/deploy time, never committed).
// No data is stored in browser localStorage.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { load, save } from './lib/store.js';
import { fmtQty, round3, round2, brownieEggs, planBake, makeCookieDough, shoppingList, costTotals, nextFriday, purchaseUnitsFor, convertPurchase } from './lib/calc.js';
import { syncOrders, requestShopifyToken } from './lib/shopify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.NAMI_API_KEY || ''; // if set, clients must send x-api-key
const PUBLIC_DIR = path.join(__dirname, 'public');

let db = load();
const persist = () => save(db);

// ---------- helpers ----------
function send(res, status, obj, type = 'application/json') {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, x-api-key, mcp-session-id, Mcp-Session-Id' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function requireKey(req, res) {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) { send(res, 401, { error: 'Missing or wrong x-api-key header' }); return false; }
  return true;
}
function slug(s) { return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

// ---------- business operations (shared by REST + MCP) ----------
const BUSINESS_ID = 'nami-bakes';
function logHistory(entry) {
  if (!Array.isArray(db.history)) db.history = [];
  const e = { id: `hist-${Date.now()}-${Math.floor(Math.random() * 1000)}`, at: new Date().toISOString(), businessId: BUSINESS_ID, undone: false, ...entry };
  db.history.push(e);
  if (db.history.length > 500) db.history = db.history.slice(-500);
  return e;
}
function undoHistory(id) {
  const e = (db.history || []).find(x => x.id === id);
  if (!e) throw new Error('History entry not found');
  if (e.undone) throw new Error('This change was already undone');
  if (e.type === 'inventory' || e.type === 'restock') {
    const ing = db.ingredients.find(i => i.id === e.ingredientId);
    if (!ing) throw new Error('Ingredient not found');
    ing.current = round3(e.before);
    if (e.type === 'restock' && e.lastPriceBefore !== undefined) { ing.lastPrice = e.lastPriceBefore; }
  } else if (e.type === 'bake-complete') {
    // A group bake stores planIds; a single bake stores planId.
    const ids = e.planIds && e.planIds.length ? e.planIds : [e.planId];
    const plans = ids.map(id => db.bakePlans.find(p => p.id === id));
    if (plans.some(p => !p)) throw new Error('Bake plan not found');
    if (plans.some(p => p.status !== 'completed')) throw new Error('Bake plan is not completed');
    for (const t of e.deducted || []) {
      const ing = db.ingredients.find(i => i.id === t.ingredientId);
      if (ing) ing.current = round3(ing.current + t.qty);
    }
    if (e.ballsAdded) {
      const balls = db.ingredients.find(i => i.id === 'cookie-dough-balls');
      if (balls) balls.current = round3(balls.current - e.ballsAdded);
    }
    for (const plan of plans) {
      plan.status = 'planned';
      delete plan.completedAt;
      delete plan.cost;
    }
  } else {
    throw new Error('This change cannot be undone');
  }
  e.undone = true;
  persist();
  return e;
}
function validateRecipeIngredients(ingredients) {
  if (!Array.isArray(ingredients)) throw new Error('Recipe ingredients must be a list');
  for (const ing of ingredients) {
    if (!ing.ingredientId) throw new Error('Every recipe ingredient needs an ingredient from Inventory');
    if (!db.ingredients.some(i => i.id === ing.ingredientId)) {
      throw new Error(`Unknown ingredient "${ing.ingredientId}" — add it to Inventory first, then add it to the recipe.`);
    }
    if (!Number.isFinite(Number(ing.qty)) || Number(ing.qty) <= 0) {
      throw new Error(`Ingredient "${ing.ingredientId}" needs a quantity more than 0`);
    }
  }
}
function doPlan(items, dough) {
  const calc = planBake(items, db.recipes, db.ingredients, dough);
  const ingredientById = Object.fromEntries(db.ingredients.map(i => [i.id, i]));
  const costs = costTotals(calc.totals, ingredientById);
  let totalSell = 0;
  for (const item of items) {
    const r = db.recipes.find(x => x.id === item.recipeId);
    if (r && Number.isFinite(Number(r.sellPrice))) totalSell = round2(totalSell + Number(item.qty) * Number(r.sellPrice));
  }
  return { ...calc, costs: costs.costs, totalCost: costs.totalCost, missingPrices: costs.missingPrices, totalSell, margin: round2(totalSell - costs.totalCost) };
}
function doCompleteBake(planId) {
  const plan = db.bakePlans.find(p => p.id === planId);
  if (!plan) throw new Error('Bake plan not found');
  if (plan.status === 'completed') throw new Error('Bake plan already completed');
  const calc = doPlan(plan.items, plan.dough);
  if (calc.insufficient.length) {
    throw new Error('Not enough stock: ' + calc.insufficient.map(i => `${i.name} needs ${fmtQty(i.qty)} ${i.unit}, have ${fmtQty(i.have)}`).join('; '));
  }
  for (const t of calc.totals) {
    const ing = db.ingredients.find(i => i.id === t.ingredientId);
    if (ing) ing.current = round3(ing.current - t.qty);
  }
  if (calc.ballsAdded > 0) {
    const balls = db.ingredients.find(i => i.id === 'cookie-dough-balls');
    if (balls) balls.current = round3(balls.current + calc.ballsAdded);
  }
  plan.status = 'completed';
  plan.completedAt = new Date().toISOString();
  plan.cost = { totalCost: calc.totalCost, totalSell: calc.totalSell, margin: calc.margin, costs: calc.costs };
  const entry = logHistory({ type: 'bake-complete', planId: plan.id, name: plan.name, deducted: calc.totals, ballsAdded: calc.ballsAdded || 0, cost: plan.cost });
  persist();
  return { plan, deducted: calc.totals, ballsAdded: calc.ballsAdded || 0, historyId: entry.id };
}
// ---------- Batch baking: bake several plans together ----------
// Combine the items of several planned plans and calculate once, so the
// maths matches baking in one go: 2 brookies are 1 brownie portion (3
// eggs), not 2 separate halves (2 + 2 eggs). Dough is worked out again
// from the combined total, never by adding up the per-plan numbers, or
// two 1-brookie plans would each make a batch. The minimum is 1 full
// batch whenever any dough is needed. A dough-only plan in the selection
// adds its batches on top. A manual dough number on the session card
// overrides all of this.
function sessionCalc(planIds, doughBatchesMade) {
  if (!Array.isArray(planIds) || !planIds.length) throw new Error('Select at least one bake plan');
  const plans = planIds.map(id => db.bakePlans.find(p => p.id === id));
  if (plans.some(p => !p)) throw new Error('Bake plan not found');
  if (plans.some(p => p.status !== 'planned')) throw new Error('Only planned bake plans can be baked together. One of the selected plans is already completed.');
  const items = [];
  for (const p of plans) {
    for (const i of p.items || []) {
      const ex = items.find(x => x.recipeId === i.recipeId);
      if (ex) ex.qty += i.qty; else items.push({ recipeId: i.recipeId, qty: i.qty });
    }
  }
  let batches;
  if (Number.isFinite(Number(doughBatchesMade))) {
    batches = Number(doughBatchesMade);
  } else {
    // Auto now returns whole batches (see planBake), so this is the
    // combined whole-batch number. Dough-only plans add their batches.
    const auto = doPlan(items, undefined).doughBatchesMade || 0;
    const doughOnlyExtra = plans
      .filter(p => !(p.items || []).length && p.dough && Number.isFinite(Number(p.dough.batchesMade)))
      .reduce((s, p) => s + Number(p.dough.batchesMade), 0);
    batches = auto + doughOnlyExtra;
  }
  const calc = doPlan(items, batches > 0 ? { batchesMade: batches } : undefined);
  return { plans, items, doughBatchesMade: batches, calc };
}
function doCompleteSession(planIds, doughBatchesMade) {
  const { plans, calc } = sessionCalc(planIds, doughBatchesMade);
  if (calc.insufficient.length) {
    throw new Error('Not enough stock: ' + calc.insufficient.map(i => `${i.name} needs ${fmtQty(i.qty)} ${i.unit}, have ${fmtQty(i.have)}`).join('; '));
  }
  for (const t of calc.totals) {
    const ing = db.ingredients.find(i => i.id === t.ingredientId);
    if (ing) ing.current = round3(ing.current - t.qty);
  }
  if (calc.ballsAdded > 0) {
    const balls = db.ingredients.find(i => i.id === 'cookie-dough-balls');
    if (balls) balls.current = round3(balls.current + calc.ballsAdded);
  }
  const now = new Date().toISOString();
  // The combined cost belongs to the bake as a whole, so it lives on the
  // History entry, not split across the plans. Splitting it would make
  // each plan look like it cost the whole bake.
  const cost = { totalCost: calc.totalCost, totalSell: calc.totalSell, margin: calc.margin, costs: calc.costs };
  for (const plan of plans) {
    plan.status = 'completed';
    plan.completedAt = now;
  }
  const entry = logHistory({ type: 'bake-complete', planIds: plans.map(p => p.id), name: plans.map(p => p.name).join(', '), deducted: calc.totals, ballsAdded: calc.ballsAdded || 0, cost });
  persist();
  return { plans, deducted: calc.totals, ballsAdded: calc.ballsAdded || 0, historyId: entry.id };
}
function historySummary() {
  const bakes = (db.history || []).filter(e => e.type === 'bake-complete' && !e.undone && e.cost);
  const totalCost = round2(bakes.reduce((s, e) => s + (e.cost.totalCost || 0), 0));
  const totalSell = round2(bakes.reduce((s, e) => s + (e.cost.totalSell || 0), 0));
  const totalMargin = round2(totalSell - totalCost);
  return {
    bakes: bakes.length,
    totalCost, totalSell, totalMargin,
    averageCost: bakes.length ? round2(totalCost / bakes.length) : 0,
    averageSell: bakes.length ? round2(totalSell / bakes.length) : 0,
    averageMargin: bakes.length ? round2(totalMargin / bakes.length) : 0,
  };
}
function doMakeDough(input) {
  const result = makeCookieDough(input, db.recipes, db.ingredients);
  for (const d of result.deducted) {
    const ing = db.ingredients.find(i => i.id === d.ingredientId);
    if (!ing) throw new Error(`Ingredient not found: ${d.name}`);
    if (ing.current < d.qty - 1e-9) throw new Error(`Not enough ${d.name}: need ${fmtQty(d.qty)} ${d.unit}, have ${fmtQty(ing.current)}`);
  }
  for (const d of result.deducted) {
    const ing = db.ingredients.find(i => i.id === d.ingredientId);
    ing.current = round3(ing.current - d.qty);
  }
  const balls = db.ingredients.find(i => i.id === 'cookie-dough-balls');
  if (balls) balls.current = round3(balls.current + result.ballsAdded);
  db.doughBatches.push({ id: `dough-${Date.now()}`, date: new Date().toISOString().slice(0, 10), ...input, ballsAdded: result.ballsAdded });
  persist();
  return result;
}
function doShoppingList() {
  const plannedTotals = [];
  const plansWithDates = [];
  for (const plan of db.bakePlans.filter(p => p.status === 'planned')) {
    const calc = doPlan(plan.items, plan.dough);
    plansWithDates.push({ date: plan.date, totals: calc.totals });
    for (const t of calc.totals) {
      const ex = plannedTotals.find(x => x.ingredientId === t.ingredientId);
      if (ex) ex.qty = round3(ex.qty + t.qty); else plannedTotals.push({ ...t });
    }
  }
  const items = shoppingList(db.ingredients, plannedTotals, plansWithDates).map(i => ({
    ...i,
    purchaseUnits: purchaseUnitsFor(i.ingredientId, i.unit),
  }));
  return { nextFriday: nextFriday(), items, plannedTotals };
}
// Restock one shopping item: enter the amount bought in any purchase unit,
// convert it to the inventory unit, and add it to stock. One item at a time.
// Optional price (SGD paid in total) records the latest price per stock unit.
function doRestock(ingredientId, amount, unit, price) {
  const ing = db.ingredients.find(i => i.id === ingredientId);
  if (!ing) throw new Error(`Ingredient not found: ${ingredientId}`);
  const added = convertPurchase(ingredientId, amount, unit);
  const before = ing.current;
  const lastPriceBefore = ing.lastPrice === undefined ? null : ing.lastPrice;
  ing.current = round3(ing.current + added);
  let unitPrice = null;
  if (price !== undefined && price !== null && price !== '') {
    const p = Number(price);
    if (!Number.isFinite(p) || p < 0) throw new Error('Price must be 0 or more');
    unitPrice = round2(p / added);
    ing.lastPrice = unitPrice;
    ing.lastPriceAt = new Date().toISOString().slice(0, 10);
    if (!Array.isArray(ing.priceHistory)) ing.priceHistory = [];
    ing.priceHistory.push({ at: ing.lastPriceAt, amount: Number(amount), unit, added, price: p, unitPrice });
  }
  const entry = logHistory({ type: 'restock', ingredientId, name: ing.name, before, after: ing.current, added, unit: ing.unit, price: price === undefined ? null : Number(price), unitPrice, lastPriceBefore });
  persist();
  return { ingredientId, name: ing.name, unit: ing.unit, boughtAmount: Number(amount), boughtUnit: unit, added, before, after: ing.current, unitPrice, historyId: entry.id };
}

// ---------- Shopify sync ----------
// Pulls orders from the Shopify Admin API every hour and turns them into
// bake plans. See lib/shopify.js for the mapping. The store domain and
// access token come from Railway variables (SHOPIFY_STORE_DOMAIN and
// SHOPIFY_ACCESS_TOKEN), never from the code or the repo.
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || ''; // legacy shpat_ token, if one already exists
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const SHOPIFY_VERSION = process.env.SHOPIFY_API_VERSION || '2025-10';
function shopifyConfigured() { return Boolean(SHOPIFY_DOMAIN && (SHOPIFY_TOKEN || (SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET))); }
// Cached Dev Dashboard token. It expires after 24 hours, so it is
// refreshed when less than 5 minutes remain, or after a 401.
let shopifyTokenCache = null;
async function getShopifyToken() {
  if (SHOPIFY_TOKEN) return SHOPIFY_TOKEN;
  if (shopifyTokenCache && shopifyTokenCache.expiresAt > Date.now() + 5 * 60 * 1000) return shopifyTokenCache.token;
  const { token, expiresIn } = await requestShopifyToken(SHOPIFY_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET);
  shopifyTokenCache = { token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
}
async function fetchShopifyOrders() {
  if (!shopifyConfigured()) throw new Error('Shopify is not connected. Set SHOPIFY_STORE_DOMAIN plus SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in Railway variables (from the app in the Shopify Dev Dashboard). A legacy SHOPIFY_ACCESS_TOKEN also works if you already have one.');
  const fields = 'id,name,created_at,cancelled_at,financial_status,fulfillment_status,note_attributes,line_items,customer';
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_VERSION}/orders.json?status=any&limit=250&fields=${fields}`;
  const call = async () => {
    const token = await getShopifyToken();
    return fetch(url, { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } });
  };
  let res = await call();
  if (res.status === 401 && !SHOPIFY_TOKEN) {
    // Token may have expired early. Drop the cache and try once with a fresh one.
    shopifyTokenCache = null;
    res = await call();
  }
  if (!res.ok) throw new Error(`Shopify returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.orders || [];
}
async function doShopifySync({ dryRun = false, orders = null } = {}) {
  const list = orders || await fetchShopifyOrders();
  const balls = db.ingredients.find(i => i.id === 'cookie-dough-balls');
  const result = syncOrders(list, db.bakePlans, balls ? balls.current : 0);
  if (!dryRun) {
    for (const p of result.remove) db.bakePlans = db.bakePlans.filter(x => x.id !== p);
    for (const u of result.update) {
      const ex = db.bakePlans.find(x => x.id === u.id);
      if (ex) { ex.name = u.name; ex.date = u.date; ex.items = u.items; ex.dough = u.dough; }
    }
    for (const p of result.create) {
      db.bakePlans.push({ businessId: BUSINESS_ID, id: `plan-shopify-${p.shopifyOrderId}`, name: p.name, date: p.date, items: p.items, dough: p.dough, status: 'planned', createdAt: new Date().toISOString(), shopifyOrderId: p.shopifyOrderId, shopifyOrderName: p.shopifyOrderName });
    }
    db.shopifyFlags = result.flags.map(f => ({ ...f, at: new Date().toISOString() }));
    db.shopifySync = { lastRun: new Date().toISOString(), lastResult: { created: result.create.length, updated: result.update.length, removed: result.remove.length, flagged: result.flags.length, skipped: result.skipped.length }, lastError: null, configured: shopifyConfigured() };
    persist();
  }
  return { ...result, dryRun, ordersChecked: list.length };
}
// Hourly pull, only when Shopify is connected. Errors are recorded on the
// status, never thrown, so a failed pull does not crash the server.
setInterval(async () => {
  if (!shopifyConfigured()) return;
  try { await doShopifySync(); console.log('Shopify sync ran', db.shopifySync.lastResult); }
  catch (e) { console.error('Shopify sync failed:', e.message); db.shopifySync = { lastRun: new Date().toISOString(), lastResult: null, lastError: e.message, configured: true }; persist(); }
}, 60 * 60 * 1000);

// ---------- MCP server ----------
function createMcpServer() {
  const server = new McpServer({ name: 'nami-bakes', version: '1.0.0' });
  const itemShape = { recipeId: z.string(), qty: z.number() };

  server.tool('list_inventory', 'List all ingredients with current and minimum stock.', {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(db.ingredients.map(i => ({ ...i, currentDisplay: fmtQty(i.current) }))) }] }));
  server.tool('get_ingredient', 'Get one ingredient by id or name.', { query: z.string() },
    async ({ query }) => {
      const ing = db.ingredients.find(i => i.id === query || i.id === slug(query) || i.name.toLowerCase() === query.toLowerCase());
      if (!ing) throw new Error(`Ingredient not found: ${query}`);
      return { content: [{ type: 'text', text: JSON.stringify(ing) }] };
    });
  server.tool('adjust_inventory', 'Adjust an ingredient quantity or minimum. Set current and/or min.', { id: z.string(), current: z.number().optional(), min: z.number().optional() },
    async ({ id, current, min }) => {
      const ing = db.ingredients.find(i => i.id === id);
      if (!ing) throw new Error(`Ingredient not found: ${id}`);
      if (current !== undefined) ing.current = round3(current);
      if (min !== undefined) ing.min = round3(min);
      persist();
      return { content: [{ type: 'text', text: JSON.stringify(ing) }] };
    });
  server.tool('add_ingredient', 'Add a new ingredient.', { name: z.string(), unit: z.string(), current: z.number(), min: z.number() },
    async ({ name, unit, current, min }) => {
      const ing = { businessId: BUSINESS_ID, id: slug(name), name, unit, current: round3(current), min: round3(min) };
      if (db.ingredients.some(i => i.id === ing.id)) throw new Error('Ingredient already exists');
      db.ingredients.push(ing); persist();
      return { content: [{ type: 'text', text: JSON.stringify(ing) }] };
    });
  server.tool('list_history', 'List stock change history, newest first. Each entry can be undone.', {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify([...(db.history || [])].reverse()) }] }));
  server.tool('undo_history', 'Undo a stock change history entry: restores stock, or un-completes a bake plan.', { id: z.string() },
    async ({ id }) => ({ content: [{ type: 'text', text: JSON.stringify(undoHistory(id)) }] }));
  server.tool('list_recipes', 'List all recipes with per-portion ingredients.', {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(db.recipes) }] }));
  server.tool('get_recipe', 'Get one recipe by id or name.', { query: z.string() },
    async ({ query }) => {
      const r = db.recipes.find(x => x.id === query || x.id === slug(query) || x.name.toLowerCase() === query.toLowerCase());
      if (!r) throw new Error(`Recipe not found: ${query}`);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    });
  server.tool('create_recipe', 'Create a recipe. ingredients: [{ingredientId, qty, unit}] per portion. Every ingredientId must already exist in Inventory — add a new ingredient to Inventory first.', {
    name: z.string(), description: z.string().optional(), ingredients: z.array(z.object({ ingredientId: z.string(), qty: z.number(), unit: z.string() })),
  }, async ({ name, description, ingredients }) => {
    validateRecipeIngredients(ingredients);
    const r = { businessId: BUSINESS_ID, id: slug(name), name, kind: 'base', description: description || '', yields: 1, yieldUnit: 'portions', packSize: 1, ingredients };
    db.recipes.push(r); persist();
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
  });
  server.tool('plan_bake', 'Plan finished items and get aggregated sub-recipes. items: [{recipeId, qty}] e.g. [{recipeId:"brookie",qty:2},{recipeId:"brownies",qty:1}] = 1 cookie + 2 brownie portions. Brownie eggs: 3 per whole portion + 2 for a 0.5 remainder. Optional doughBatchesMade: whole batches of cookie dough to make in this plan; dough used for brookies is taken from it and the rest becomes frozen balls, e.g. 1 brookie with doughBatchesMade 2 freezes 18 balls.', { items: z.array(z.object(itemShape)), doughBatchesMade: z.number().optional() },
    async ({ items, doughBatchesMade }) => ({ content: [{ type: 'text', text: JSON.stringify(doPlan(items, doughBatchesMade === undefined ? undefined : { batchesMade: doughBatchesMade })) }] }));
  server.tool('get_bake_plan', 'Get a saved bake plan by id.', { id: z.string() },
    async ({ id }) => {
      const p = db.bakePlans.find(x => x.id === id);
      if (!p) throw new Error('Bake plan not found');
      return { content: [{ type: 'text', text: JSON.stringify({ ...p, calculation: doPlan(p.items, p.dough) }) }] };
    });
  server.tool('complete_bake_session', 'Bake several planned bake plans together: combine their items, calculate once, deduct once, mark all completed.', { planIds: z.array(z.string()).min(1), doughBatchesMade: z.number().optional() },
    async ({ planIds, doughBatchesMade }) => ({ content: [{ type: 'text', text: JSON.stringify(doCompleteSession(planIds, doughBatchesMade)) }] }));
  server.tool('complete_bake', 'Complete a saved bake plan: deducts aggregated ingredients from inventory.', { id: z.string() },
    async ({ id }) => ({ content: [{ type: 'text', text: JSON.stringify(doCompleteBake(id)) }] }));
  server.tool('update_bake_plan', 'Edit a saved bake plan that is still planned (completed plans cannot be edited, their stock is already deducted). Change name, date, items and/or doughBatchesMade.', { id: z.string(), name: z.string().optional(), date: z.string().optional(), items: z.array(z.object(itemShape)).optional(), doughBatchesMade: z.number().optional() },
    async ({ id, name, date, items, doughBatchesMade }) => {
      const p = db.bakePlans.find(x => x.id === id);
      if (!p) throw new Error('Bake plan not found');
      if (p.status !== 'planned') throw new Error('Only a planned bake plan can be edited. This one is already completed.');
      const newItems = items !== undefined ? items : p.items;
      const newDough = doughBatchesMade !== undefined ? { batchesMade: doughBatchesMade } : p.dough;
      const calc = doPlan(newItems, newDough); // validate before changing anything
      if (name !== undefined) p.name = name;
      if (date !== undefined) p.date = date;
      p.items = newItems;
      p.dough = newDough;
      persist();
      return { content: [{ type: 'text', text: JSON.stringify({ ...p, calculation: calc }) }] };
    });
  server.tool('delete_bake_plan', 'Delete a saved bake plan. Deleting a planned plan deducts nothing. Deleting a completed plan does not put the ingredients back.', { id: z.string() },
    async ({ id }) => {
      const p = db.bakePlans.find(x => x.id === id);
      if (!p) throw new Error('Bake plan not found');
      db.bakePlans = db.bakePlans.filter(x => x.id !== id); persist();
      return { content: [{ type: 'text', text: JSON.stringify({ deleted: id }) }] };
    });
  server.tool('shopify_sync', 'Pull Shopify orders and turn them into bake plans. dryRun true previews without changing anything.', { dryRun: z.boolean().optional() },
    async ({ dryRun }) => ({ content: [{ type: 'text', text: JSON.stringify(await doShopifySync({ dryRun: dryRun === true })) }] }));
  server.tool('shopify_status', 'Last Shopify sync: when it ran, what it created, updated, removed and flagged, and any error.', {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(db.shopifySync || { configured: shopifyConfigured() }) }] }));
  server.tool('get_shopping_list', 'Friday shopping list: below-min items plus projected need from planned bakes.', {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(doShoppingList()) }] }));
  server.tool('get_restock_forecast', 'Alias for get_shopping_list: weekly restock forecast for the Friday shop.', {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(doShoppingList()) }] }));
  server.tool('restock_ingredient', 'Restock one ingredient from the shopping list: enter the amount bought in any purchase unit and it is converted to the inventory unit and added to stock. E.g. instant coffee 200 g = 125 tsp (1 tsp = 1.6 g, BONCAFE, weighed), flour 1 kg = 1000 g, white sugar 1 bag = 3000 g, chocolate 1 bag = 2500 g, eggs 1 tray = 10 eggs. Optional price is the total SGD paid, which records the latest price per stock unit for bake cost tracking.', { id: z.string(), amount: z.number(), unit: z.string(), price: z.number().optional() },
    async ({ id, amount, unit, price }) => ({ content: [{ type: 'text', text: JSON.stringify(doRestock(id, amount, unit, price)) }] }));
  server.tool('make_cookie_dough', 'Make cookie dough: 1 batch = 12 balls (usually 13, count as 12). Deduct the recipe once per batch, bake some cookies now, freeze the rest as balls. batchesMade (usually 1), cookiesBakedNow (0-12 per batch); balls frozen = batchesMade*12 - cookiesBakedNow. Legacy fields portionsMade / portionsBakedNow / portionsFrozen (in batches) are also accepted.', {
    batchesMade: z.number().optional(), cookiesBakedNow: z.number().optional(),
    portionsMade: z.number().optional(), portionsBakedNow: z.number().optional(), portionsFrozen: z.number().optional(),
  }, async (input) => ({ content: [{ type: 'text', text: JSON.stringify(doMakeDough(input)) }] }));
  return server;
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, x-api-key, mcp-session-id, Mcp-Session-Id', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' }); return res.end(); }

    // MCP — Streamable HTTP (standard MCP protocol, any MCP client)
    if (pathname === '/mcp') {
      if (API_KEY && req.headers['x-api-key'] !== API_KEY) return send(res, 401, { error: 'Missing or wrong x-api-key header' });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => transport.close());
      const mcp = createMcpServer();
      await mcp.connect(transport);
      await transport.handleRequest(req, res, await readBody(req).catch(() => ({})));
      return;
    }

    // REST API
    if (pathname.startsWith('/api/')) {
      if (req.method === 'GET' && pathname === '/api/health') return send(res, 200, { ok: true, app: 'nami-bakes', version: '1.0.0' });
      // When a shared password is set (NAMI_API_KEY), every API route needs
      // it, including reads. The frontend sends it once the user unlocks.
      if (API_KEY && req.headers['x-api-key'] !== API_KEY) return send(res, 401, { error: 'Locked. Enter the shared password to unlock.' });
      if (req.method === 'GET' && pathname === '/api/shopify/status') return send(res, 200, db.shopifySync || { configured: shopifyConfigured(), lastRun: null, lastResult: null, lastError: null });
      if (req.method === 'GET' && pathname === '/api/shopify/flags') return send(res, 200, db.shopifyFlags || []);
      if (req.method === 'GET' && pathname === '/api/shopify/preview') {
        try { return send(res, 200, await doShopifySync({ dryRun: true })); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (req.method === 'POST' && pathname === '/api/shopify/sync') {
        try { return send(res, 200, await doShopifySync({})); }
        catch (e) {
          db.shopifySync = { lastRun: new Date().toISOString(), lastResult: null, lastError: e.message, configured: shopifyConfigured() };
          persist();
          return send(res, 400, { error: e.message });
        }
      }
      if (req.method === 'GET' && pathname === '/api/backup') return send(res, 200, db);
      if (req.method === 'POST' && pathname === '/api/backup') {
        const b = await readBody(req);
        if (!Array.isArray(b.ingredients) || !Array.isArray(b.recipes) || !Array.isArray(b.bakePlans)) {
          return send(res, 400, { error: 'Backup file is not a valid Mise en Place backup. It must contain ingredients, recipes and bake plans.' });
        }
        db.ingredients = b.ingredients;
        db.recipes = b.recipes;
        db.bakePlans = b.bakePlans;
        if (Array.isArray(b.history)) db.history = b.history;
        if (Array.isArray(b.doughBatches)) db.doughBatches = b.doughBatches;
        persist();
        return send(res, 200, { ok: true, ingredients: db.ingredients.length, recipes: db.recipes.length, bakePlans: db.bakePlans.length });
      }
      if (req.method === 'GET' && pathname === '/api/inventory') return send(res, 200, db.ingredients);
      if (req.method === 'POST' && pathname === '/api/inventory') {
        if (!requireKey(req, res)) return;
        const b = await readBody(req);
        const ing = { businessId: BUSINESS_ID, id: slug(b.name), name: b.name, unit: b.unit, current: round3(b.current), min: round3(b.min) };
        if (db.ingredients.some(i => i.id === ing.id)) return send(res, 400, { error: 'Ingredient already exists' });
        db.ingredients.push(ing); persist(); return send(res, 201, ing);
      }
      if (req.method === 'GET' && pathname === '/api/history') return send(res, 200, [...(db.history || [])].reverse());
      if (req.method === 'GET' && pathname === '/api/history/summary') return send(res, 200, historySummary());
      if (req.method === 'POST' && pathname === '/api/bake-sessions/preview') {
        try { const b = await readBody(req); return send(res, 200, sessionCalc(b.planIds, b.doughBatchesMade)); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (req.method === 'POST' && pathname === '/api/bake-sessions/complete') {
        try { const b = await readBody(req); return send(res, 200, doCompleteSession(b.planIds, b.doughBatchesMade)); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      const historyMatch = pathname.match(/^\/api\/history\/([\w-]+)\/undo$/);
      if (historyMatch && req.method === 'POST') {
        if (!requireKey(req, res)) return;
        try { return send(res, 200, undoHistory(historyMatch[1])); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      const invMatch = pathname.match(/^\/api\/inventory\/([\w-]+)$/);
      if (invMatch) {
        const ing = db.ingredients.find(i => i.id === invMatch[1]);
        if (!ing) return send(res, 404, { error: 'Ingredient not found' });
        if (req.method === 'PATCH') {
          if (!requireKey(req, res)) return;
          const b = await readBody(req);
          const before = ing.current;
          if (b.current !== undefined) ing.current = round3(b.current);
          if (b.min !== undefined) ing.min = round3(b.min);
          if (b.name) ing.name = b.name;
          if (b.unit) ing.unit = b.unit;
          if (b.lastPrice !== undefined) ing.lastPrice = Number(b.lastPrice);
          if (b.current !== undefined && ing.current !== before) {
            logHistory({ type: 'inventory', ingredientId: ing.id, name: ing.name, before, after: ing.current, note: 'Manual stock adjustment' });
          }
          persist(); return send(res, 200, ing);
        }
        if (req.method === 'DELETE') {
          if (!requireKey(req, res)) return;
          db.ingredients = db.ingredients.filter(i => i.id !== ing.id); persist(); return send(res, 200, { deleted: ing.id });
        }
      }
      if (req.method === 'GET' && pathname === '/api/recipes') return send(res, 200, db.recipes);
      if (req.method === 'POST' && pathname === '/api/recipes') {
        if (!requireKey(req, res)) return;
        const b = await readBody(req);
        try { validateRecipeIngredients(b.ingredients || []); }
        catch (e) { return send(res, 400, { error: e.message }); }
        const r = { businessId: BUSINESS_ID, id: slug(b.name), name: b.name, kind: b.kind || 'base', description: b.description || '', yields: b.yields || 1, yieldUnit: b.yieldUnit || 'portions', packSize: b.packSize || 1, sellPrice: b.sellPrice === undefined ? null : Number(b.sellPrice), ingredients: b.ingredients || [], components: b.components || [] };
        db.recipes.push(r); persist(); return send(res, 201, r);
      }
      const recipeMatch = pathname.match(/^\/api\/recipes\/([\w-]+)$/);
      if (recipeMatch) {
        const r = db.recipes.find(x => x.id === recipeMatch[1]);
        if (!r) return send(res, 404, { error: 'Recipe not found' });
        if (req.method === 'PATCH') {
          if (!requireKey(req, res)) return;
          const b = await readBody(req);
          if (b.ingredients !== undefined) {
            try { validateRecipeIngredients(b.ingredients); }
            catch (e) { return send(res, 400, { error: e.message }); }
          }
          if (b.name) r.name = b.name;
          if (b.description !== undefined) r.description = b.description;
          if (b.kind) r.kind = b.kind;
          if (b.yields !== undefined) r.yields = b.yields;
          if (b.yieldUnit !== undefined) r.yieldUnit = b.yieldUnit;
          if (b.packSize !== undefined) r.packSize = b.packSize;
          if (b.sellPrice !== undefined) r.sellPrice = b.sellPrice === null ? null : Number(b.sellPrice);
          if (b.ingredients !== undefined) r.ingredients = b.ingredients;
          if (b.components !== undefined) r.components = b.components;
          persist(); return send(res, 200, r);
        }
        if (req.method === 'DELETE') {
          if (!requireKey(req, res)) return;
          db.recipes = db.recipes.filter(x => x.id !== r.id); persist(); return send(res, 200, { deleted: r.id });
        }
      }
      if (req.method === 'POST' && pathname === '/api/plan') {
        const b = await readBody(req);
        const dough = b.dough || (b.doughBatchesMade === undefined ? undefined : { batchesMade: b.doughBatchesMade });
        try { return send(res, 200, doPlan(b.items || [], dough)); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (req.method === 'GET' && pathname === '/api/bake-plans') return send(res, 200, db.bakePlans.map(p => ({ ...p, calculation: doPlan(p.items, p.dough) })));
      if (req.method === 'POST' && pathname === '/api/bake-plans') {
        if (!requireKey(req, res)) return;
        const b = await readBody(req);
        const dough = b.dough || (b.doughBatchesMade === undefined ? null : { batchesMade: b.doughBatchesMade });
        const plan = { businessId: BUSINESS_ID, id: `plan-${Date.now()}`, name: b.name || 'Bake plan', date: b.date || new Date().toISOString().slice(0, 10), items: b.items || [], dough, status: 'planned', createdAt: new Date().toISOString() };
        try {
          const calc = doPlan(plan.items, plan.dough);
          db.bakePlans.push(plan); persist(); return send(res, 201, { ...plan, calculation: calc });
        } catch (e) { return send(res, 400, { error: e.message }); }
      }
      const completeMatch = pathname.match(/^\/api\/bake-plans\/([\w-]+)\/complete$/);
      if (completeMatch && req.method === 'POST') {
        if (!requireKey(req, res)) return;
        try { return send(res, 200, doCompleteBake(completeMatch[1])); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      const planMatch = pathname.match(/^\/api\/bake-plans\/([\w-]+)$/);
      if (planMatch) {
        const p = db.bakePlans.find(x => x.id === planMatch[1]);
        if (!p) return send(res, 404, { error: 'Bake plan not found' });
        if (req.method === 'PATCH') {
          if (!requireKey(req, res)) return;
          if (p.status !== 'planned') return send(res, 400, { error: 'Only a planned bake plan can be edited. This one is already completed.' });
          const b = await readBody(req);
          const newItems = b.items !== undefined ? b.items : p.items;
          const newDough = b.dough !== undefined ? b.dough : (b.doughBatchesMade !== undefined ? { batchesMade: b.doughBatchesMade } : p.dough);
          try {
            const calc = doPlan(newItems, newDough); // validate before changing anything
            if (b.name) p.name = b.name;
            if (b.date) p.date = b.date;
            p.items = newItems;
            p.dough = newDough;
            persist(); return send(res, 200, { ...p, calculation: calc });
          } catch (e) { return send(res, 400, { error: e.message }); }
        }
        if (req.method === 'DELETE') {
          if (!requireKey(req, res)) return;
          db.bakePlans = db.bakePlans.filter(x => x.id !== p.id); persist(); return send(res, 200, { deleted: p.id });
        }
      }
      if (req.method === 'POST' && pathname === '/api/make-dough') {
        if (!requireKey(req, res)) return;
        const b = await readBody(req);
        try { return send(res, 200, doMakeDough(b)); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (req.method === 'POST' && pathname === '/api/restock') {
        if (!requireKey(req, res)) return;
        const b = await readBody(req);
        try { return send(res, 200, doRestock(b.ingredientId || b.id, b.amount, b.unit, b.price)); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (req.method === 'GET' && pathname === '/api/shopping-list') return send(res, 200, doShoppingList());
      if (req.method === 'GET' && pathname === '/api/shopping-list.csv') {
        const list = doShoppingList();
        const csv = 'Ingredient,Have,Min,Need,Unit,Reason\n' + list.items.map(i => `"${i.name}",${i.have},${i.min},${i.need},${i.unit},${i.reason}`).join('\n');
        return send(res, 200, csv, 'text/csv');
      }
      return send(res, 404, { error: 'API route not found' });
    }

    // Static frontend
    let file = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.join(PUBLIC_DIR, file);
    if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

// Log the reason before exiting, so a crash shows up in the Railway
// deploy log instead of failing silently. Railway restarts the service
// after a crash, which is why a deploy looks crashed and then recovers.
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); process.exit(1); });
process.on('unhandledRejection', (err) => { console.error('Unhandled rejection:', err); process.exit(1); });

server.listen(PORT, '0.0.0.0', () => console.log(`Nami Bakes running at http://localhost:${PORT} — MCP at http://localhost:${PORT}/mcp`));
