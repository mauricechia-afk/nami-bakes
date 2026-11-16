// Real Nami Bakes seed data — from Maurice's screenshots, 2026-11-14 09:35 SGT.
// Do NOT replace with demo data (Flour 50kg etc.). Those were seeded defaults
// in a fresh browser, not Maurice's stock.
const INGREDIENTS = [
  { businessId: 'nami-bakes', id: 'flour', name: 'Flour', unit: 'g', current: 2400, min: 300 },
  { businessId: 'nami-bakes', id: 'brown-sugar', name: 'Brown Sugar', unit: 'g', current: 1440, min: 320 },
  { businessId: 'nami-bakes', id: 'unsalted-butter', name: 'Unsalted Butter', unit: 'g', current: 3990, min: 250 },
  { businessId: 'nami-bakes', id: 'eggs', name: 'Eggs', unit: 'eggs', current: 22, min: 10 },
  { businessId: 'nami-bakes', id: 'white-sugar', name: 'White Sugar', unit: 'g', current: 3310, min: 220 },
  { businessId: 'nami-bakes', id: 'vanilla-extract', name: 'Vanilla extract', unit: 'tsp', current: 27, min: 5 },
  // Screenshot showed 7.559999999999916 tsp (floating-point bug). Real value is 7.56.
  { businessId: 'nami-bakes', id: 'baking-soda', name: 'Baking Soda', unit: 'tsp', current: 7.56, min: 5 },
  { businessId: 'nami-bakes', id: 'refined-coconut-oil', name: 'Refined Coconut Oil', unit: 'g', current: 360, min: 60 },
  { businessId: 'nami-bakes', id: 'dark-choc-70', name: '70.5% Dark Chocolate Chips', unit: 'g', current: 2410, min: 200 },
  { businessId: 'nami-bakes', id: 'dark-choc-54', name: '54.5% Dark Chocolate Chips', unit: 'g', current: 2260, min: 400 },
  { businessId: 'nami-bakes', id: 'cocoa-powder', name: 'Cocoa Powder', unit: 'g', current: 3125, min: 100 },
  { businessId: 'nami-bakes', id: 'sea-salt-flakes', name: 'Sea Salt Flakes', unit: 'tsp', current: 327, min: 5 },
  { businessId: 'nami-bakes', id: 'cornstarch', name: 'Cornstarch', unit: 'tbs', current: 29, min: 2 },
  { businessId: 'nami-bakes', id: 'cookie-dough-balls', name: 'Cookie Dough Balls', unit: 'Balls', current: 15, min: 6 },
  { businessId: 'nami-bakes', id: 'instant-coffee', name: 'Instant Coffee', unit: 'tsp', current: 91, min: 10 },
];

// Ingredient amounts are PER PORTION of the base recipe, unless noted.
// For Cookie dough, 1 portion = 1 full batch (12 balls), so the amounts
// below are per batch. Ingredient keys are ingredient ids above.
const RECIPES = [
  {
    businessId: 'nami-bakes',
    id: 'cookie-dough',
    packSize: 1,
    name: 'Cookie dough',
    kind: 'base',
    // CORRECTED 2026-11-14: 1 portion = 1 full batch = 12 balls / 12 cookies
    // (usually 13, count as 12). Amounts below are PER BATCH, not per 12 batches.
    description: '1 batch = 12 balls / 12 cookies (usually 13, count as 12)',
    yields: 12, yieldUnit: 'balls',
    ingredients: [
      { ingredientId: 'brown-sugar', qty: 160, unit: 'g' },
      { ingredientId: 'white-sugar', qty: 60, unit: 'g' },
      { ingredientId: 'unsalted-butter', qty: 115, unit: 'g' },
      { ingredientId: 'sea-salt-flakes', qty: 1, unit: 'tsp' },
      { ingredientId: 'eggs', qty: 1, unit: 'eggs' },
      { ingredientId: 'vanilla-extract', qty: 1, unit: 'tsp' },
      // Maurice added 2026-11-16: instant coffee for flavour, to bring out
      // the chocolate and toastiness. 0.25 tsp per batch.
      { ingredientId: 'instant-coffee', qty: 0.25, unit: 'tsp' },
      { ingredientId: 'flour', qty: 195, unit: 'g' },
      { ingredientId: 'baking-soda', qty: 0.5, unit: 'tsp' },
      { ingredientId: 'dark-choc-54', qty: 180, unit: 'g' },
      { ingredientId: 'dark-choc-70', qty: 40, unit: 'g' },
    ],
  },
  {
    businessId: 'nami-bakes',
    id: 'brownies',
    packSize: 1,
    name: 'Brownies',
    kind: 'base',
    description: 'Brown the butter, need 100g of browned butter. For each brownie, 2 egg + 1 yolk.',
    yields: 1, yieldUnit: 'portions',
    ingredients: [
      { ingredientId: 'unsalted-butter', qty: 125, unit: 'g' },
      { ingredientId: 'white-sugar', qty: 220, unit: 'g' },
      { ingredientId: 'eggs', qty: 3, unit: 'eggs' },
      { ingredientId: 'vanilla-extract', qty: 1, unit: 'tsp' },
      { ingredientId: 'cocoa-powder', qty: 75, unit: 'g' },
      { ingredientId: 'refined-coconut-oil', qty: 30, unit: 'g' },
      { ingredientId: 'flour', qty: 70, unit: 'g' },
      { ingredientId: 'cornstarch', qty: 1, unit: 'tbs' },
      { ingredientId: 'baking-soda', qty: 0.13, unit: 'tsp' },
      { ingredientId: 'sea-salt-flakes', qty: 0.25, unit: 'tsp' },
      { ingredientId: 'dark-choc-54', qty: 70, unit: 'g' },
      { ingredientId: 'dark-choc-70', qty: 70, unit: 'g' },
      { ingredientId: 'instant-coffee', qty: 1, unit: 'tsp' },
    ],
  },
  {
    businessId: 'nami-bakes',
    id: 'cookies-from-balls',
    packSize: 6,
    name: 'Cookies (from balls)',
    kind: 'composite',
    description: 'Box of 6 cookies',
    yields: 6, yieldUnit: 'portions',
    // 1 box uses 6 balls. This is a direct inventory deduction, not a sub-recipe.
    ingredients: [
      { ingredientId: 'cookie-dough-balls', qty: 6, unit: 'Balls' },
    ],
    components: [], // direct
  },
  {
    businessId: 'nami-bakes',
    id: 'brookie',
    packSize: 1,
    name: 'Brookie',
    kind: 'composite',
    description: 'Half a portion of Cookie dough + half a portion of Brownies. Brownie half uses 2 eggs (cannot split 3 eggs).',
    yields: 1, yieldUnit: 'brookie',
    // Per 1 brookie, derived and verified 2026-11-14:
    // Brown Sugar 80, White Sugar 140, Butter 120, Sea Salt 0.625 tsp,
    // Eggs 2.5, Vanilla 1 tsp, Flour 132.5, Baking Soda 0.315 tsp,
    // 54.5% 125g, 70.5% 55g, Cocoa 37.5g, Coconut Oil 15g,
    // Cornstarch 0.5 tbs, Instant Coffee 0.625 tsp
    // (0.5 from the brownie half + 0.125 from the cookie dough half,
    // since cookie dough now has 0.25 tsp coffee per batch).
    ingredients: [
      { ingredientId: 'brown-sugar', qty: 80, unit: 'g' },
      { ingredientId: 'white-sugar', qty: 140, unit: 'g' },
      { ingredientId: 'unsalted-butter', qty: 120, unit: 'g' },
      { ingredientId: 'sea-salt-flakes', qty: 0.625, unit: 'tsp' },
      { ingredientId: 'eggs', qty: 2.5, unit: 'eggs' },
      { ingredientId: 'vanilla-extract', qty: 1, unit: 'tsp' },
      { ingredientId: 'flour', qty: 132.5, unit: 'g' },
      { ingredientId: 'baking-soda', qty: 0.315, unit: 'tsp' },
      { ingredientId: 'dark-choc-54', qty: 125, unit: 'g' },
      { ingredientId: 'dark-choc-70', qty: 55, unit: 'g' },
      { ingredientId: 'cocoa-powder', qty: 37.5, unit: 'g' },
      { ingredientId: 'refined-coconut-oil', qty: 15, unit: 'g' },
      { ingredientId: 'cornstarch', qty: 0.5, unit: 'tbs' },
      { ingredientId: 'instant-coffee', qty: 0.625, unit: 'tsp' },
    ],
    // Decomposition for batch planning (used instead of the flat list above
    // when aggregating, so the brownie egg rule can be applied once):
    components: [
      { recipeId: 'cookie-dough', portions: 0.5 },
      { recipeId: 'brownies', portions: 0.5 },
    ],
  },
];

export { INGREDIENTS, RECIPES };
