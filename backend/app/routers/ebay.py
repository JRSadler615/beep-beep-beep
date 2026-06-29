"""eBay endpoints.

OAuth connect/callback/disconnect, plus the data endpoints (search,
check-duplicate, policies, validate-listing, list, increase-inventory). Each
data endpoint uses `get_valid_ebay_token` + `ebay_headers` from
`services/ebay_client.py`; the heavier flows (search, list, increase-inventory)
delegate to the matching `services/*` module.
"""

import asyncio
import base64
import json
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx
import jwt
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse

from app.auth import get_user_id
from app.config import settings
from app.db import supabase
from app.services.ebay_client import (
    EbayTokenError,
    ebay_headers,
    get_valid_ebay_token,
)
from app.services.inventory import increase_inventory as _increase_inventory
from app.services.all_item_catalog import (
    append_inventory_increase,
    append_new_listing,
)
from app.services.inventory_db import (
    find_duplicates_by_upc,
    record_listing,
    set_quantity,
)
from app.services.listing import create_listing as _create_listing
from app.services.media import media_config
from app.services.search import search_product as _search_product

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


@router.get("/media-config")
def get_media_config(user_id: str = Depends(get_user_id)):
    """Canonical media-type maps (category ids, Format / title item specifics,
    catalog-backed types) for the SPA. Backed by `services/media.py` so the
    backend is the single source of truth; the frontend mirrors this."""
    return media_config()


# ---------------------------------------------------------------------------
# OAuth flow
#
# A full-page redirect to eBay can't carry the Supabase Bearer header, so the
# flow is split:
#   1. GET /connect-url  (authed) -> the SPA fetches the eBay authorize URL and
#      redirects the browser itself. The user id is embedded in a short-lived
#      signed `state` token.
#   2. GET /callback     (public) -> eBay redirects the browser here (this is
#      the "auth accepted URL" registered against the RuName). We verify the
#      signed state to recover the user id, exchange the code for tokens, store
#      them, and redirect back to the SPA.
# Spec: app/api/ebay/connect/route.ts, app/api/ebay/callback/route.ts
# ---------------------------------------------------------------------------

_STATE_TTL = timedelta(minutes=10)


def _sign_state(user_id: str) -> str:
    """Tamper-proof state param. The callback has no session, so the user id
    must travel in a signed token rather than a plain string."""
    return jwt.encode(
        {"sub": user_id, "exp": datetime.now(tz=timezone.utc) + _STATE_TTL},
        settings.SUPABASE_JWT_SECRET,
        algorithm="HS256",
    )


def _verify_state(state: str) -> str | None:
    try:
        return jwt.decode(state, settings.SUPABASE_JWT_SECRET, algorithms=["HS256"])["sub"]
    except jwt.PyJWTError:
        return None


@router.get("/connect-url")
def connect_url(user_id: str = Depends(get_user_id)):
    """Return the eBay OAuth authorize URL for the SPA to redirect to."""
    if not settings.EBAY_CLIENT_ID or not settings.EBAY_CLIENT_SECRET:
        raise HTTPException(status_code=400, detail="eBay API credentials not configured")
    ru_name = (settings.EBAY_RUNAME or "").strip()
    if not ru_name:
        raise HTTPException(status_code=400, detail="EBAY_RUNAME not configured")
    if "sell.inventory" not in settings.EBAY_SCOPE:
        raise HTTPException(status_code=400, detail="EBAY_SCOPE missing sell.inventory")

    params = {
        "client_id": settings.EBAY_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": ru_name,  # the RuName; eBay resolves it to the accepted URL
        "scope": settings.EBAY_SCOPE,
        "state": _sign_state(user_id),
        "prompt": "login",
    }
    return {"url": f"{settings.ebay_authorize_url}?{urlencode(params)}"}


@router.get("/callback")
# PROD HOSTNAME: this endpoint's PUBLIC URL is the eBay RuName "auth accepted
# URL". It must be registered in the eBay Developer Portal and matches the
# backend's public host: the Cloudflare Tunnel host in dev, the production
# backend domain (e.g. https://api.jrsadler.com/api/ebay/callback) in prod.
# The hostname is not referenced here — only registered with eBay — but it
# changes per environment, so update the portal when the backend host changes.
async def callback(
    code: str | None = Query(None),
    state: str | None = Query(None),
    error: str | None = Query(None),
):
    fe = settings.FRONTEND_URL.rstrip("/")

    def redirect_error(kind: str) -> RedirectResponse:
        return RedirectResponse(f"{fe}/ebay-connect?error={kind}")

    if error:
        return redirect_error("oauth_declined")
    if not code or not state:
        return redirect_error("no_code")

    user_id = _verify_state(state)
    if not user_id:
        return redirect_error("unauthorized")

    ru_name = (settings.EBAY_RUNAME or "").strip()
    if not ru_name:
        return redirect_error("misconfigured")

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
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": ru_name,  # must match the authorize request exactly
            },
        )

    if resp.status_code >= 400:
        body = resp.text
        # Log eBay's actual error (no token is present on failure, so this is
        # safe). 401 here = invalid_client (bad client_id/secret); a
        # redirect_uri complaint = the RuName / accepted-URL mismatch.
        print(f"[eBay OAuth] token exchange failed: {resp.status_code} {body}")
        kind = "token_exchange_failed"
        if "redirect_uri" in body:
            kind = "redirect_uri_mismatch"
        return redirect_error(kind)

    data = resp.json()
    expires_at = datetime.now(tz=timezone.utc) + timedelta(seconds=data["expires_in"])
    supabase.table("ebay_tokens").upsert(
        {
            "user_id": user_id,
            "access_token": data["access_token"],
            "refresh_token": data.get("refresh_token"),
            "expires_at": expires_at.isoformat(),
        },
        on_conflict="user_id",
    ).execute()

    return RedirectResponse(f"{fe}/ebay-connect?success=true")


# ---------------------------------------------------------------------------
# Data endpoints. Thin handlers that authenticate, then either call eBay
# directly or delegate to a `services/*` module (search, list, increase).
# ---------------------------------------------------------------------------


@router.get("/search")
async def search(
    upc: str = Query(...),
    searchType: str = Query("upc"),
    mediaType: str = Query(""),
    user_id: str = Depends(get_user_id),
):
    """Product search. searchType: "upc" (exact GTIN), "title" or "any"
    (keyword/approximate). mediaType (DVD/CD/VHS/Cassette/Other) scopes the
    eBay category and selects the in-house catalog. Returns the flattened
    single-product shape the SPA expects (random result + mean price +
    enriched image). The `upc` param carries the search value for any type."""
    status_code, payload = await _search_product(user_id, upc, searchType, mediaType)
    return JSONResponse(status_code=status_code, content=payload)


@router.get("/check-duplicate")
def check_duplicate(upc: str = Query(...), user_id: str = Depends(get_user_id)):
    """Look up duplicates in the local `eBay_inventory` mirror, matched by UPC.

    This replaces the old per-search pagination of the eBay Inventory API: the
    mirror is kept current by the startup sync and by listing/increase actions,
    so duplicate detection is now a single fast query. Returns a soft payload
    (never 4xx) so the SPA's duplicate banner degrades gracefully."""
    try:
        duplicates = find_duplicates_by_upc(upc)
    except Exception as e:  # noqa: BLE001 - soft-fail like the original
        return {"hasDuplicates": False, "duplicates": [], "upc": upc, "error": str(e)}
    return {"hasDuplicates": len(duplicates) > 0, "duplicates": duplicates, "upc": upc}


@router.get("/policies")
async def policies(user_id: str = Depends(get_user_id)):
    """Fetch the seller's eBay business policies (fulfillment/payment/return)
    in parallel. Spec: app/api/ebay/policies/route.ts."""
    try:
        access_token = await get_valid_ebay_token(user_id)
    except EbayTokenError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)

    base = settings.ebay_base_url
    marketplace = settings.EBAY_MARKETPLACE_ID
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "X-EBAY-C-MARKETPLACE-ID": marketplace,
    }

    async with httpx.AsyncClient() as client:
        fulfillment, payment, returns = await asyncio.gather(
            client.get(
                f"{base}/sell/account/v1/fulfillment_policy?marketplace_id={marketplace}",
                headers=headers,
            ),
            client.get(
                f"{base}/sell/account/v1/payment_policy?marketplace_id={marketplace}",
                headers=headers,
            ),
            client.get(
                f"{base}/sell/account/v1/return_policy?marketplace_id={marketplace}",
                headers=headers,
            ),
        )

    # A 401/403 on any policy type means the token lacks the sell.account scope.
    for resp in (fulfillment, payment, returns):
        if resp.status_code in (401, 403):
            return JSONResponse(
                status_code=403,
                content={
                    "error": "Missing required permissions. Please disconnect and reconnect "
                    "your eBay account to grant 'sell.account' scope.",
                    "needsReconnect": True,
                },
            )

    def fmt(resp: httpx.Response, list_key: str, id_key: str) -> list[dict]:
        if resp.status_code >= 400:
            return []
        return [
            {"id": p.get(id_key), "name": p.get("name"), "description": p.get("description")}
            for p in resp.json().get(list_key, [])
        ]

    return {
        "fulfillmentPolicies": fmt(fulfillment, "fulfillmentPolicies", "fulfillmentPolicyId"),
        "paymentPolicies": fmt(payment, "paymentPolicies", "paymentPolicyId"),
        "returnPolicies": fmt(returns, "returnPolicies", "returnPolicyId"),
    }


@router.get("/validate-listing")
async def validate_listing(
    categoryId: str = Query(...),
    aspects: str | None = Query(None),
    user_id: str = Depends(get_user_id),
):
    """Check which required item-specifics for a category are missing.
    Spec: app/api/ebay/validate-listing/route.ts."""
    try:
        access_token = await get_valid_ebay_token(user_id)
    except EbayTokenError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)

    base = settings.ebay_base_url
    url = (
        f"{base}/sell/taxonomy/v1/category_tree/0/get_item_aspects_for_category"
        f"?category_id={categoryId}"
    )
    async with httpx.AsyncClient() as client:
        resp = await client.get(url, headers=ebay_headers(access_token))

    if resp.status_code >= 400:
        return {
            "valid": False,
            "error": "Could not fetch category requirements",
            "requiredAspects": [],
            "missingAspects": [],
            "currentAspects": {},
        }

    taxonomy = resp.json()
    current: dict = {}
    if aspects:
        try:
            current = json.loads(aspects)
        except (ValueError, TypeError):
            current = {}

    defs = taxonomy.get("aspects", []) or []
    required = [
        (a.get("localizedAspectName") or a.get("aspectName"))
        for a in defs
        if a.get("aspectConstraint", {}).get("aspectRequired") is True
    ]

    missing: list[str] = []
    keys_lower = [k.lower() for k in current.keys()]
    for req in required:
        rl = req.lower()
        if not any(k == rl or rl in k or k in rl for k in keys_lower):
            missing.append(req)
    # Also flag required aspects whose value list is empty
    for key, values in current.items():
        if isinstance(values, list) and len(values) == 0:
            match = next((r for r in required if r.lower() == key.lower()), None)
            if match and match not in missing:
                missing.append(match)

    return {
        "valid": len(missing) == 0,
        "categoryId": categoryId,
        "requiredAspects": required,
        "missingAspects": missing,
        "currentAspects": current,
        "aspectDefinitions": [
            {
                "name": a.get("localizedAspectName") or a.get("aspectName"),
                "required": a.get("aspectConstraint", {}).get("aspectRequired") is True,
                "values": [
                    (v.get("localizedValue") or v.get("value"))
                    for v in (a.get("aspectValues") or [])
                ],
            }
            for a in defs
        ],
    }


@router.post("/list")
async def list_item(request: Request, user_id: str = Depends(get_user_id)):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    status_code, payload = await _create_listing(user_id, body)
    # Non-duplicate listing succeeded -> add it to the local mirror at quantity 1.
    if status_code == 200 and isinstance(payload, dict) and payload.get("sku"):
        try:
            record_listing(
                payload.get("sku"),
                body.get("upc"),
                title=body.get("title"),
                media_type=body.get("mediaType"),
                price=body.get("price"),
                user_id=user_id,
                category_id=body.get("categoryId"),
                listing_id=payload.get("listingId"),
            )
        except Exception as e:  # noqa: BLE001 - mirror write must not fail the listing
            print("[inventory-db] record_listing failed:", e)
        try:
            append_new_listing(
                payload.get("sku"),
                body.get("upc"),
                body.get("title"),
                body.get("mediaType"),
                body.get("price"),
            )
        except Exception as e:  # noqa: BLE001 - history write must not fail the listing
            print("[all-item-catalog] append_new_listing failed:", e)
    return JSONResponse(status_code=status_code, content=payload)


@router.post("/increase-inventory")
async def increase_inventory(request: Request, user_id: str = Depends(get_user_id)):
    try:
        body = await request.json()
    except Exception:
        body = {}
    status_code, payload = await _increase_inventory(
        user_id, body.get("sku"), body.get("upc")
    )
    # Mirror eBay's new quantity into the local table for this SKU.
    if status_code == 200 and isinstance(payload, dict) and payload.get("success"):
        try:
            set_quantity(
                body.get("sku"), payload.get("newQuantity"), upc=body.get("upc"), user_id=user_id
            )
        except Exception as e:  # noqa: BLE001 - mirror write must not fail the increase
            print("[inventory-db] set_quantity failed:", e)
        try:
            append_inventory_increase(body.get("sku"), body.get("upc"))
        except Exception as e:  # noqa: BLE001 - history write must not fail the increase
            print("[all-item-catalog] append_inventory_increase failed:", e)
    return JSONResponse(status_code=status_code, content=payload)
