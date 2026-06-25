# Beep Beep

Marketplace operations dashboard for eBay sellers. Connect an eBay account,
search products by UPC, and create listings with safety checks — with control
over SKUs, pricing, dimensions/weight, item specifics, and keyword filters.

## Architecture

Two services that run together (see [STARTUP.md](STARTUP.md) for setup/run):

| Layer | Stack | Location | Dev URL |
|-------|-------|----------|---------|
| **Frontend** | Vite + React + Tailwind (SPA) | [`frontend/`](frontend/) | http://localhost:3000 |
| **Backend** | FastAPI (Python 3.12, `uv`) | [`backend/`](backend/) | http://localhost:8000 |

- **Auth & database:** Supabase (GoTrue auth + Postgres). The backend uses the
  service-role key and verifies the caller's Supabase JWT on every request.
- **eBay:** OAuth connect/callback plus the Browse, Inventory, Offer, Account,
  and Taxonomy APIs. Local OAuth callbacks reach the backend via a **Cloudflare
  tunnel** (`api.jrsadler.com` → `localhost:8000`).
- In dev, the Vite server proxies `/api/*` to the FastAPI backend, so the SPA
  uses same-origin relative paths.

## Features

- **Auth** — email/password via Supabase; protected app shell with a session gate.
- **eBay connect** — OAuth connect/disconnect; tokens stored in Supabase and
  auto-refreshed.
- **Product search by UPC** — eBay Browse API (typed or camera-scanned UPC),
  scoped to the selected media type's category; price shown is the mean of the
  latest comps; best-match photo pulled in.
- **In-house catalogs** — per-media-type UPC catalogs (`dvd_`, `cd_`, `vhs_`,
  `cassette_upc_catalog`) auto-populate the listing form and are updated on
  listing. Fields include title, year, publisher, genre, rating, length, artist
  (CD/Cassette), and package dimensions/weight.
- **Listing workflow** — inline editing; configurable discount engine with a
  minimum-price floor; per-user SKU generation; saved business policies; package
  dimensions/weight (`packageWeightAndSize`); single-photo listings.
- **Item specifics** — auto-maps Format, the title aspect (Movie/TV Title or
  Release Title), Artist, and Genre; validates Genre against eBay's allowed
  values with a "did you mean / SKIP" prompt; auto-adopts eBay's suggested
  specifics where confident; otherwise prompts via a guided form.
- **Inventory location** — auto-creates the required eBay ship-from location
  from a saved address.
- **Settings** — SKU, business policies, inventory location, per-media-type
  dimension/weight defaults, banned keywords, discount, default edit mode,
  universal seller note, override description, and Best Offer.

## Repository layout

```
frontend/   Vite + React SPA (pages, components, context, lib)
backend/    FastAPI app (routers, services, Supabase schema + migrations)
STARTUP.md  Prerequisites and every-time startup steps
start.bat   Windows one-click launcher (tunnel + backend + frontend + browser)
```

## Quick start

On Windows, double-click [`start.bat`](start.bat) — it ensures the Cloudflare
tunnel service is up, starts the backend (`--reload`) and frontend (HMR) in
their own windows, and opens the browser to the app.

Manual startup (and one-time prerequisites — env files, Supabase schema, eBay
RuName) is documented in [STARTUP.md](STARTUP.md). In short:

```powershell
# backend (terminal 1)
cd backend
uv run uvicorn app.main:app --reload --port 8000

# frontend (terminal 2)
cd frontend
npm run dev
```

Then open http://localhost:3000. The Cloudflare tunnel is only needed for the
eBay connect / OAuth step.

## eBay notes & gotchas

- **Scopes** — missing `sell.inventory` / `sell.account` causes Error 2004; the
  app prompts you to disconnect and reconnect with the right scopes.
- **RuName / redirect URI** — `EBAY_RUNAME` must match exactly what's registered
  in the eBay Developer Portal, or token exchange fails (`redirect_uri_mismatch`).
- **Seller account** — eBay requires completed seller registration before
  listing; an unregistered account returns a "create a seller's account" error.
- **Business policies / location** — listings need fulfillment/payment/return
  policies and an inventory location; the app auto-creates the location from your
  saved address and surfaces clear hints for the rest.

> This project was migrated from a Next.js monolith to the Vite + FastAPI stack
> above. The legacy Next.js code is retained on the `archive/nextjs-main` branch.
