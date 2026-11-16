// Nami Bakes verification — run with: npm test
// Starts the server on a temp DB, checks every critical rule, exits non-zero on failure.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const DB = '/tmp/nami-bakes-test-db.json';
try { fs.unlinkSync(DB); } catch {}
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}
const eq = (a, b) => Math.abs(a - b) < 1e-9;
async function j(p, opts) { const r = await fetch(BASE + p, opts); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } }

const server = spawn('node', ['server.js'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, PORT: String(PORT), DB_PATH: DB } });
await new Promise(r => setTimeout(r, 1200));
try {
  console.log('Health / inventory');
  const health = await j('/api/health'); check('health ok', health.ok === true);
  const inv = await j('/api/inventory');
  check('15 ingredients', Array.isArray(inv) && inv.length === 15, `got ${inv?.length}`);
  const soda = inv.find(i => i.id === 'baking-soda');
  check('Baking Soda is 7.56 (not 7.5599…)', soda && eq(soda.current, 7.56), `got ${soda?.current}`);
  check('Flour 2400g', inv.find(i => i.id === 'flour')?.current === 2400);
  check('Eggs 22', inv.find(i => i.id === 'eggs')?.current === 22);
  check('Cookie Dough Balls 15', inv.find(i => i.id === 'cookie-dough-balls')?.current === 15);

  console.log('Recipes');
  const recipes = await j('/api/recipes');
  check('4 recipes', recipes.length === 4, `got ${recipes.length}`);
  check('Brookie exists', recipes.some(r => r.id === 'brookie'));
  const doughRecipe = recipes.find(r => r.id === 'cookie-dough');
  check('Cookie dough yields 12 balls per batch', doughRecipe && doughRecipe.yields === 12 && doughRecipe.yieldUnit === 'balls', JSON.stringify(doughRecipe && { yields: doughRecipe.yields, yieldUnit: doughRecipe.yieldUnit }));

  console.log('Plan A: 1 brookie + 1 brownie');
  const a = await j('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ recipeId: 'brookie', qty: 1 }, { recipeId: 'brownies', qty: 1 }] }) });
  check('A cookie 0.5 portion', eq(a.cookiePortions, 0.5), `got ${a.cookiePortions}`);
  check('A brownie 1.5 portions', eq(a.browniePortions, 1.5), `got ${a.browniePortions}`);
  const aBrownie = a.subRecipes.find(s => s.recipeId === 'brownies');
  const aEggs = aBrownie.ingredients.find(i => i.ingredientId === 'eggs')?.qty;
  check('A brownie eggs = 5', eq(aEggs, 5), `got ${aEggs}`);
  check('A brownie butter 187.5g', eq(aBrownie.ingredients.find(i => i.ingredientId === 'unsalted-butter')?.qty, 187.5));
  const aTotalEggs = a.totals.find(t => t.ingredientId === 'eggs')?.qty;
  check('A total eggs = 5.5 (5 brownie + 0.5 cookie)', eq(aTotalEggs, 5.5), `got ${aTotalEggs}`);

  console.log('Plan B: 2 brookies + 1 brownie');
  const b = await j('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ recipeId: 'brookie', qty: 2 }, { recipeId: 'brownies', qty: 1 }] }) });
  check('B cookie 1.0 portion', eq(b.cookiePortions, 1.0), `got ${b.cookiePortions}`);
  check('B brownie 2.0 portions', eq(b.browniePortions, 2.0), `got ${b.browniePortions}`);
  const bBrownie = b.subRecipes.find(s => s.recipeId === 'brownies');
  check('B brownie eggs = 6', eq(bBrownie.ingredients.find(i => i.ingredientId === 'eggs')?.qty, 6));
  check('B brownie butter 250g', eq(bBrownie.ingredients.find(i => i.ingredientId === 'unsalted-butter')?.qty, 250));
  check('B cookie flour 195g', eq(b.subRecipes.find(s => s.recipeId === 'cookie-dough').ingredients.find(i => i.ingredientId === 'flour')?.qty, 195));
  check('B cookie sub-recipe is labelled in batches', b.subRecipes.find(s => s.recipeId === 'cookie-dough')?.portionsUnit === 'batches', `got ${b.subRecipes.find(s => s.recipeId === 'cookie-dough')?.portionsUnit}`);

  console.log('Single Brookie');
  const s = await j('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ recipeId: 'brookie', qty: 1 }] }) });
  check('Single brookie total eggs = 2.5', eq(s.totals.find(t => t.ingredientId === 'eggs')?.qty, 2.5));

  console.log('Merged dough: Peishi case — 1 brookie + 1 brownie, make 2 batches of dough');
  const p = await j('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ recipeId: 'brookie', qty: 1 }, { recipeId: 'brownies', qty: 1 }], doughBatchesMade: 2 }) });
  check('Peishi dough used = 0.5 batch', eq(p.doughUsed, 0.5), `got ${p.doughUsed}`);
  check('Peishi dough made = 2 batches', eq(p.doughBatchesMade, 2), `got ${p.doughBatchesMade}`);
  check('Peishi balls frozen = 18', eq(p.ballsAdded, 18), `got ${p.ballsAdded}`);
  check('Peishi total eggs = 7 (5 brownie + 2 dough)', eq(p.totals.find(t => t.ingredientId === 'eggs')?.qty, 7), `got ${p.totals.find(t => t.ingredientId === 'eggs')?.qty}`);
  check('Peishi cookie flour = 390g (2 batches)', eq(p.subRecipes.find(sr => sr.recipeId === 'cookie-dough').ingredients.find(i => i.ingredientId === 'flour')?.qty, 390));
  const pBad = await j('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ recipeId: 'brookie', qty: 1 }], doughBatchesMade: 0 }) });
  check('Too little dough is refused', typeof pBad.error === 'string' && pBad.error.includes('Not enough cookie dough'), JSON.stringify(pBad));
  const pDoughOnly = await j('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [], doughBatchesMade: 1 }) });
  check('Dough only: 1 batch freezes 12 balls', eq(pDoughOnly.ballsAdded, 12), `got ${pDoughOnly.ballsAdded}`);

  console.log('Inventory adjust');
  const adj = await j('/api/inventory/flour', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current: 2000 }) });
  check('Adjust flour to 2000', eq(adj.current, 2000));
  await j('/api/inventory/flour', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current: 2400 }) });

  console.log('Make cookie dough — CORRECTED MODEL: 1 batch = 12 balls, recipe deducted once per batch');
  console.log('10 batches need 1600g brown sugar, stock is 1440g — must be refused');
  const dough10 = await j('/api/make-dough', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchesMade: 10, cookiesBakedNow: 0 }) });
  check('10-batch request correctly refused (brown sugar short)', typeof dough10.error === 'string' && dough10.error.includes('Brown Sugar'), JSON.stringify(dough10));
  console.log('1 batch, bake 6 now / freeze 6 = 6 balls added (deducts only 195g flour / 160g brown sugar)');
  const dough1 = await j('/api/make-dough', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchesMade: 1, cookiesBakedNow: 6 }) });
  check('1 batch: ballsAdded = 6', dough1.ballsAdded === 6, `got ${dough1.ballsAdded}`);
  check('1 batch: ballsFrozen = 6', dough1.ballsFrozen === 6, `got ${dough1.ballsFrozen}`);
  check('1 batch: batchesMade = 1', dough1.batchesMade === 1, `got ${dough1.batchesMade}`);
  const inv2 = await j('/api/inventory');
  check('1 batch: balls stock now 15 + 6 = 21', eq(inv2.find(i => i.id === 'cookie-dough-balls')?.current, 21), `got ${inv2.find(i => i.id === 'cookie-dough-balls')?.current}`);
  check('1 batch: flour deducted 1 x 195, left 2205', eq(inv2.find(i => i.id === 'flour')?.current, 2205), `got ${inv2.find(i => i.id === 'flour')?.current}`);
  check('1 batch: brown sugar deducted 1 x 160, left 1280', eq(inv2.find(i => i.id === 'brown-sugar')?.current, 1280), `got ${inv2.find(i => i.id === 'brown-sugar')?.current}`);
  console.log('2 batches, bake 0 now / freeze 24 = 24 balls added');
  const dough2 = await j('/api/make-dough', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchesMade: 2, cookiesBakedNow: 0 }) });
  check('2 batches: ballsAdded = 24', dough2.ballsAdded === 24, `got ${dough2.ballsAdded}`);
  const inv3 = await j('/api/inventory');
  check('2 batches: balls stock now 21 + 24 = 45', eq(inv3.find(i => i.id === 'cookie-dough-balls')?.current, 45), `got ${inv3.find(i => i.id === 'cookie-dough-balls')?.current}`);
  check('2 batches: flour left 2205 - 390 = 1815', eq(inv3.find(i => i.id === 'flour')?.current, 1815), `got ${inv3.find(i => i.id === 'flour')?.current}`);
  check('2 batches: brown sugar left 1280 - 320 = 960', eq(inv3.find(i => i.id === 'brown-sugar')?.current, 960), `got ${inv3.find(i => i.id === 'brown-sugar')?.current}`);
  console.log('Baking more cookies than a batch makes must be refused');
  const doughBad = await j('/api/make-dough', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchesMade: 1, cookiesBakedNow: 13 }) });
  check('13 cookies from 1 batch refused', typeof doughBad.error === 'string', JSON.stringify(doughBad));
  console.log('Legacy API shape still works: portionsMade 1, baked 0, frozen 1 = 12 balls');
  const doughLegacy = await j('/api/make-dough', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ portionsMade: 1, portionsBakedNow: 0, portionsFrozen: 1 }) });
  check('Legacy: ballsAdded = 12', doughLegacy.ballsAdded === 12, `got ${doughLegacy.ballsAdded}`);
  const inv4 = await j('/api/inventory');
  check('Legacy: balls stock now 45 + 12 = 57', eq(inv4.find(i => i.id === 'cookie-dough-balls')?.current, 57), `got ${inv4.find(i => i.id === 'cookie-dough-balls')?.current}`);

  console.log('Merged dough: complete a saved Peishi plan (1 brookie + 1 brownie, 2 batches dough)');
  const saved = await j('/api/bake-plans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Peishi test', items: [{ recipeId: 'brookie', qty: 1 }, { recipeId: 'brownies', qty: 1 }], doughBatchesMade: 2 }) });
  check('Saved plan stores dough 2 batches', saved.dough && eq(saved.dough.batchesMade, 2), JSON.stringify(saved.dough));
  const done = await j(`/api/bake-plans/${saved.id}/complete`, { method: 'POST' });
  check('Complete reports 18 balls added', done.ballsAdded === 18, `got ${done.ballsAdded}`);
  const inv5 = await j('/api/inventory');
  check('Complete: balls now 57 + 18 = 75', eq(inv5.find(i => i.id === 'cookie-dough-balls')?.current, 75), `got ${inv5.find(i => i.id === 'cookie-dough-balls')?.current}`);
  check('Complete: flour now 1620 - 495 = 1125', eq(inv5.find(i => i.id === 'flour')?.current, 1125), `got ${inv5.find(i => i.id === 'flour')?.current}`);
  check('Complete: eggs now 18 - 7 = 11', eq(inv5.find(i => i.id === 'eggs')?.current, 11), `got ${inv5.find(i => i.id === 'eggs')?.current}`);

  console.log('Shopping list (set Eggs to 5, below min 10, should be flagged)');
  await j('/api/inventory/eggs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current: 5 }) });
  const shop = await j('/api/shopping-list');
  check('Shopping list flags eggs below min', shop.items.some(i => i.ingredientId === 'eggs'));
  check('Eggs need = 10 - 5 = 5', eq(shop.items.find(i => i.ingredientId === 'eggs')?.need, 5));
  check('Next Friday is a Friday', new Date(shop.nextFriday).getDay() === 5, shop.nextFriday);
  const csv = await j('/api/shopping-list.csv');
  check('CSV export contains Eggs', typeof csv === 'string' && csv.includes('Eggs'));

  console.log('Interactive restock — buy in a different unit, converted to inventory unit');
  const shop2 = await j('/api/shopping-list');
  const eggsItem = shop2.items.find(i => i.ingredientId === 'eggs');
  check('Shopping list eggs offers tray (10)', eggsItem && eggsItem.purchaseUnits.some(u => u.unit === 'tray' && u.perUnit === 10), JSON.stringify(eggsItem && eggsItem.purchaseUnits));
  check('Shopping list has no Cookie Dough Balls (made, not bought)', !shop2.items.some(i => i.ingredientId === 'cookie-dough-balls'));
  const restockEggs = await j('/api/restock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ingredientId: 'eggs', amount: 1, unit: 'tray' }) });
  check('Restock 1 tray eggs = 10 eggs, stock 5 + 10 = 15', restockEggs.added === 10 && eq(restockEggs.after, 15), JSON.stringify(restockEggs));
  const restockCoffee = await j('/api/restock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ingredientId: 'instant-coffee', amount: 200, unit: 'g' }) });
  check('Restock 200g BONCAFE coffee = 125 tsp (1 tsp = 1.6g)', eq(restockCoffee.added, 125), JSON.stringify(restockCoffee));
  check('Restock coffee stock 89.5 + 125 = 214.5 tsp', eq(restockCoffee.after, 214.5), JSON.stringify(restockCoffee));
  const restockFlour = await j('/api/restock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ingredientId: 'flour', amount: 1, unit: 'kg' }) });
  check('Restock 1 kg flour = 1000g, stock 1125 + 1000 = 2125', eq(restockFlour.added, 1000) && eq(restockFlour.after, 2125), JSON.stringify(restockFlour));
  const restockBad = await j('/api/restock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ingredientId: 'flour', amount: 1, unit: 'xyz' }) });
  check('Restock with unknown unit is refused', typeof restockBad.error === 'string' && restockBad.error.includes('Unknown purchase unit'), JSON.stringify(restockBad));

  console.log('MCP via HTTP');
  const mcpHeaders = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  const init = await fetch(BASE + '/mcp', { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'verify', version: '1.0' } } }) });
  const initText = await init.text();
  check('MCP initialize returns 200', init.status === 200, `got ${init.status}: ${initText.slice(0, 200)}`);
  check('MCP initialize mentions nami-bakes', initText.includes('nami-bakes'));
  const list = await fetch(BASE + '/mcp', { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
  const listText = await list.text();
  check('MCP tools/list includes plan_bake', listText.includes('plan_bake'));
  check('MCP tools/list includes make_cookie_dough', listText.includes('make_cookie_dough'));
  check('MCP tools/list includes list_inventory', listText.includes('list_inventory'));
  const call = await fetch(BASE + '/mcp', { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_inventory', arguments: {} } }) });
  const callText = await call.text();
  check('MCP tools/call list_inventory returns Flour', callText.includes('Flour'));

  console.log('Frontend');
  const html = await j('/');
  check('Frontend serves index', typeof html === 'string' && html.includes('Mise en Place'));
} catch (e) {
  fail++; console.log('  FAIL exception', e);
} finally {
  server.kill();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
