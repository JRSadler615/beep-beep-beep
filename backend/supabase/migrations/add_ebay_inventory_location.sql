-- Adds the ebay_inventory_location table (ship-from address for eBay publishing).
-- Idempotent: safe to re-run. Mirrors the block added to schema.sql.

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

-- updated_at auto-touch trigger
drop trigger if exists set_updated_at on public.ebay_inventory_location;
create trigger set_updated_at before update on public.ebay_inventory_location
  for each row execute function public.set_updated_at();

-- Row-Level Security (defense-in-depth; backend uses service role)
alter table public.ebay_inventory_location enable row level security;
drop policy if exists owner_all on public.ebay_inventory_location;
create policy owner_all on public.ebay_inventory_location
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
