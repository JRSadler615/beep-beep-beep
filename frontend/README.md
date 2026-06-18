# Beep Beep — Frontend (Vite SPA)

React + TypeScript + Vite single-page app, replacing the Next.js frontend to
match the group stack:

| Concern        | This app                                            |
| -------------- | --------------------------------------------------- |
| Build / dev    | Vite                                                |
| Routing        | `react-router-dom` (replaces Next file routing)     |
| Auth           | Supabase GoTrue (`@supabase/supabase-js`)           |
| Backend        | FastAPI — called via `src/lib/api.ts`               |
| Hosting        | Cloudflare Workers Static Assets (SPA build output) |

The Next.js app remains at the repo root **during migration** as the source of
truth to port from. Its `app/api/**` routes are being reimplemented in the
separate FastAPI backend and are **not** ported into this SPA.

## Getting started

```bash
cd frontend
cp .env.example .env   # fill in Supabase URL + anon key
npm install
npm run dev            # http://localhost:3000, proxies /api -> :8000
```

## Migration status

**Done:**
- Vite + React 19 + TS + Tailwind v4 scaffold
- Router, app shell, `ProtectedRoute` session gate
- `AuthContext` (Supabase) replacing `next-auth`
- `lib/api.ts` — `apiFetch` (parsed + throwing) and `apiRequest` (raw
  `Response`), both attaching the Supabase bearer token
- `lib/keyword-masker.ts` and `components/ProductSearchCard.tsx` ported
- **All pages ported:** Home, Login, Signup, Dashboard, EbayConnect,
  ProductSearch, Settings

**Notes:**
- Every ported page calls `/api/*` endpoints that must be implemented in the
  FastAPI backend (the Next.js `app/api/**` route handlers are the spec).
- `noUnusedLocals` / `noUnusedParameters` are temporarily off in
  `tsconfig.json` because the ported ProductSearch page carries orphaned
  handlers from the original. Re-enable after cleanup.

## Transform rules (Next.js page → SPA page)

Apply these mechanically when porting each page:

1. Delete the `"use client"` directive.
2. `import Link from "next/link"` → `import { Link } from "react-router-dom"`;
   change the `href` prop to `to`.
3. `next/navigation`:
   - `useRouter().push(x)` → `useNavigate()(x)`
   - `usePathname()` → `useLocation().pathname`
   - `useSearchParams()` → `useSearchParams()` from `react-router-dom`
     (no `<Suspense>` wrapper needed; drop it)
4. `next-auth/react`:
   - `useSession()` → `useAuth()` from `@/context/AuthContext`
     (`session.user.email` → `user?.email`)
   - `signIn`/`signOut` → `useAuth().signIn` / `.signOut`
5. Data fetching: replace `fetch("/api/...")` with
   `apiFetch("/api/...")` from `@/lib/api` (adds the bearer token, parses
   JSON, throws on error). The path strings stay identical — the matching
   FastAPI endpoints must implement them.
6. `next/image` → plain `<img>`. `next/font` → drop (fonts via CSS).

## Backend dependency

Every ported page that calls `/api/*` needs the matching FastAPI endpoint.
The Next.js route handlers under `app/api/**` are the reference spec for those
endpoints (request/response shapes, eBay OAuth flow, token refresh).
