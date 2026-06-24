-- Adds the media_type_dimension_defaults table (per-media-type default package
-- dimensions/weight used to pre-fill listings when the catalog has no value).
-- Idempotent: safe to re-run. Mirrors the block added to schema.sql.

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

drop trigger if exists set_updated_at on public.media_type_dimension_defaults;
create trigger set_updated_at before update on public.media_type_dimension_defaults
  for each row execute function public.set_updated_at();

alter table public.media_type_dimension_defaults enable row level security;
drop policy if exists owner_all on public.media_type_dimension_defaults;
create policy owner_all on public.media_type_dimension_defaults
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
