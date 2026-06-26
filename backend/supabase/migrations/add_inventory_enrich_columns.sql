-- Columns for the daily "enrich from offers" pass (price/category/listing/free
-- shipping come from the eBay Offer, not the inventory item) plus the owning
-- account, and a separate throttle timestamp for the daily enrichment.
-- Idempotent: safe to re-run.

alter table public."eBay_inventory"
  add column if not exists user_id       uuid,
  add column if not exists "Listing_id"  text,
  add column if not exists "Category_id" text;

alter table public.inventory_sync_state
  add column if not exists last_enriched_at timestamptz;
