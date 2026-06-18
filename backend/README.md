# Beep Beep — Backend (FastAPI)

Python + FastAPI API for the Vite SPA. Auth via Supabase (GoTrue JWT
verification), data in Supabase Postgres, eBay Sell/Browse API integration.

## Stack fit

| Concern        | This service                                   |
| -------------- | ---------------------------------------------- |
| Framework      | FastAPI (uv-managed)                           |
| Auth           | Verifies Supabase GoTrue JWT (`app/auth.py`)   |
| DB             | Supabase Postgres via `supabase-py` (`app/db.py`) |
| eBay           | `app/services/ebay_client.py` (port of `lib/ebay.ts`) |
| Secrets        | Doppler in prod; local `.env`                  |
| Host           | Hetzner + systemd; workers under `app/workers/` |

## Getting started

```bash
cd backend
cp .env.example .env          # fill in Supabase + eBay values
uv sync                       # create venv + install deps
uv run uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000/docs for the auto-generated API explorer.
The Vite dev server proxies `/api` to `:8000` (see frontend/vite.config.ts).

## What's implemented vs. stubbed

**Working reference implementations** (copy these patterns):
- `GET /health`
- `GET /api/ebay/check-connection`, `POST /api/ebay/disconnect`
- `GET /api/ebay/search` (authed eBay call pattern)
- `GET/POST /api/settings/sku` (+ `/counter`, `/prefix`) — DB read/write pattern
- `app/auth.py` — Supabase JWT verification dependency
- `app/services/ebay_client.py` — token refresh + headers

**Stubbed** (return defaults or HTTP 501; implement from the Next.js handler
named in each `# TODO`):
- `/api/ebay/connect`, `/callback`, `/check-duplicate`, `/policies`,
  `/validate-listing`, `/list`, `/increase-inventory`
- `/api/settings/{banned-keywords,discount,edit-mode,override-description,
  seller-note,offers,ebay-policies}`

The Next.js `app/api/**` route handlers at the repo root are the spec for
request/response shapes and eBay logic.

## Design notes

- **Auth:** the SPA sends `Authorization: Bearer <supabase-jwt>`; `get_user_id`
  verifies it with `SUPABASE_JWT_SECRET` and returns the user uuid. There is no
  signup/login endpoint — GoTrue handles that client-side.
- **Database / RLS:** `app/db.py` uses the service-role key (bypasses RLS), so
  **every query must be scoped by `user_id`**. Tables map from the Prisma
  schema; `User`/`Account`/`Session` are replaced by Supabase `auth.users`, and
  the other tables should reference `auth.users(id)` with RLS policies
  (`user_id = auth.uid()`). Expected table names (snake_case): `ebay_tokens`,
  `sku_settings`, `banned_keywords`, `discount_settings`, `edit_mode_settings`,
  `override_description_settings`, `seller_note_settings`, `offer_settings`,
  `ebay_business_policies`.
- **OAuth redirects:** `/api/ebay/connect` and `/callback` are full-page
  navigations and can't carry a Bearer header. Preferred approach: change the
  SPA to `fetch` an authed endpoint that returns the eBay authorize URL, then
  redirect itself; the `state` param carries the user id into `/callback`.

## Suggested order

1. Create the Supabase tables (adapt the Prisma init migration).
2. Wire one real call end-to-end: SPA → `check-connection` → Supabase.
3. Settings endpoints (simple CRUD).
4. eBay read endpoints (`search`, `policies`, `check-duplicate`).
5. OAuth (`connect`/`callback`/`disconnect`).
6. `list` / `increase-inventory` (heaviest logic).
