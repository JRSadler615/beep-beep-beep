"""eBay endpoints.

`/api/ebay/check-connection` is fully implemented as the reference pattern.
The data endpoints are stubbed; implement each from the matching Next.js
handler under `app/api/ebay/**`, using `get_valid_ebay_token` +
`ebay_headers` from `services/ebay_client.py`.
"""

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse

from app.auth import get_user_id
from app.config import settings
from app.db import supabase
from app.services.ebay_client import (
    EbayTokenError,
    ebay_headers,
    get_valid_ebay_token,
)

router = APIRouter(prefix="/api/ebay", tags=["ebay"])


# ---------------------------------------------------------------------------
# check-connection — fully implemented reference
# Spec: app/api/ebay/check-connection/route.ts
# ---------------------------------------------------------------------------


@router.get("/check-connection")
def check_connection(user_id: str = Depends(get_user_id)):
    row = (
        supabase.table("ebay_tokens")
        .select("user_id")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    return {"connected": bool(row and row.data)}


@router.post("/disconnect")
def disconnect(user_id: str = Depends(get_user_id)):
    supabase.table("ebay_tokens").delete().eq("user_id", user_id).execute()
    return {"success": True}


# ---------------------------------------------------------------------------
# OAuth flow — full-page redirects, so they can't use a Bearer header.
# `connect` is authed (the SPA fetches the URL, then redirects); `callback`
# is hit by eBay and trusts the signed `state` param.
# Spec: app/api/ebay/connect/route.ts, app/api/ebay/callback/route.ts
# ---------------------------------------------------------------------------


@router.get("/connect")
def connect(user_id: str = Depends(get_user_id)):
    """Build the eBay authorize URL and redirect. The SPA hits this with the
    bearer token (XHR follows the redirect) OR, preferably, change the SPA to
    fetch a JSON {url} and redirect itself. See README OAuth note.
    """
    if not settings.EBAY_CLIENT_ID or not settings.EBAY_RUNAME:
        return RedirectResponse(f"{settings.FRONTEND_URL}/ebay-connect?error=missing_credentials")
    # TODO: build authorize URL with scope + state=user_id (see connect/route.ts)
    raise HTTPException(status_code=501, detail="connect not implemented")


@router.get("/callback")
def callback(code: str = Query(...), state: str = Query(...)):
    # TODO: exchange `code` for tokens, upsert into ebay_tokens for the user in
    # `state`, then RedirectResponse to FRONTEND_URL/ebay-connect?success=true
    raise HTTPException(status_code=501, detail="callback not implemented")


# ---------------------------------------------------------------------------
# Data endpoints — stubs. Implement from the matching Next.js handlers.
# Example of the intended pattern is shown in `search` below.
# ---------------------------------------------------------------------------


@router.get("/search")
async def search(upc: str = Query(...), user_id: str = Depends(get_user_id)):
    """Reference pattern for an authenticated eBay call. Spec:
    app/api/ebay/search/route.ts (Browse API item_summary/search)."""
    try:
        access_token = await get_valid_ebay_token(user_id)
    except EbayTokenError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)

    url = f"{settings.ebay_base_url}/buy/browse/v1/item_summary/search"
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            url,
            params={"q": upc, "fieldgroups": "EXTENDED"},
            headers=ebay_headers(access_token),
        )
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail="Failed to search eBay")
    # TODO: port the mean-price + image-enrichment logic from search/route.ts
    return resp.json()


@router.get("/check-duplicate")
async def check_duplicate(upc: str = Query(...), user_id: str = Depends(get_user_id)):
    # TODO: app/api/ebay/check-duplicate/route.ts
    raise HTTPException(status_code=501, detail="check-duplicate not implemented")


@router.get("/policies")
async def policies(user_id: str = Depends(get_user_id)):
    # TODO: app/api/ebay/policies/route.ts (parallel fulfillment/payment/return)
    raise HTTPException(status_code=501, detail="policies not implemented")


@router.get("/validate-listing")
async def validate_listing(categoryId: str = Query(...), user_id: str = Depends(get_user_id)):
    # TODO: app/api/ebay/validate-listing/route.ts
    raise HTTPException(status_code=501, detail="validate-listing not implemented")


@router.post("/list")
async def list_item(user_id: str = Depends(get_user_id)):
    # TODO: app/api/ebay/list/route.ts (the big one — inventory item, offer,
    # publish, atomic SKU claim, best-offer handling)
    raise HTTPException(status_code=501, detail="list not implemented")


@router.post("/increase-inventory")
async def increase_inventory(user_id: str = Depends(get_user_id)):
    # TODO: app/api/ebay/increase-inventory/route.ts
    raise HTTPException(status_code=501, detail="increase-inventory not implemented")
