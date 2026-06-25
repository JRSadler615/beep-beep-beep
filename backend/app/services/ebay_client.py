"""Port of the Next.js `lib/ebay.ts` helper.

Centralizes eBay token handling and request helpers so the route handlers
don't each re-implement the refresh flow (the same bug the TS refactor fixed).
The eBay token is stored per user in the Supabase `ebay_tokens` table.
"""

import base64
import json
import logging
from datetime import datetime, timezone

import httpx

from app.config import settings
from app.db import supabase

logger = logging.getLogger("ebay")


def debug_log(*args: object) -> None:
    """Verbose logging gated behind EBAY_DEBUG. Never log access tokens."""
    if settings.EBAY_DEBUG:
        logger.info(" ".join(str(a) for a in args))


def ebay_headers(access_token: str) -> dict[str, str]:
    """Standard headers for eBay Sell API calls."""
    return {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "Content-Language": "en-US",
        "Accept-Language": "en-US",
        "X-EBAY-C-MARKETPLACE-ID": settings.EBAY_MARKETPLACE_ID,
    }


def read_error_body(resp: httpx.Response) -> tuple[dict, str]:
    """Read an eBay error response once: parsed JSON body + raw text. eBay error
    bodies are sometimes empty or non-JSON, so this never raises."""
    text = resp.text
    try:
        return (json.loads(text) if text else {}), text
    except (ValueError, TypeError):
        return {}, text


def first_error(error_data: dict) -> dict:
    """The first entry of an eBay `errors` array, or {} if there is none."""
    errs = error_data.get("errors") or []
    return errs[0] if errs else {}


class EbayTokenError(Exception):
    """Raised when a valid eBay token can't be obtained. `needs_reconnect`
    signals the SPA should send the user back through the OAuth flow."""

    def __init__(self, message: str, status_code: int = 400, needs_reconnect: bool = False):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.needs_reconnect = needs_reconnect


async def get_valid_ebay_token(user_id: str) -> str:
    """Return a valid access token for the user, refreshing and persisting it
    if the stored one is expired. Mirrors `getValidEbayToken` in lib/ebay.ts.
    """
    row = (
        supabase.table("ebay_tokens")
        .select("*")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    token = row.data if row else None

    if not token:
        raise EbayTokenError(
            "eBay account not connected. Please connect your eBay account first.",
            status_code=400,
        )

    expires_at = datetime.fromisoformat(token["expires_at"])
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)

    if datetime.now(timezone.utc) < expires_at:
        return token["access_token"]

    refresh_token = token.get("refresh_token")
    if not refresh_token:
        raise EbayTokenError(
            "eBay token expired. Please reconnect your eBay account.",
            status_code=401,
            needs_reconnect=True,
        )

    creds = base64.b64encode(
        f"{settings.EBAY_CLIENT_ID}:{settings.EBAY_CLIENT_SECRET}".encode()
    ).decode()

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            settings.ebay_token_endpoint,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Authorization": f"Basic {creds}",
            },
            data={"grant_type": "refresh_token", "refresh_token": refresh_token},
        )

    if resp.status_code >= 400:
        logger.error("eBay token refresh failed: %s %s", resp.status_code, resp.text)
        # 400/401 => the refresh token itself is dead; delete so the user
        # is forced to reconnect. Other statuses are transient — keep it.
        if resp.status_code in (400, 401):
            supabase.table("ebay_tokens").delete().eq("user_id", user_id).execute()
            raise EbayTokenError(
                "Failed to refresh eBay token. Please reconnect your eBay account.",
                status_code=401,
                needs_reconnect=True,
            )
        raise EbayTokenError(
            "Failed to refresh eBay token. Please try again.",
            status_code=resp.status_code,
        )

    data = resp.json()
    expires = datetime.now(timezone.utc).timestamp() + data["expires_in"]
    supabase.table("ebay_tokens").update(
        {
            "access_token": data["access_token"],
            "refresh_token": data.get("refresh_token") or refresh_token,
            "expires_at": datetime.fromtimestamp(expires, tz=timezone.utc).isoformat(),
        }
    ).eq("user_id", user_id).execute()

    return data["access_token"]
