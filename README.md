# Mise en Place — Nami Bakes

A standalone bakery app for Maurice / Nami Bakes: inventory, recipes, batch planning, and a weekly shopping list, with an MCP server so any LLM can use it, not just Muse.

Live at https://nami-bakes-production.up.railway.app

It replaces the old Netlify app, which stored data in each browser's localStorage, so every device saw different numbers. This app stores data on the server, so every device sees the same stock.

## How it works

- **Inventory:** 15 ingredients. Every quantity and minimum is adjustable. Add an ingredient here first, then use it in a recipe.
- **Recipes:** Cookie dough, Brownies, Cookies (from balls), Brookie. Add and edit recipes. Ingredients are picked from the Inventory dropdown, so a misspelt or missing ingredient cannot be saved. The server rejects any recipe that uses an ingredient not in Inventory.
- **Batch Planning:** Plan finished items in any quantity, including fractions. Composite items are broken down into base sub-recipes, aggregated, and shown scaled for baking in one go. Saved plans can be edited or deleted while still planned. Completing a plan deducts stock; deleting a completed plan does not put stock back.
- **Cookie dough:** Made inside a bake plan, in whole batches. All dough becomes frozen balls, except the part used for brookies (0.5 batch per brookie). 1 batch = 12 balls (usually 13, count as 12).
- **Shopping List:** Weekly restock for the Friday shop. Tick an item, enter how much you bought in any unit, confirm, and stock updates. Conversions are built in, including instant coffee at 1 tsp = 1.6 g (BONCAFE, weighed). Copy List / Export CSV are kept.
- **MCP server:** Streamable HTTP at `/mcp`, official MCP SDK, 16 tools. See `mcp/README.md`.

## Key rules

- **Brownie egg rule:** aggregate brownie portions across all planned items first, then 3 eggs per whole portion, plus 2 eggs for a 0.5 remainder. 0.5 = 2, 1.0 = 3, 1.5 = 5, 2.0 = 6. A single Brookie = 2.5 eggs total.
- **Cookie dough:** 1 portion = 1 full batch = 12 balls. A batch deducts the recipe once, not 12 times.
- **Cookie dough coffee:** 0.25 tsp instant coffee per batch, added 2026-11-16 for flavour, to bring out the chocolate and toastiness. A brookie therefore uses 0.625 tsp of coffee in total.
- Quantities are rounded to 3 decimals, so Baking Soda shows 7.56 tsp, never `7.559999999999916`.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
# MCP: http://localhost:3000/mcp
```

Data is saved in `data/db.json`, created on first run and seeded with the inventory and recipes in `lib/seed.js`. That seed is only the starting point for a fresh install. Live data is never overwritten by a redeploy, it lives in the Railway volume. Delete `data/db.json` locally to reset to the seed.

Optional: set `NAMI_API_KEY` in the environment to require an `x-api-key` header for writes and MCP calls. It is not set on the live app yet, so keep the live URL private.

## Test

```bash
npm test
```

Runs against a temporary database, never the live app. 100 checks: health, inventory, the egg rule, dough to balls, plan edit and delete, shopping list and restock conversions, recipe ingredient validation, the frontend, and MCP `initialize` / `tools/list` / `tools/call`.

## Project structure

```
server.js            Node server: static frontend + REST API + MCP server
lib/calc.js          Maths: scaling, egg rule, sub-recipes, shopping list, purchase conversions
lib/seed.js          Inventory + recipes used to seed a fresh install
lib/store.js         Server-side JSON store
public/              Frontend (index.html, app.js, style.css) — 4 tabs
supabase/schema.sql  Postgres tables + RLS (parallel copy of the data, not the backend store)
supabase/seed.sql    Same data as SQL. Do not re-run after live use, it resets stock.
mcp/README.md        How any MCP client connects
netlify.toml         Frontend deploy config (static publish = public/)
test/verify.js       Automated verification (npm test)
```

## REST API

- `GET /api/health`, `GET /api/inventory`, `POST /api/inventory`, `PATCH /api/inventory/:id`, `DELETE /api/inventory/:id`
- `GET /api/recipes`, `POST /api/recipes`, `PATCH /api/recipes/:id`, `DELETE /api/recipes/:id`
- `POST /api/plan` `{items:[{recipeId, qty}], dough:{batchesMade}}`
- `GET/POST /api/bake-plans`, `PATCH /api/bake-plans/:id`, `DELETE /api/bake-plans/:id`, `POST /api/bake-plans/:id/complete`
- `POST /api/make-dough` `{batchesMade}` (kept for compatibility)
- `POST /api/restock` `{ingredientId, amount, unit}`
- `GET /api/shopping-list`, `GET /api/shopping-list.csv`

## Deployment (settled)

- **Backend: Railway, live.** Code is on GitHub at https://github.com/mauricechia-afk/nami-bakes, Railway redeploys on each commit. Data is in a Railway volume mounted at `/app/data`, so stock survives redeploys.
- **Database: Supabase, done.** Tables and seed data were created 2026-11-16. It holds a parallel copy of the data; the backend currently reads its JSON store, not Supabase directly.
- **Frontend: Netlify, not done.** The frontend is already served from Railway at the live URL above, so this is optional. `netlify.toml` publishes `public` and has a `YOUR-BACKEND-URL` placeholder to replace if Netlify is used.
- **Upload a new version:** unzip the release, drag all files inside `app/` into the GitHub repo, commit. Railway redeploys automatically.

## Still to decide

- **Lock the app:** no API key or login is set yet, so anyone with the live URL can view and change stock. Options are a shared password via `NAMI_API_KEY`, or a login screen (Supabase Auth email magic link was suggested). Until one is chosen, keep the URL private.
- **Shopify / Zoho:** not connected to this app. Shopify is connected to Muse separately; linking orders into bake plans is a possible next step, not built here.
