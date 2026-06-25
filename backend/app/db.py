"""Supabase database client.

Exposes a single service-role `supabase` client (and the cached `get_db`
factory) used by every backend query. Because the service role bypasses RLS,
callers must always scope queries by the authenticated user id.
"""

from functools import lru_cache

from supabase import Client, create_client

from app.config import settings


@lru_cache
def get_db() -> Client:
    """Supabase client using the service-role key.

    Server-side only — the service role bypasses Row-Level Security, so every
    query MUST be scoped explicitly by user id (e.g. `.eq("user_id", user_id)`)
    using the id returned from `get_user_id`. Never expose this key or client
    to the frontend.
    """
    return create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)


# Convenience singleton for imports: `from app.db import supabase`
supabase: Client = get_db()


def fetch_one(table: str, user_id: str) -> dict | None:
    """Return the user's single row for a per-user table, or None.

    Most settings tables hold one row per user; this is the shared read used by
    both the settings router and the listing service. The service role bypasses
    RLS, so the `user_id` scope here is the security boundary — never drop it.
    """
    res = supabase.table(table).select("*").eq("user_id", user_id).limit(1).execute()
    rows = res.data or []
    return rows[0] if rows else None
