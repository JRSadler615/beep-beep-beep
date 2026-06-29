-- Beep Beep — Supabase schema
-- Translated from the Prisma schema (prisma/schema.prisma).
--
-- Differences from Prisma:
--   * User/Account/Session/VerificationToken are dropped — Supabase GoTrue
--     (auth.users) owns identity now. Every table references auth.users(id).
--   * Names are snake_case (what the FastAPI handlers query).
--   * PKs are uuid (gen_random_uuid) instead of cuid text.
--
-- Apply via the Supabase SQL editor or `psql "$SUPABASE_DB_URL" -f schema.sql`.
-- Safe to re-run (IF NOT EXISTS / OR REPLACE).

-- updated_at auto-touch -------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Helper to attach the trigger ------------------------------------------------
-- (Postgres has no "create trigger if not exists"; drop-then-create per table.)

-- ebay_tokens -----------------------------------------------------------------
create table if not exists public.ebay_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null unique references auth.users(id) on delete cascade,
  access_token  text not null,
  refresh_token text,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- sku_settings ----------------------------------------------------------------
create table if not exists public.sku_settings (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null unique references auth.users(id) on delete cascade,
  next_sku_counter integer not null default 1,
  sku_prefix       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ebay_business_policies ------------------------------------------------------
create table if not exists public.ebay_business_policies (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null unique references auth.users(id) on delete cascade,
  payment_policy_id       text,
  payment_policy_name     text,
  return_policy_id        text,
  return_policy_name      text,
  fulfillment_policy_id   text,
  fulfillment_policy_name text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- banned_keywords -------------------------------------------------------------
create table if not exists public.banned_keywords (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  keyword    text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, keyword)
);
create index if not exists banned_keywords_user_id_idx on public.banned_keywords (user_id);

-- discount_settings -----------------------------------------------------------
create table if not exists public.discount_settings (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null unique references auth.users(id) on delete cascade,
  discount_amount double precision not null default 3.0,
  minimum_price   double precision not null default 4.0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- override_description_settings -----------------------------------------------
create table if not exists public.override_description_settings (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null unique references auth.users(id) on delete cascade,
  use_override_description boolean not null default false,
  override_description     text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- edit_mode_settings ----------------------------------------------------------
create table if not exists public.edit_mode_settings (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null unique references auth.users(id) on delete cascade,
  default_edit_mode boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- seller_note_settings --------------------------------------------------------
create table if not exists public.seller_note_settings (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null unique references auth.users(id) on delete cascade,
  enable_seller_note_editing  boolean not null default false,
  seller_note_text            text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- offer_settings --------------------------------------------------------------
create table if not exists public.offer_settings (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null unique references auth.users(id) on delete cascade,
  allow_offers         boolean not null default false,
  minimum_offer_amount double precision not null default 10.0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- ebay_inventory_location -----------------------------------------------------
-- Ship-from address used to auto-create an eBay inventory location (required to
-- publish offers). Entered once by the user; reused on every listing.
create table if not exists public.ebay_inventory_location (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null unique references auth.users(id) on delete cascade,
  merchant_location_key text not null default 'default-location',
  address_line1         text not null,
  address_line2         text,
  city                  text not null,
  state_or_province     text not null,
  postal_code           text not null,
  country               text not null default 'US',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- all_item_catalog ------------------------------------------------------------
-- Append-only per-item analytics history: one row for every physical item ever
-- listed or added to inventory (a listing of qty 2 => 2 rows). Permanent (unlike
-- the eBay_inventory mirror). Sales are assigned FIFO by Listing_date. Mixed-case
-- names match the table as created in Supabase.
create table if not exists public.all_item_catalog (
  "Unique_item_ID"             uuid primary key default gen_random_uuid(),
  "SKU"                        text,
  "UPC"                        numeric not null,
  "Title"                      text,
  "Type"                       text,
  "Year"                       text,
  "Genres"                     text,
  "Rated"                      text,
  "Artist"                     text,
  "Listing_date"               timestamptz,
  "Status"                     text,
  "Initial_price"              numeric,
  "Price_change_since_listing" numeric,
  "Times_price_changed"        numeric,
  "Sale_date"                  timestamptz,
  "Sale_price"                 numeric,
  "Time_listed"                numeric,
  "Last_update"                timestamptz,
  "Free_shipping"              boolean default false,
  "Duplicate_when_listed"      boolean default false
);
create index if not exists all_item_catalog_unsold_idx
  on public.all_item_catalog ("SKU", "Listing_date") where "Sale_date" is null;
create index if not exists all_item_catalog_upc_idx on public.all_item_catalog ("UPC");

-- eBay_inventory --------------------------------------------------------------
-- Global (single-seller) mirror of the eBay inventory, kept current by the
-- backend startup sync and by listing/increase actions. Speeds up the
-- product-search duplicate check (a local UPC lookup instead of paging the eBay
-- Inventory API). Mixed-case names match the table as created in Supabase.
-- SKU/UPC/Title/Inventory/user_id come from the inventory sync; Current_price/
-- Category_id/Listing_id/Free_shipping come from the daily "enrich from offers"
-- pass (those live on the eBay Offer, not the inventory item).
create table if not exists public."eBay_inventory" (
  "UPC"           numeric not null,
  "Type"          text,
  "SKU"           text primary key,
  "Inventory"     numeric,
  "Current_price" numeric,
  "Free_shipping" boolean,
  "Title"         text,
  user_id         uuid,
  "Listing_id"    text,
  "Category_id"   text
);
create index if not exists ebay_inventory_upc_idx on public."eBay_inventory" ("UPC");

-- inventory_sync_state --------------------------------------------------------
-- Single-row table holding the last inventory sync + last enrichment times,
-- used to throttle the startup sync (10 min) and the daily offer enrichment.
create table if not exists public.inventory_sync_state (
  id                     integer primary key default 1,
  last_synced_at         timestamptz,
  last_enriched_at       timestamptz,
  last_orders_checked_at timestamptz,
  constraint inventory_sync_state_singleton check (id = 1)
);

-- processed_sale_lineitems ----------------------------------------------------
-- Exactly-once guard for sales detection: every eBay order line item already
-- recorded as a sale in all_item_catalog, so overlapping order polls never
-- double-count.
create table if not exists public.processed_sale_lineitems (
  line_item_id text primary key,
  order_id     text,
  sku          text,
  recorded_at  timestamptz not null default now()
);

-- media_type_dimension_defaults -----------------------------------------------
-- Per-media-type default package dimensions/weight, used to pre-fill the listing
-- form when the catalog has no value for an item. One row per (user, media_type).
create table if not exists public.media_type_dimension_defaults (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  media_type        text not null,
  height            double precision,
  width             double precision,
  depth             double precision,
  dimension_units   text,
  weight            double precision,
  weight_units      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, media_type)
);
create index if not exists media_type_dimension_defaults_user_id_idx
  on public.media_type_dimension_defaults (user_id);

-- updated_at triggers ---------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'ebay_tokens','sku_settings','ebay_business_policies','banned_keywords',
    'discount_settings','override_description_settings','edit_mode_settings',
    'seller_note_settings','offer_settings','ebay_inventory_location',
    'media_type_dimension_defaults'
  ] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at before update on public.%I
       for each row execute function public.set_updated_at()', t);
  end loop;
end$$;

-- Atomic SKU counter claim ----------------------------------------------------
-- Replaces the Prisma "upsert with increment" so concurrent listing requests
-- can never claim the same counter. Returns the value THIS caller claimed
-- (post-increment minus one), plus the prefix. Called via supabase.rpc().
create or replace function public.claim_sku_counter(p_user_id uuid)
returns table(claimed_counter integer, prefix text)
language plpgsql security definer as $$
declare
  v_counter integer;
  v_prefix  text;
begin
  insert into public.sku_settings (user_id, next_sku_counter, sku_prefix)
  values (p_user_id, 2, null)
  on conflict (user_id)
    do update set next_sku_counter = public.sku_settings.next_sku_counter + 1
  returning next_sku_counter, sku_prefix into v_counter, v_prefix;

  claimed_counter := v_counter - 1;   -- first insert -> 2-1 = 1
  prefix := coalesce(v_prefix, 'SKU');
  return next;
end;
$$;

-- Row-Level Security ----------------------------------------------------------
-- The FastAPI backend uses the service-role key, which bypasses RLS; it scopes
-- every query by user_id explicitly. These policies are defense-in-depth so
-- that any access with the anon/user key (e.g. a direct Supabase client) can
-- only ever touch the caller's own rows.
do $$
declare t text;
begin
  foreach t in array array[
    'ebay_tokens','sku_settings','ebay_business_policies','banned_keywords',
    'discount_settings','override_description_settings','edit_mode_settings',
    'seller_note_settings','offer_settings','ebay_inventory_location',
    'media_type_dimension_defaults'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format(
      'create policy owner_all on public.%I
       for all to authenticated
       using (user_id = auth.uid())
       with check (user_id = auth.uid())', t);
  end loop;
end$$;
