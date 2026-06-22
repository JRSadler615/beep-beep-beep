# Startup Guide

The app is two services that run together:

- **Frontend** — Vite + React SPA (`frontend/`), served at http://localhost:3000
- **Backend** — FastAPI (`backend/`), served at http://localhost:8000

Auth + database are on **Supabase**; eBay OAuth uses a **Cloudflare tunnel**
(`api.jrsadler.com` → `localhost:8000`) so eBay can reach the callback.

---

## One-time prerequisites

Already set up on the primary dev machine; needed when setting up a new machine.

- Install **Node.js**, **uv**, and **Python 3.12**.
- Create the env files (not committed — they hold secrets):
  - `backend/.env` — copy from `backend/.env.example`, fill Supabase keys
    (URL, anon, service-role, JWT secret) and eBay creds (client id/secret,
    RuName, scope).
  - `frontend/.env` — copy from `frontend/.env.example`, set the Supabase URL +
    anon key. Leave `VITE_API_URL` empty in dev (the Vite proxy handles `/api`).
- Apply the database schema: run `backend/supabase/schema.sql` in the Supabase
  SQL editor (idempotent). Ensure the `claim_sku_counter` function is applied,
  or generated SKUs always start at 1.
- eBay OAuth: register `https://api.jrsadler.com/api/ebay/callback` as the
  RuName's "auth accepted URL" in the eBay Developer Portal.

---

## Every-time startup

Start the **backend first** so the frontend's first `/api` calls succeed.

**1. Backend** (terminal 1):

```powershell
cd backend
uv run uvicorn app.main:app --reload --port 8000
```

**2. Frontend** (terminal 2):

```powershell
cd frontend
npm run dev
```

Open **http://localhost:3000**. Vite proxies `/api` → the backend on port 8000,
so you never address the backend directly.

**3. Cloudflare tunnel** — only required for the **eBay connect / OAuth** step
(so eBay can reach the callback). If `cloudflared` runs as a Windows service
it's already up; otherwise start it in terminal 3:

```powershell
cloudflared tunnel run <your-tunnel-name>
```

Product search and listing work without the tunnel once an eBay account is
connected; only the connect step needs it.

To stop: `Ctrl+C` in each terminal.

---

## Machine-specific gotchas (Windows dev box)

- **`uv` or `npm` not found:** open a fresh terminal (winget adds them to PATH
  after install). If `uv` is still missing, it's at
  `C:\Users\<you>\AppData\Local\Microsoft\WinGet\Packages\astral-sh.uv_*\uv.exe`.
- **uv tries to download Python and fails** ("Missing expected target directory
  for Python minor version link"): set the system-Python preference first —

  ```powershell
  $env:UV_PYTHON_PREFERENCE = "only-system"
  ```

  This is a known uv/Windows managed-Python bug; we use the winget-installed
  CPython 3.12 instead.
- **First-time deps:** `uv sync` in `backend/` and `npm install` in `frontend/`.

---

## Quick health checks

- Backend up: `http://localhost:8000/health` → `{"status":"ok"}`
- API docs: `http://localhost:8000/docs`
- Tunnel up: `https://api.jrsadler.com/health` → `{"status":"ok"}`
- End-to-end core chain: `uv run python smoke_test.py` in `backend/`
  (creates a throwaway user, exercises auth + a settings read/write, cleans up).

---

## Going to production

Hostnames change when deploying (dev tunnel → production hosts). Search the
codebase for change-points:

```
grep -rn "PROD HOSTNAME" frontend backend
```

Key items: `FRONTEND_URL` (backend env), `VITE_API_URL` (frontend env), and the
eBay RuName's auth-accepted URL in the Developer Portal.
