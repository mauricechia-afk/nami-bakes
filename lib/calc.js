// Shared calculation logic — used by the web UI, the REST API and the MCP tools.
// Keep this pure (no I/O) so the same numbers come out everywhere.

function round3(n) {
  // Round to 3 decimals to kill floating-point artefacts (7.559999999999916 -> 7.56).
  // Full precision is kept by callers where needed; this is for display/storage.
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// Display: 7.56 stays "7.56", 0.315 stays "0.315", 187.5 stays "187.5".
// Never shows 7.559999999999916.
function fmtQty(n) {
  const r = round3(n);
  return String(r);
}

// Brownie egg rule — CRITICAL, agreed with Maurice 2026-11-14:
// Aggregate brownie portions FIRST, then:
//   whole portions: 3 eggs each
//   a 0.5 remainder: 2 eggs (not 1.5)
//   0.5 -> 2, 1.0 -> 3, 1.5 -> 5, 2.0 -> 6, 2.5 -> 8
function brownieEggs(portions) {
  if (!portions || portions <= 0) return 0;
  // Aggregate first, then round the total up to the nearest 0.5 portion.
  // 0.25 -> 0.5 -> 2 eggs, 0.75 -> 1.0 -> 3 eggs, 1.5 -> 5, 2.5 -> 8.
  // 1 brookie alone is 0.5 brownie portions -> 2 eggs, but 2 brookies
  // aggregate to 1.0 portion -> 3 eggs, not 4.
  const rounded = Math.ceil(portions * 2 - 1e-9) / 2;
  const whole = Math.floor(rounded + 1e-9);
  const frac = rounded - whole;
  return whole * 3 + (frac > 0.01 ? 2 : 0);
}

// Scale one base recipe by `portions`, applying the brownie egg rule.
// Returns [{ingredientId, qty, unit}]
// An ingredient that is not in Inventory is an error, not a silent skip:
// silently skipping it would mean a bake deducts everything except that
// ingredient, and the shopping list would never flag it.
function scaleRecipe(recipe, portions, ingredientById) {
  const out = [];
  for (const ing of recipe.ingredients) {
    if (!ingredientById[ing.ingredientId]) {
      throw new Error(`Recipe "${recipe.name}" uses unknown ingredient "${ing.ingredientId}" — add it to Inventory first, then add it to the recipe.`);
    }
    let qty;
    if (recipe.id === 'brownies' && ing.ingredientId === 'eggs') {
      qty = brownieEggs(portions);
    } else {
      qty = round3(ing.qty * portions);
    }
    out.push({ ingredientId: ing.ingredientId, name: ingredientById[ing.ingredientId]?.name || ing.ingredientId, qty, unit: ing.unit });
  }
  return out;
}

// Plan finished items and decompose into base sub-recipes.
// items: [{recipeId, qty}] — qty is the number of finished items / portions:
//   brookie: number of brookies, brownies: number of brownie portions,
//   cookie-dough: number of BATCHES (1 batch = 1 portion = 12 balls/cookies),
//   cookies-from-balls: number of boxes of 6.
// A Brookie's half cookie portion is half a batch = 6 balls' worth of dough,
// with ingredient amounts halved as before.
//
// Merged dough model (2026-11-16, Maurice): dough is made in whole batches
// inside the bake plan. dough = { batchesMade } (optional).
//   doughUsed = cookiePortions (dough needed for brookies, in batches)
//   ballsAdded = (batchesMade - doughUsed) * 12
// All dough made becomes frozen balls except the part used in this bake.
// There is no "cookies baked now" step: baking cookies now is done by
// planning boxes of Cookies (from balls), which deducts frozen balls.
//   Peishi example: 1 brookie, batchesMade 2 -> doughUsed 0.5, ballsAdded 18.
// Without dough, the legacy calculation is kept: dough is costed at exactly
// doughUsed (fractional) and ballsAdded is 0, so old callers and tests keep
// their numbers.
// Returns { subRecipes, direct, totals, items, doughBatchesMade, doughUsed, ballsAdded }
function planBake(items, recipes, ingredients, dough) {
  const recipeById = Object.fromEntries(recipes.map(r => [r.id, r]));
  const ingredientById = Object.fromEntries(ingredients.map(i => [i.id, i]));
  let cookiePortions = 0, browniePortions = 0;
  const direct = {}; // ingredientId -> qty (e.g. Cookie Dough Balls)
  for (const item of items) {
    const qty = Number(item.qty);
    if (!qty || qty <= 0) continue;
    const recipe = recipeById[item.recipeId];
    if (!recipe) throw new Error(`Unknown recipe: ${item.recipeId}`);
    if (item.recipeId === 'brookie') {
      cookiePortions += 0.5 * qty;
      browniePortions += 0.5 * qty;
    } else if (item.recipeId === 'cookie-dough') {
      cookiePortions += qty;
    } else if (item.recipeId === 'brownies') {
      browniePortions += qty;
    } else if (item.recipeId === 'cookies-from-balls') {
      direct['cookie-dough-balls'] = round3((direct['cookie-dough-balls'] || 0) + 6 * qty);
    } else {
      // Any other base recipe: treat qty as portions of itself.
      // (Custom recipes added later use this path.)
      direct[`__recipe:${recipe.id}`] = qty;
    }
  }
  cookiePortions = round3(cookiePortions);
  browniePortions = round3(browniePortions);

  // Dough made in this plan (whole batches). Without dough, cost the dough
  // used, fractionally, as before. With dough, cost whole batches made and
  // freeze the rest as balls.
  let doughBatchesMade = cookiePortions;
  let ballsAdded = 0;
  if (dough !== undefined && dough !== null) {
    doughBatchesMade = Number(dough.batchesMade ?? 0);
    if (!Number.isFinite(doughBatchesMade) || doughBatchesMade < 0 || !Number.isInteger(doughBatchesMade)) {
      throw new Error('batchesMade must be a whole number of batches (0, 1, 2, …)');
    }
    if (doughBatchesMade < cookiePortions - 1e-9) {
      throw new Error(`Not enough cookie dough made: this bake needs ${fmtQty(cookiePortions)} batches of dough, you made ${doughBatchesMade}. Make at least ${Math.ceil(cookiePortions - 1e-9)} batch${Math.ceil(cookiePortions - 1e-9) === 1 ? '' : 'es'}.`);
    }
    ballsAdded = round3((doughBatchesMade - cookiePortions) * 12);
  }

  const subRecipes = [];
  if (doughBatchesMade > 0) {
    subRecipes.push({
      recipeId: 'cookie-dough', name: 'Cookie dough', portions: doughBatchesMade, portionsUnit: 'batches',
      ingredients: scaleRecipe(recipeById['cookie-dough'], doughBatchesMade, ingredientById),
      doughUsed: cookiePortions, ballsAdded,
    });
  }
  if (browniePortions > 0) {
    subRecipes.push({
      recipeId: 'brownies', name: 'Brownies', portions: browniePortions, portionsUnit: 'portions',
      ingredients: scaleRecipe(recipeById['brownies'], browniePortions, ingredientById),
    });
  }

  // Totals across sub-recipes + direct items.
  const totalsMap = {};
  for (const sr of subRecipes) {
    for (const ing of sr.ingredients) {
      if (!totalsMap[ing.ingredientId]) totalsMap[ing.ingredientId] = { ingredientId: ing.ingredientId, name: ing.name, qty: 0, unit: ing.unit };
      totalsMap[ing.ingredientId].qty = round3(totalsMap[ing.ingredientId].qty + ing.qty);
    }
  }
  for (const [id, qty] of Object.entries(direct)) {
    if (id.startsWith('__recipe:')) continue;
    const ing = ingredientById[id];
    if (!totalsMap[id]) totalsMap[id] = { ingredientId: id, name: ing?.name || id, qty: 0, unit: ing?.unit || '' };
    totalsMap[id].qty = round3(totalsMap[id].qty + qty);
  }
  const totals = Object.values(totalsMap);

  // Shortfalls against current stock.
  const insufficient = totals
    .filter(t => {
      const stock = ingredientById[t.ingredientId];
      return stock && t.qty > stock.current + 1e-9;
    })
    .map(t => ({ ...t, have: ingredientById[t.ingredientId].current, shortBy: round3(t.qty - ingredientById[t.ingredientId].current) }));

  return {
    items,
    subRecipes,
    direct: Object.entries(direct).filter(([k]) => !k.startsWith('__recipe:')).map(([ingredientId, qty]) => ({
      ingredientId, name: ingredientById[ingredientId]?.name || ingredientId, qty, unit: ingredientById[ingredientId]?.unit || '',
    })),
    totals,
    insufficient,
    cookiePortions, browniePortions,
    doughBatchesMade, doughUsed: cookiePortions, ballsAdded,
  };
}

// Cookie dough -> balls — CORRECTED MODEL (2026-11-14, confirmed by Maurice):
// 1 portion = 1 full batch = 12 balls (usually 13, count as 12 on average).
// The recipe amounts are PER BATCH: one batch deducts Flour 195g, Brown Sugar
// 160g, etc. ONCE, and makes 12 balls. It is NOT 12 portions per batch.
//
// New input shape: { batchesMade, cookiesBakedNow }
//   batchesMade: number of batches made (usually 1, default 1)
//   cookiesBakedNow: cookies baked fresh now, 0–12 per batch (in cookies/balls)
//   ballsFrozen (derived) = batchesMade * 12 - cookiesBakedNow
//   ballsAdded = ballsFrozen (the frozen balls added to inventory)
//
// Legacy input shape (kept for backward compatibility): if `portionsMade` is
// present, it is read as batches made, and `portionsBakedNow` /
// `portionsFrozen` are read as portions (batches) baked / frozen, i.e.
// cookiesBakedNow = portionsBakedNow * 12, ballsFrozen = portionsFrozen * 12.
function makeCookieDough(input, recipes, ingredients) {
  const recipe = recipes.find(r => r.id === 'cookie-dough');
  const ingredientById = Object.fromEntries(ingredients.map(i => [i.id, i]));
  let batchesMade, cookiesBakedNow;
  if (input.batchesMade !== undefined || input.cookiesBakedNow !== undefined) {
    batchesMade = Number(input.batchesMade ?? 1);
    cookiesBakedNow = Number(input.cookiesBakedNow ?? 0);
  } else {
    // Legacy shape.
    batchesMade = Number(input.portionsMade ?? 1);
    const bakedPortions = Number(input.portionsBakedNow ?? 0);
    const frozenPortions = Number(input.portionsFrozen ?? 0);
    if (Math.abs(bakedPortions + frozenPortions - batchesMade) > 1e-9) {
      throw new Error('portionsBakedNow + portionsFrozen must equal portionsMade');
    }
    cookiesBakedNow = bakedPortions * 12;
  }
  if (!Number.isFinite(batchesMade) || batchesMade <= 0 || !Number.isInteger(batchesMade)) {
    throw new Error('batchesMade must be a whole number of batches (1, 2, …)');
  }
  if (!Number.isFinite(cookiesBakedNow) || cookiesBakedNow < 0 || !Number.isInteger(cookiesBakedNow)) {
    throw new Error('cookiesBakedNow must be a whole number of cookies (0–12 per batch)');
  }
  const totalBalls = batchesMade * 12;
  if (cookiesBakedNow > totalBalls) {
    throw new Error(`cookiesBakedNow cannot exceed ${totalBalls} cookies (${batchesMade} ${batchesMade === 1 ? 'batch' : 'batches'} × 12)`);
  }
  const ballsFrozen = totalBalls - cookiesBakedNow;
  const deducted = scaleRecipe(recipe, batchesMade, ingredientById);
  const ballsAdded = ballsFrozen;
  return {
    deducted, ballsAdded, ballsFrozen, cookiesBakedNow, batchesMade,
    // Legacy aliases, in portions (= batches), for old callers.
    portionsMade: batchesMade,
    portionsBakedNow: round3(cookiesBakedNow / 12),
    portionsFrozen: round3(ballsFrozen / 12),
  };
}

// Shopping / Friday restock list.
// Buy enough to cover planned bakes AND get back to the minimum:
//   need = max(0, planned need + minimum - current stock)
// (plannedTotals are ingredient totals from planBake for uncompleted plans)
function shoppingList(ingredients, plannedTotals = [], plansWithDates = []) {
  const planned = Object.fromEntries(plannedTotals.map(t => [t.ingredientId, t.qty]));
  // Day by day projection: walk planned bakes in date order and find the
  // first date the stock would fall below minimum, or run out entirely.
  const nf = nextFriday();
  const byDate = [...plansWithDates].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const list = [];
  for (const ing of ingredients) {
    // Cookie Dough Balls are made, not bought — they never appear on the
    // shopping list. Make dough in Batch Planning instead.
    if (ing.id === 'cookie-dough-balls') continue;
    const belowMin = ing.min - ing.current;
    const need = Math.max((planned[ing.id] || 0) + ing.min - ing.current, 0);
    if (need > 0) {
      let running = ing.current, shortDate = null, outDate = null;
      for (const p of byDate) {
        const t = (p.totals || []).find(x => x.ingredientId === ing.id);
        if (!t) continue;
        running = round3(running - t.qty);
        if (!shortDate && running < ing.min - 1e-9) shortDate = p.date;
        if (!outDate && running < -1e-9) outDate = p.date;
        if (shortDate && outDate) break;
      }
      if (!shortDate && belowMin > 0) shortDate = 'now';
      list.push({
        ingredientId: ing.id, name: ing.name, unit: ing.unit,
        have: ing.current, min: ing.min,
        need: round3(need),
        reason: belowMin > 0 && (planned[ing.id] || 0) > 0 ? 'below min + planned bakes'
          : belowMin > 0 ? 'below min' : 'planned bakes',
        shortDate, outDate,
        shortBeforeNextShop: shortDate ? (shortDate === 'now' || shortDate < nf) : false,
      });
    }
  }
  return list;
}

// Cost tracking: unitPrice is the latest price paid per stock unit (SGD),
// recorded at restock time. Cost per bake uses that latest price, and the
// cost is saved when a bake is completed, so a later price change does not
// rewrite past costs.
function costTotals(totals, ingredientById) {
  const costs = [];
  let totalCost = 0;
  const missingPrices = [];
  for (const t of totals) {
    const ing = ingredientById[t.ingredientId];
    const unitPrice = ing && Number.isFinite(Number(ing.lastPrice)) ? Number(ing.lastPrice) : null;
    if (unitPrice === null) { missingPrices.push(t.name); costs.push({ ...t, unitPrice: null, cost: null }); continue; }
    const cost = round2(t.qty * unitPrice);
    totalCost = round2(totalCost + cost);
    costs.push({ ...t, unitPrice, cost });
  }
  return { costs, totalCost, missingPrices };
}

// Purchase-unit conversions (2026-11-16, Maurice).
// Inventory is stored in one unit per ingredient (g, tsp, tbs, eggs, balls).
// A purchase can be entered in a different unit and is converted to the
// inventory unit before it is added to stock.
//   perUnit = inventory units you get for 1 purchase unit.
//   Instant coffee (BONCAFE): Maurice weighed 10 tsp = 16 g, so 1 tsp = 1.6 g,
//   even though the bottle says 2 g per tsp. 200 g = 125 tsp.
//   Vanilla: 1 tsp = 5 ml (volume, no density guess).
//   Baking soda: 1 tsp = 4.8 g. Sea salt flakes: 1 tsp = 3 g.
//   Cornstarch: 1 tbs = 8 g. 1 tbs = 3 tsp, 1 tsp = 5 ml, 1 kg = 1000 g.
// Packs Maurice buys: flour 1 kg bags, white sugar 3 kg bags, butter 1 kg
// blocks, chocolate chips 2.5 kg bags, eggs in trays of 10 (inventory stays
// in individual eggs, as he also uses them for home cooking).
const PURCHASE_UNITS = {
  flour: [{ unit: 'g', label: 'g', perUnit: 1 }, { unit: 'kg', label: 'kg', perUnit: 1000 }, { unit: 'bag', label: 'bag (1 kg)', perUnit: 1000 }],
  'brown-sugar': [{ unit: 'g', label: 'g', perUnit: 1 }, { unit: 'kg', label: 'kg', perUnit: 1000 }, { unit: 'bag', label: 'bag (1 kg)', perUnit: 1000 }],
  'white-sugar': [{ unit: 'g', label: 'g', perUnit: 1 }, { unit: 'kg', label: 'kg', perUnit: 1000 }, { unit: 'bag', label: 'bag (3 kg)', perUnit: 3000 }],
  'unsalted-butter': [{ unit: 'g', label: 'g', perUnit: 1 }, { unit: 'kg', label: 'kg', perUnit: 1000 }, { unit: 'block', label: 'block (1 kg)', perUnit: 1000 }],
  eggs: [{ unit: 'eggs', label: 'eggs', perUnit: 1 }, { unit: 'tray', label: 'tray (10)', perUnit: 10 }],
  'vanilla-extract': [{ unit: 'tsp', label: 'tsp', perUnit: 1 }, { unit: 'ml', label: 'ml', perUnit: 0.2 }, { unit: 'L', label: 'L', perUnit: 200 }],
  'baking-soda': [{ unit: 'tsp', label: 'tsp', perUnit: 1 }, { unit: 'g', label: 'g', perUnit: 1 / 4.8 }, { unit: 'tbs', label: 'tbs', perUnit: 3 }],
  'refined-coconut-oil': [{ unit: 'g', label: 'g', perUnit: 1 }, { unit: 'kg', label: 'kg', perUnit: 1000 }],
  'dark-choc-70': [{ unit: 'g', label: 'g', perUnit: 1 }, { unit: 'kg', label: 'kg', perUnit: 1000 }, { unit: 'bag', label: 'bag (2.5 kg)', perUnit: 2500 }],
  'dark-choc-54': [{ unit: 'g', label: 'g', perUnit: 1 }, { unit: 'kg', label: 'kg', perUnit: 1000 }, { unit: 'bag', label: 'bag (2.5 kg)', perUnit: 2500 }],
  'cocoa-powder': [{ unit: 'g', label: 'g', perUnit: 1 }, { unit: 'kg', label: 'kg', perUnit: 1000 }],
  'sea-salt-flakes': [{ unit: 'tsp', label: 'tsp', perUnit: 1 }, { unit: 'g', label: 'g', perUnit: 1 / 3 }, { unit: 'tbs', label: 'tbs', perUnit: 3 }],
  cornstarch: [{ unit: 'tbs', label: 'tbs', perUnit: 1 }, { unit: 'g', label: 'g', perUnit: 0.125 }, { unit: 'tsp', label: 'tsp', perUnit: 1 / 3 }],
  'cookie-dough-balls': [{ unit: 'balls', label: 'balls', perUnit: 1 }],
  'instant-coffee': [{ unit: 'tsp', label: 'tsp', perUnit: 1 }, { unit: 'g', label: 'g', perUnit: 0.625 }, { unit: 'tbs', label: 'tbs', perUnit: 3 }],
};
function purchaseUnitsFor(ingredientId, inventoryUnit) {
  return PURCHASE_UNITS[ingredientId] || [{ unit: inventoryUnit, label: inventoryUnit, perUnit: 1 }];
}
function convertPurchase(ingredientId, amount, unit) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Purchase amount must be more than 0');
  const options = PURCHASE_UNITS[ingredientId];
  if (!options) throw new Error(`No purchase units for ingredient: ${ingredientId}`);
  const found = options.find(o => o.unit === unit);
  if (!found) throw new Error(`Unknown purchase unit "${unit}" for ${ingredientId}. Use one of: ${options.map(o => o.unit).join(', ')}`);
  return round3(n * found.perUnit);
}

function nextFriday(from = new Date()) {
  const d = new Date(from);
  const day = d.getDay(); // 0 Sun .. 5 Fri
  let add = (5 - day + 7) % 7;
  if (add === 0) add = 7; // today is Friday -> next Friday (shop is weekly)
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0, 10);
}

export { round3, round2, fmtQty, brownieEggs, scaleRecipe, planBake, makeCookieDough, shoppingList, costTotals, nextFriday, PURCHASE_UNITS, purchaseUnitsFor, convertPurchase };
