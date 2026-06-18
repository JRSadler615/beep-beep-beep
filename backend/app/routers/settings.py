"""User settings endpoints.

`/api/settings/sku` is fully implemented as the reference pattern. The rest
are stubs returning their default shape so the SPA renders; fill each in from
the matching Next.js handler under `app/api/settings/**`.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.auth import get_user_id
from app.db import supabase

router = APIRouter(prefix="/api/settings", tags=["settings"])


# ---------------------------------------------------------------------------
# SKU settings — fully implemented reference
# Spec: app/api/settings/sku/route.ts (GET), sku/counter, sku/prefix (POST)
# ---------------------------------------------------------------------------


class SkuCounterUpdate(BaseModel):
    nextSkuCounter: int


class SkuPrefixUpdate(BaseModel):
    skuPrefix: str | None


@router.get("/sku")
def get_sku(user_id: str = Depends(get_user_id)):
    row = (
        supabase.table("sku_settings")
        .select("*")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    data = row.data if row else None
    if not data:
        return {"nextSkuCounter": 1, "skuPrefix": None}
    return {"nextSkuCounter": data["next_sku_counter"], "skuPrefix": data["sku_prefix"]}


@router.post("/sku/counter")
def set_sku_counter(body: SkuCounterUpdate, user_id: str = Depends(get_user_id)):
    supabase.table("sku_settings").upsert(
        {"user_id": user_id, "next_sku_counter": body.nextSkuCounter}
    ).execute()
    return {"success": True, "nextSkuCounter": body.nextSkuCounter}


@router.post("/sku/prefix")
def set_sku_prefix(body: SkuPrefixUpdate, user_id: str = Depends(get_user_id)):
    supabase.table("sku_settings").upsert(
        {"user_id": user_id, "sku_prefix": body.skuPrefix}
    ).execute()
    return {"success": True, "skuPrefix": body.skuPrefix}


# ---------------------------------------------------------------------------
# Stubs — return the default shape the SPA expects. Implement from the
# corresponding Next.js route handler. Each reads/writes one settings table.
# ---------------------------------------------------------------------------


@router.get("/banned-keywords")
def get_banned_keywords(user_id: str = Depends(get_user_id)):
    # TODO: select id, keyword from banned_keywords where user_id
    return {"keywords": []}


@router.get("/discount")
def get_discount(user_id: str = Depends(get_user_id)):
    # TODO: app/api/settings/discount/route.ts
    return {"discountAmount": 3.0, "minimumPrice": 4.0}


@router.get("/edit-mode")
def get_edit_mode(user_id: str = Depends(get_user_id)):
    # TODO: app/api/settings/edit-mode/route.ts
    return {"defaultEditMode": False}


@router.get("/override-description")
def get_override_description(user_id: str = Depends(get_user_id)):
    # TODO: app/api/settings/override-description/route.ts
    return {"useOverrideDescription": False, "overrideDescription": ""}


@router.get("/seller-note")
def get_seller_note(user_id: str = Depends(get_user_id)):
    # TODO: app/api/settings/seller-note/route.ts
    return {"enableSellerNoteEditing": False, "sellerNoteText": ""}


@router.get("/offers")
def get_offers(user_id: str = Depends(get_user_id)):
    # TODO: app/api/settings/offers/route.ts
    return {"allowOffers": False, "minimumOfferAmount": 10.0}


@router.get("/ebay-policies")
def get_ebay_policies(user_id: str = Depends(get_user_id)):
    # TODO: app/api/settings/ebay-policies/route.ts
    return {"paymentPolicyId": "", "returnPolicyId": "", "fulfillmentPolicyId": ""}
