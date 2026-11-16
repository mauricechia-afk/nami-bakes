# Nami Bakes — Bakery Pro (standalone)

A standalone bakery app for Maurice / Nami Bakes. Inventory, recipes,
batch planning, and a weekly (Friday) shopping list — with an MCP server
so **any** LLM can use it, not just Muse.

It replaces the old Netlify app (`stellar-klepon-18f761.netlify.app`),
which stored data in each browser's localStorage, so every device saw
different numbers. This app stores data **on the server** (Postgres on
Supabase when connected, a JSON file locally), so every device sees the
same stock.

## What is in here

| Area | Detail |
|---|---|
| Inventory | 15 real ingredients (from Maurice's screenshots, 2026-11-14). Every quantity and minimum is adjustable; add/delete ingredients. |
| Recipes | Cookie dough, Brownies, Cookies (from balls), Brookie (derived). Create/edit recipes, per-portion amounts. |
| Batch Planning | Plan finished items in any quantity, including fractions. Decomposes composites into base sub-recipes, aggregates, shows each sub-recipe scaled for baking in one go. |
| Cookie dough flow | Make a batch (default 1 batch), bake some cookies now, freeze the rest as balls. 1 batch = 12 balls (usually 13, count as 12). Balls add to inventory. |
| Shopping List | Weekly restock for the Friday shop: below-minimum items + projected need from planned bakes. Copy List / Export CSV. |
| MCP server | Standard MCP (Streamable HTTP) at `/mcp`, official MCP SDK. See `mcp/README.md`. |

## The brownie egg rule (important)

Aggregate brownie portions across all planned items **first**, then:
whole portions × 3 eggs, plus 2 eggs for a 0.5 remainder.

- 0.5 portion = 2 eggs · 1.0 = 3 · **1.5 = 5** · **2.0 = 6** · 2.5 = 8
- A single Brookie = 2.5 eggs total (0.5 cookie egg + 2 brownie eggs).
- All other brownie ingredients scale normally. Cookie eggs scale
  normally (1 per portion, 0.5 per half) as an accounting share.

Worked examples (verified by `npm test`):
- 1 brookie + 1 brownie = 0.5 cookie + 1.5 brownie (5 brownie eggs)
- 2 brookies + 1 brownie = 1 cookie + 2 brownie (6 brownie eggs)

## Rounding

Quantities are rounded to 3 decimals for display/storage, so
Baking Soda shows **7.56 tsp**, never `7.559999999999916`.

## Run locally (no Supabase / Netlify needed yet)

```bash
cd app
npm install
npm start
# open http://localhost:3000
# MCP: http://localhost:3000/mcp
```

Data is saved in `data/db.json` (created on first run, seeded with the
real inventory/recipes). Delete that file to reset to the seed data.

Optional: copy `.env.example` to `.env` and set `NAMI_API_KEY` to require
an `x-api-key` header for writes and MCP calls. Leave it empty for local
testing only.

## Test

```bash
npm test
```

This starts the server on a temporary database, checks health, inventory
(15 items, Baking Soda 7.56), both worked examples above (egg totals 5
and 6), a single Brookie (2.5 eggs), inventory adjust, dough-to-balls
(1 batch, 6 baked now, 6 frozen = 6 balls; 2 batches = 24 balls; a
10-batch request is refused as over stock), the shopping list, CSV export,
the frontend, and MCP `initialize` / `tools/list` / `tools/call`.

## Project structure

```
server.js            Node server: static frontend + REST API + MCP server
lib/calc.js          Shared maths: scaling, egg rule, sub-recipes, shopping list
lib/seed.js          Real inventory + recipes (source of truth for seeds)
lib/store.js         Server-side JSON store (local fallback)
public/              Frontend (index.html, app.js, style.css) — 4 tabs
supabase/schema.sql  Postgres tables + RLS
supabase/seed.sql    Same real data as SQL (generated from lib/seed.js)
mcp/README.md        How any MCP client connects
netlify.toml         Frontend deploy config (static publish = public/)
test/verify.js       Automated verification (npm test)
```

## REST API (same logic as MCP tools)

- `GET /api/health`, `GET /api/inventory`, `POST /api/inventory`, `PATCH /api/inventory/:id`, `DELETE /api/inventory/:id`
- `GET /api/recipes`, `POST /api/recipes`
- `POST /api/plan` `{items:[{recipeId, qty}]}` → sub-recipes + totals
- `GET/POST /api/bake-plans`, `POST /api/bake-plans/:id/complete` (deducts stock)
- `POST /api/make-dough` `{batchesMade, cookiesBakedNow}` — balls frozen = `batchesMade × 12 − cookiesBakedNow`. Legacy `{portionsMade, portionsBakedNow, portionsFrozen}` (in batches) is also accepted.
- `GET /api/shopping-list`, `GET /api/shopping-list.csv`

## Deploy the backend (do this after connecting Supabase/Netlify — see below)

The Node server needs a persistent host (it keeps `data/db.json`, or
talks to Supabase). Good options: Railway, Render, Fly.io, or a small
VPS. It will **not** work as a Netlify static site alone — Netlify hosts
only the frontend (`public/`).

1. Deploy `server.js` to your host with `npm install && npm start`,
   `PORT` set by the host, `NAMI_API_KEY` set to a secret value.
2. Point the frontend at it: set the API base URL in `public/config.js`
   (create this file at deploy time — it is not committed), or use the
   proxy in `netlify.toml` after replacing `YOUR-BACKEND-URL`.
3. Point any MCP client at `https://YOUR-BACKEND-URL/mcp`.

## Connect Supabase (checklist — do this with Maurice, step by step)

**Do not do this yet — Maurice will connect it with guidance in a later step.**

1. **Create a Supabase project** at https://supabase.com/dashboard
   — New project, name `nami-bakes`, pick a region near Singapore,
   set a database password and save it somewhere safe (password manager).
2. **Run the schema:** in Supabase → SQL Editor → New query → paste
   `supabase/schema.sql` → Run. Then paste `supabase/seed.sql` → Run.
   Check Table Editor: `ingredients` should show 15 rows, `recipes` 4 rows.
3. **Get the keys:** Supabase → Project Settings → API. Copy the
   Project URL and the `anon` key (and keep the `service_role` key
   secret — it bypasses RLS, only the server ever uses it).
4. **Put the keys in the server env:** on your backend host, set
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and (server only)
   `SUPABASE_SERVICE_ROLE_KEY`. Never put the service key in the
   frontend or in git.
5. **Switch the frontend to Supabase:** the frontend currently talks to
   the local Node API. When Supabase is live, the server will read/write
   Postgres instead of `data/db.json` (the data shape is identical —
   see `supabase/schema.sql`). Verify by loading the app and checking
   the same 15 ingredients appear.
6. **Keep a backup:** export the shopping list CSV weekly, and use
   Supabase's database backups before any big change.

## Connect Netlify (checklist — do this with Maurice, step by step)

**Do not do this yet — Maurice will connect it with guidance in a later step.**

1. **Push the code to a git repo** (GitHub/GitLab): create a repo,
   commit the whole `app/` folder, push it.
2. **Netlify → Add new site → Import an existing project** → connect
   the repo → pick the `app/` folder as the base directory.
3. **Build settings:** Build command — leave empty (or `echo 'Static frontend'`),
   Publish directory — `public`.
   (`netlify.toml` in the repo already sets this.)
4. **Set the backend URL:** in Netlify → Site settings → Environment
   variables, or in `public/config.js`, set the API base to your deployed
   backend URL, and in `netlify.toml` replace `YOUR-BACKEND-URL` with it.
   Without this step the site loads but cannot save — it will show an error.
5. **Deploy and open the site:** Netlify gives you a `*.netlify.app` URL.
   Open it on your phone and on your computer — you should see the same
   15 ingredients on both. That is the sync test.
6. **(Optional) Custom domain:** Netlify → Domain settings → Add a
   custom domain, e.g. `app.namibakesco.com`, and follow its DNS steps.

## How many full cookie-dough batches fit current stock? (corrected 2026-11-14)

The earlier finding that a full batch does not fit stock is **void** —
it came from the wrong model (12 portions × the per-batch recipe).
Correct model: 1 batch = 12 balls, deducting the recipe once
(Flour 195g, Brown Sugar 160g, etc.).

Batches that current stock allows, per ingredient:
- **Brown Sugar: 9 batches — the limiting ingredient** (1,440g ÷ 160g = 9 exactly)
- Flour: 12 batches (2,400g ÷ 195g)
- 54.5% Dark Chocolate Chips: 12 batches (2,260g ÷ 180g)
- Baking Soda: 15 batches (7.56 tsp ÷ 0.5 tsp)
- Eggs: 22 batches
- Vanilla extract: 27 batches
- Unsalted Butter: 34 batches
- White Sugar: 55 batches
- 70.5% Dark Chocolate Chips: 60 batches
- Sea Salt Flakes: 327 batches

So **9 full batches** fit before brown sugar runs out. The app still
refuses a batch that exceeds stock (e.g. 10 batches need 1,600g brown
sugar) and says which ingredient is short, instead of letting stock
go negative.

## What still needs a decision

- **Backend host:** Railway / Render / Fly.io / VPS — pick one when
  deploying (see above). The code is host-agnostic.
- **Supabase auth:** the schema uses RLS for authenticated users. The
  frontend currently has no login screen — add Supabase Auth (email
  magic link is simplest for a single user) before putting real data
  on the public internet, or keep the app behind the `NAMI_API_KEY`.
- **Shopify / Zoho:** not connected to this app yet. Shopify is already
  connected to Muse separately; linking Shopify orders into bake plans
  is a possible next step, not built here.
