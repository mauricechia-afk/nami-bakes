-- Nami Bakes — Supabase (Postgres) schema
-- Run in Supabase SQL Editor, or: supabase db push (see README).
-- Data is server-side in Postgres. The local JSON file (data/db.json)
-- is only a fallback for local testing before Supabase is connected.

create table if not exists ingredients (
  id text primary key,
  name text not null,
  unit text not null,
  current numeric not null default 0,
  min numeric not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists recipes (
  id text primary key,
  name text not null,
  kind text not null default 'base', -- base | composite
  description text default '',
  yields numeric not null default 1,
  yield_unit text default 'portions',
  -- ingredients: JSON array [{ingredientId, qty, unit}] per portion
  ingredients jsonb not null default '[]'::jsonb,
  -- components: JSON array [{recipeId, portions}] for composite recipes
  components jsonb not null default '[]'::jsonb,
  created_at timestamptz default now()
);

create table if not exists bake_plans (
  id text primary key,
  name text not null,
  date date not null,
  items jsonb not null default '[]'::jsonb, -- [{recipeId, qty}]
  status text not null default 'planned', -- planned | completed
  created_at timestamptz default now(),
  completed_at timestamptz
);

create table if not exists dough_batches (
  id text primary key,
  date date not null,
  portions_made numeric not null,
  portions_baked_now numeric not null,
  portions_frozen numeric not null,
  balls_added numeric not null,
  created_at timestamptz default now()
);

-- Row Level Security: single-user bakery app. Enable RLS and allow
-- authenticated users full access. If you add more users later, scope
-- these policies by auth.uid().
alter table ingredients enable row level security;
alter table recipes enable row level security;
alter table bake_plans enable row level security;
alter table dough_batches enable row level security;

-- Drop first so re-running this file is safe.
drop policy if exists "authenticated full access" on ingredients;
drop policy if exists "authenticated full access" on recipes;
drop policy if exists "authenticated full access" on bake_plans;
drop policy if exists "authenticated full access" on dough_batches;

create policy "authenticated full access" on ingredients
  for all to authenticated using (true) with check (true);
create policy "authenticated full access" on recipes
  for all to authenticated using (true) with check (true);
create policy "authenticated full access" on bake_plans
  for all to authenticated using (true) with check (true);
create policy "authenticated full access" on dough_batches
  for all to authenticated using (true) with check (true);

-- Optional: allow anonymous read for a public demo only. Do NOT enable
-- this for the real bakery app — keep data private.
-- create policy "anon read" on ingredients for select to anon using (true);
