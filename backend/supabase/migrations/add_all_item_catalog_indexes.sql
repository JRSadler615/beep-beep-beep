-- Indexes for all_item_catalog (the per-item analytics history table, created
-- manually in Supabase). Speeds up the FIFO sale assignment ("oldest unsold
-- item for a SKU") and UPC lookups. Idempotent: safe to re-run.

create index if not exists all_item_catalog_unsold_idx
  on public.all_item_catalog ("SKU", "Listing_date")
  where "Sale_date" is null;

create index if not exists all_item_catalog_upc_idx
  on public.all_item_catalog ("UPC");
