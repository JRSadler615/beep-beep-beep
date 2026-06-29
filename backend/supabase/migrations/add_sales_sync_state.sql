-- Sales detection from the eBay Fulfillment/Orders API -> all_item_catalog.
-- Tracks the last order poll (for throttling) and every order line item already
-- recorded as a sale (for exactly-once FIFO assignment across overlapping polls).
-- Idempotent: safe to re-run.

alter table public.inventory_sync_state
  add column if not exists last_orders_checked_at timestamptz;

create table if not exists public.processed_sale_lineitems (
  line_item_id text primary key,
  order_id     text,
  sku          text,
  recorded_at  timestamptz not null default now()
);
