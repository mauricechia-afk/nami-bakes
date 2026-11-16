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
  const whole = Math.floor(portions + 1e-9);
  const frac = portions - whole;
  let eggs = whole * 3;
  if (frac > 0.01) eggs += 2; // any partial (in practice 0.5) counts as 2 eggs
  return eggs;
}

// Scale one base recipe by `portions`, applying the brownie egg rule.
// Returns [{ingredientId, qty, unit}]
function scaleRecipe(recipe, portions, ingredientById) {
  const out = [];
  for (const ing of recipe.ingredients) {
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
// Returns { subRecipes, direct, totals, items }
function planBake(items, recipes, ingredients) {
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

  const subRecipes = [];
  if (cookiePortions > 0) {
    subRecipes.push({
      recipeId: 'cookie-dough', name: 'Cookie dough', portions: cookiePortions, portionsUnit: 'batches',
      ingredients: scaleRecipe(recipeById['cookie-dough'], cookiePortions, ingredientById),
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
// - Below-min items: need = min - current.
// - Plus projected need from planned bakes: required - current, if positive.
//   (plannedTotals are ingredient totals from planBake for uncompleted plans)
function shoppingList(ingredients, plannedTotals = []) {
  const planned = Object.fromEntries(plannedTotals.map(t => [t.ingredientId, t.qty]));
  const list = [];
  for (const ing of ingredients) {
    const belowMin = ing.min - ing.current;
    const projectedShort = (planned[ing.id] || 0) - ing.current;
    const need = Math.max(belowMin, projectedShort, 0);
    if (need > 0 || belowMin > 0) {
      list.push({
        ingredientId: ing.id, name: ing.name, unit: ing.unit,
        have: ing.current, min: ing.min,
        need: round3(need),
        reason: belowMin > 0 && projectedShort > belowMin ? 'below min + planned bakes'
          : belowMin > 0 ? 'below min' : 'planned bakes',
      });
    }
  }
  return list;
}

function nextFriday(from = new Date()) {
  const d = new Date(from);
  const day = d.getDay(); // 0 Sun .. 5 Fri
  let add = (5 - day + 7) % 7;
  if (add === 0) add = 7; // today is Friday -> next Friday (shop is weekly)
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0, 10);
}

export { round3, round2, fmtQty, brownieEggs, scaleRecipe, planBake, makeCookieDough, shoppingList, nextFriday };
