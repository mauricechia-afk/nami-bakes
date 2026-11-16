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
import { fmtQty, round3, brownieEggs, planBake, makeCookieDough, shoppingList, nextFriday } from './lib/calc.js';

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
function doPlan(items) {
  return planBake(items, db.recipes, db.ingredients);
}
function doCompleteBake(planId) {
  const plan = db.bakePlans.find(p => p.id === planId);
  if (!plan) throw new Error('Bake plan not found');
  if (plan.status === 'completed') throw new Error('Bake plan already completed');
  const calc = doPlan(plan.items);
  if (calc.insufficient.length) {
    throw new Error('Not enough stock: ' + calc.insufficient.map(i => `${i.name} needs ${fmtQty(i.qty)} ${i.unit}, have ${fmtQty(i.have)}`).join('; '));
  }
  for (const t of calc.totals) {
    const ing = db.ingredients.find(i => i.id === t.ingredientId);
    if (ing) ing.current = round3(ing.current - t.qty);
  }
  plan.status = 'completed';
  plan.completedAt = new Date().toISOString();
  persist();
  return { plan, deducted: calc.totals };
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
  for (const plan of db.bakePlans.filter(p => p.status === 'planned')) {
    for (const t of doPlan(plan.items).totals) {
      const ex = plannedTotals.find(x => x.ingredientId === t.ingredientId);
      if (ex) ex.qty = round3(ex.qty + t.qty); else plannedTotals.push({ ...t });
    }
  }
  return { nextFriday: nextFriday(), items: shoppingList(db.ingredients, plannedTotals), plannedTotals };
}

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
      const ing = { id: slug(name), name, unit, current: round3(current), min: round3(min) };
      if (db.ingredients.some(i => i.id === ing.id)) throw new Error('Ingredient already exists');
      db.ingredients.push(ing); persist();
      return { content: [{ type: 'text', text: JSON.stringify(ing) }] };
    });
  server.tool('list_recipes', 'List all recipes with per-portion ingredients.', {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(db.recipes) }] }));
  server.tool('get_recipe', 'Get one recipe by id or name.', { query: z.string() },
    async ({ query }) => {
      const r = db.recipes.find(x => x.id === query || x.id === slug(query) || x.name.toLowerCase() === query.toLowerCase());
      if (!r) throw new Error(`Recipe not found: ${query}`);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    });
  server.tool('create_recipe', 'Create a recipe. ingredients: [{ingredientId, qty, unit}] per portion.', {
    name: z.string(), description: z.string().optional(), ingredients: z.array(z.object({ ingredientId: z.string(), qty: z.number(), unit: z.string() })),
  }, async ({ name, description, ingredients }) => {
    const r = { id: slug(name), name, kind: 'base', description: description || '', yields: 1, yieldUnit: 'portions', ingredients };
    db.recipes.push(r); persist();
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
  });
  server.tool('plan_bake', 'Plan finished items and get aggregated sub-recipes. items: [{recipeId, qty}] e.g. [{recipeId:"brookie",qty:2},{recipeId:"brownies",qty:1}] = 1 cookie + 2 brownie portions. Brownie eggs: 3 per whole portion + 2 for a 0.5 remainder.', { items: z.array(z.object(itemShape)) },
    async ({ items }) => ({ content: [{ type: 'text', text: JSON.stringify(doPlan(items)) }] }));
  server.tool('get_bake_plan', 'Get a saved bake plan by id.', { id: z.string() },
    async ({ id }) => {
      const p = db.bakePlans.find(x => x.id === id);
      if (!p) throw new Error('Bake plan not found');
      return { content: [{ type: 'text', text: JSON.stringify({ ...p, calculation: doPlan(p.items) }) }] };
    });
  server.tool('complete_bake', 'Complete a saved bake plan: deducts aggregated ingredients from inventory.', { id: z.string() },
    async ({ id }) => ({ content: [{ type: 'text', text: JSON.stringify(doCompleteBake(id)) }] }));
  server.tool('get_shopping_list', 'Friday shopping list: below-min items plus projected need from planned bakes.', {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(doShoppingList()) }] }));
  server.tool('get_restock_forecast', 'Alias for get_shopping_list: weekly restock forecast for the Friday shop.', {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(doShoppingList()) }] }));
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
      if (req.method === 'GET' && pathname === '/api/inventory') return send(res, 200, db.ingredients);
      if (req.method === 'POST' && pathname === '/api/inventory') {
        if (!requireKey(req, res)) return;
        const b = await readBody(req);
        const ing = { id: slug(b.name), name: b.name, unit: b.unit, current: round3(b.current), min: round3(b.min) };
        db.ingredients.push(ing); persist(); return send(res, 201, ing);
      }
      const invMatch = pathname.match(/^\/api\/inventory\/([\w-]+)$/);
      if (invMatch) {
        const ing = db.ingredients.find(i => i.id === invMatch[1]);
        if (!ing) return send(res, 404, { error: 'Ingredient not found' });
        if (req.method === 'PATCH') {
          if (!requireKey(req, res)) return;
          const b = await readBody(req);
          if (b.current !== undefined) ing.current = round3(b.current);
          if (b.min !== undefined) ing.min = round3(b.min);
          if (b.name) ing.name = b.name;
          if (b.unit) ing.unit = b.unit;
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
        const r = { id: slug(b.name), name: b.name, kind: b.kind || 'base', description: b.description || '', yields: b.yields || 1, yieldUnit: b.yieldUnit || 'portions', ingredients: b.ingredients || [], components: b.components || [] };
        db.recipes.push(r); persist(); return send(res, 201, r);
      }
      if (req.method === 'POST' && pathname === '/api/plan') {
        const b = await readBody(req);
        return send(res, 200, doPlan(b.items || []));
      }
      if (req.method === 'GET' && pathname === '/api/bake-plans') return send(res, 200, db.bakePlans.map(p => ({ ...p, calculation: doPlan(p.items) })));
      if (req.method === 'POST' && pathname === '/api/bake-plans') {
        if (!requireKey(req, res)) return;
        const b = await readBody(req);
        const plan = { id: `plan-${Date.now()}`, name: b.name || 'Bake plan', date: b.date || new Date().toISOString().slice(0, 10), items: b.items || [], status: 'planned', createdAt: new Date().toISOString() };
        db.bakePlans.push(plan); persist(); return send(res, 201, { ...plan, calculation: doPlan(plan.items) });
      }
      const completeMatch = pathname.match(/^\/api\/bake-plans\/([\w-]+)\/complete$/);
      if (completeMatch && req.method === 'POST') {
        if (!requireKey(req, res)) return;
        try { return send(res, 200, doCompleteBake(completeMatch[1])); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (req.method === 'POST' && pathname === '/api/make-dough') {
        if (!requireKey(req, res)) return;
        const b = await readBody(req);
        try { return send(res, 200, doMakeDough(b)); }
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

server.listen(PORT, () => console.log(`Nami Bakes running at http://localhost:${PORT} — MCP at http://localhost:${PORT}/mcp`));
