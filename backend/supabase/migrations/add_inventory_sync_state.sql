-- Tracks the last time the local eBay_inventory mirror was synced from eBay, so
-- the backend can throttle the startup sync (avoid re-syncing on every dev
-- --reload). Single-row table (id = 1). Idempotent: safe to re-run.

create table if not exists public.inventory_sync_state (
  id             integer primary key default 1,
  last_synced_at timestamptz,
  constraint inventory_sync_state_singleton check (id = 1)
);
