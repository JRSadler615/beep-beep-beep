"""User settings endpoints.

Ported from the Next.js handlers under `app/api/settings/**`. Response shapes
(camelCase keys) match the originals exactly so the SPA needs no changes.

DB columns are snake_case (see supabase/schema.sql); each handler maps between
the two. The Supabase client uses the service role, so every query is scoped by
`user_id` from the verified JWT.

Note: the Next.js GETs auto-created a default row on first read. Here the GETs
just return defaults without writing; the POST/save path upserts the row. The
response is identical.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.auth import get_user_id
from app.constants import DEFAULT_SELLER_NOTE
from app.db import fetch_one, supabase

router = APIRouter(prefix="/api/settings", tags=["settings"])


def _upsert(table: str, user_id: str, values: dict) -> dict:
    """Upsert the user's row (one row per user, conflict on user_id)."""
    payload = {"user_id": user_id, **values}
    res = supabase.table(table).upsert(payload, on_conflict="user_id").execute()
    return (res.data or [payload])[0]


# ---------------------------------------------------------------------------
# SKU settings
# ---------------------------------------------------------------------------


class SkuCounterUpdate(BaseModel):
    nextSkuCounter: int


class SkuPrefixUpdate(BaseModel):
    skuPrefix: Optional[str] = None


@router.get("/sku")
def get_sku(user_id: str = Depends(get_user_id)):
    row = fetch_one("sku_settings", user_id)
    if not row:
        return {"nextSkuCounter": 1, "skuPrefix": None}
    return {"nextSkuCounter": row["next_sku_counter"], "skuPrefix": row["sku_prefix"]}


@router.post("/sku/counter")
def set_sku_counter(body: SkuCounterUpdate, user_id: str = Depends(get_user_id)):
    if body.nextSkuCounter < 1:
        raise HTTPException(status_code=400, detail="nextSkuCounter must be >= 1")
    row = _upsert("sku_settings", user_id, {"next_sku_counter": body.nextSkuCounter})
    return {"success": True, "nextSkuCounter": row["next_sku_counter"]}


@router.post("/sku/prefix")
def set_sku_prefix(body: SkuPrefixUpdate, user_id: str = Depends(get_user_id)):
    prefix = body.skuPrefix.strip() if body.skuPrefix else None
    row = _upsert("sku_settings", user_id, {"sku_prefix": prefix})
    return {"success": True, "skuPrefix": row["sku_prefix"]}


# ---------------------------------------------------------------------------
# Banned keywords
# ---------------------------------------------------------------------------


class KeywordCreate(BaseModel):
    keyword: str


@router.get("/banned-keywords")
def get_banned_keywords(user_id: str = Depends(get_user_id)):
    res = (
        supabase.table("banned_keywords")
        .select("id, keyword, created_at")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return {
        "keywords": [
            {"id": k["id"], "keyword": k["keyword"], "createdAt": k["created_at"]}
            for k in (res.data or [])
        ]
    }


@router.post("/banned-keywords")
def add_banned_keyword(body: KeywordCreate, user_id: str = Depends(get_user_id)):
    if not body.keyword or not body.keyword.strip():
        raise HTTPException(
            status_code=400,
            detail="Keyword is required and must be a non-empty string",
        )
    keyword = body.keyword.strip().lower()

    existing = (
        supabase.table("banned_keywords")
        .select("id")
        .eq("user_id", user_id)
        .eq("keyword", keyword)
        .limit(1)
        .execute()
    )
    if existing.data:
        raise HTTPException(status_code=400, detail="This keyword is already banned")

    res = (
        supabase.table("banned_keywords")
        .insert({"user_id": user_id, "keyword": keyword})
        .execute()
    )
    row = res.data[0]
    return {
        "success": True,
        "keyword": {
            "id": row["id"],
            "keyword": row["keyword"],
            "createdAt": row["created_at"],
        },
    }


@router.delete("/banned-keywords")
def delete_banned_keyword(id: str = Query(...), user_id: str = Depends(get_user_id)):
    existing = (
        supabase.table("banned_keywords").select("user_id").eq("id", id).limit(1).execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Keyword not found")
    if existing.data[0]["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Unauthorized")

    supabase.table("banned_keywords").delete().eq("id", id).execute()
    return {"success": True, "message": "Keyword removed successfully"}


# ---------------------------------------------------------------------------
# Discount settings
# ---------------------------------------------------------------------------


class DiscountUpdate(BaseModel):
    discountAmount: Optional[float] = None
    minimumPrice: Optional[float] = None


@router.get("/discount")
def get_discount(user_id: str = Depends(get_user_id)):
    row = fetch_one("discount_settings", user_id)
    if not row:
        return {"discountAmount": 3.0, "minimumPrice": 4.0}
    return {"discountAmount": row["discount_amount"], "minimumPrice": row["minimum_price"]}


@router.post("/discount")
def set_discount(body: DiscountUpdate, user_id: str = Depends(get_user_id)):
    values: dict = {}
    if body.discountAmount is not None:
        if body.discountAmount < 0:
            raise HTTPException(status_code=400, detail="Discount amount cannot be negative")
        values["discount_amount"] = body.discountAmount
    if body.minimumPrice is not None:
        if body.minimumPrice < 0:
            raise HTTPException(status_code=400, detail="Minimum price cannot be negative")
        values["minimum_price"] = body.minimumPrice

    existing = fetch_one("discount_settings", user_id) or {}
    row = _upsert(
        "discount_settings",
        user_id,
        {
            "discount_amount": values.get("discount_amount", existing.get("discount_amount", 3.0)),
            "minimum_price": values.get("minimum_price", existing.get("minimum_price", 4.0)),
        },
    )
    return {
        "success": True,
        "discountAmount": row["discount_amount"],
        "minimumPrice": row["minimum_price"],
    }


# ---------------------------------------------------------------------------
# Edit mode settings
# ---------------------------------------------------------------------------


class EditModeUpdate(BaseModel):
    defaultEditMode: Optional[bool] = None


@router.get("/edit-mode")
def get_edit_mode(user_id: str = Depends(get_user_id)):
    row = fetch_one("edit_mode_settings", user_id)
    return {"defaultEditMode": row["default_edit_mode"] if row else False}


@router.post("/edit-mode")
def set_edit_mode(body: EditModeUpdate, user_id: str = Depends(get_user_id)):
    value = body.defaultEditMode if body.defaultEditMode is not None else False
    row = _upsert("edit_mode_settings", user_id, {"default_edit_mode": value})
    return {"success": True, "defaultEditMode": row["default_edit_mode"]}


# ---------------------------------------------------------------------------
# Override description settings
# ---------------------------------------------------------------------------


class OverrideDescriptionUpdate(BaseModel):
    useOverrideDescription: Optional[bool] = None
    overrideDescription: Optional[str] = None


@router.get("/override-description")
def get_override_description(user_id: str = Depends(get_user_id)):
    row = fetch_one("override_description_settings", user_id)
    if not row:
        return {"useOverrideDescription": False, "overrideDescription": ""}
    return {
        "useOverrideDescription": row["use_override_description"],
        "overrideDescription": row["override_description"] or "",
    }


@router.post("/override-description")
def set_override_description(
    body: OverrideDescriptionUpdate, user_id: str = Depends(get_user_id)
):
    existing = fetch_one("override_description_settings", user_id) or {}
    use_override = (
        body.useOverrideDescription
        if body.useOverrideDescription is not None
        else existing.get("use_override_description", False)
    )
    description = (
        (body.overrideDescription or None)
        if body.overrideDescription is not None
        else existing.get("override_description")
    )
    row = _upsert(
        "override_description_settings",
        user_id,
        {"use_override_description": use_override, "override_description": description},
    )
    return {
        "success": True,
        "useOverrideDescription": row["use_override_description"],
        "overrideDescription": row["override_description"] or "",
    }


# ---------------------------------------------------------------------------
# Seller note settings
# ---------------------------------------------------------------------------


class SellerNoteUpdate(BaseModel):
    enableSellerNoteEditing: Optional[bool] = None
    sellerNoteText: Optional[str] = None


@router.get("/seller-note")
def get_seller_note(user_id: str = Depends(get_user_id)):
    row = fetch_one("seller_note_settings", user_id)
    if not row:
        return {"enableSellerNoteEditing": False, "sellerNoteText": DEFAULT_SELLER_NOTE}
    return {
        "enableSellerNoteEditing": row["enable_seller_note_editing"],
        "sellerNoteText": row["seller_note_text"] or DEFAULT_SELLER_NOTE,
    }


@router.post("/seller-note")
def set_seller_note(body: SellerNoteUpdate, user_id: str = Depends(get_user_id)):
    existing = fetch_one("seller_note_settings", user_id) or {}
    enabled = (
        body.enableSellerNoteEditing
        if body.enableSellerNoteEditing is not None
        else existing.get("enable_seller_note_editing", False)
    )
    if body.sellerNoteText is not None:
        text = body.sellerNoteText.strip() or DEFAULT_SELLER_NOTE
    else:
        text = existing.get("seller_note_text") or DEFAULT_SELLER_NOTE
    row = _upsert(
        "seller_note_settings",
        user_id,
        {"enable_seller_note_editing": enabled, "seller_note_text": text},
    )
    return {
        "success": True,
        "enableSellerNoteEditing": row["enable_seller_note_editing"],
        "sellerNoteText": row["seller_note_text"] or DEFAULT_SELLER_NOTE,
    }


# ---------------------------------------------------------------------------
# Offer settings
# ---------------------------------------------------------------------------


class OfferUpdate(BaseModel):
    allowOffers: Optional[bool] = None
    minimumOfferAmount: Optional[float] = None


@router.get("/offers")
def get_offers(user_id: str = Depends(get_user_id)):
    row = fetch_one("offer_settings", user_id)
    if not row:
        return {"allowOffers": False, "minimumOfferAmount": 10.0}
    return {
        "allowOffers": row["allow_offers"],
        "minimumOfferAmount": row["minimum_offer_amount"],
    }


@router.post("/offers")
def set_offers(body: OfferUpdate, user_id: str = Depends(get_user_id)):
    if body.minimumOfferAmount is not None and body.minimumOfferAmount <= 0:
        raise HTTPException(
            status_code=400,
            detail="minimumOfferAmount must be a valid number greater than 0",
        )
    existing = fetch_one("offer_settings", user_id) or {}
    allow = body.allowOffers if body.allowOffers is not None else existing.get("allow_offers", False)
    minimum = (
        body.minimumOfferAmount
        if body.minimumOfferAmount is not None
        else existing.get("minimum_offer_amount", 10.0)
    )
    row = _upsert(
        "offer_settings",
        user_id,
        {"allow_offers": allow, "minimum_offer_amount": minimum},
    )
    return {
        "success": True,
        "allowOffers": row["allow_offers"],
        "minimumOfferAmount": row["minimum_offer_amount"],
    }


# ---------------------------------------------------------------------------
# eBay business policy preferences
# ---------------------------------------------------------------------------


class EbayPoliciesUpdate(BaseModel):
    paymentPolicyId: Optional[str] = None
    paymentPolicyName: Optional[str] = None
    returnPolicyId: Optional[str] = None
    returnPolicyName: Optional[str] = None
    fulfillmentPolicyId: Optional[str] = None
    fulfillmentPolicyName: Optional[str] = None


_POLICY_FIELDS = {
    "paymentPolicyId": "payment_policy_id",
    "paymentPolicyName": "payment_policy_name",
    "returnPolicyId": "return_policy_id",
    "returnPolicyName": "return_policy_name",
    "fulfillmentPolicyId": "fulfillment_policy_id",
    "fulfillmentPolicyName": "fulfillment_policy_name",
}


def _policies_response(row: Optional[dict]) -> dict:
    return {camel: (row.get(col) if row else None) for camel, col in _POLICY_FIELDS.items()}


# ---------------------------------------------------------------------------
# Inventory location (ship-from address for eBay publishing)
# ---------------------------------------------------------------------------


class LocationUpdate(BaseModel):
    addressLine1: Optional[str] = None
    addressLine2: Optional[str] = None
    city: Optional[str] = None
    stateOrProvince: Optional[str] = None
    postalCode: Optional[str] = None
    country: Optional[str] = None
    merchantLocationKey: Optional[str] = None


def _location_response(row: Optional[dict]) -> dict:
    if not row:
        return {"location": None}
    return {
        "location": {
            "merchantLocationKey": row["merchant_location_key"],
            "addressLine1": row["address_line1"],
            "addressLine2": row["address_line2"],
            "city": row["city"],
            "stateOrProvince": row["state_or_province"],
            "postalCode": row["postal_code"],
            "country": row["country"],
        }
    }


@router.get("/location")
def get_location(user_id: str = Depends(get_user_id)):
    return _location_response(fetch_one("ebay_inventory_location", user_id))


@router.post("/location")
def set_location(body: LocationUpdate, user_id: str = Depends(get_user_id)):
    required = {
        "addressLine1": body.addressLine1,
        "city": body.city,
        "stateOrProvince": body.stateOrProvince,
        "postalCode": body.postalCode,
    }
    for field, value in required.items():
        if not value or not value.strip():
            raise HTTPException(status_code=400, detail=f"{field} is required")

    address_line2 = body.addressLine2.strip() if body.addressLine2 and body.addressLine2.strip() else None
    country = body.country.strip().upper() if body.country and body.country.strip() else "US"
    key = (
        body.merchantLocationKey.strip()
        if body.merchantLocationKey and body.merchantLocationKey.strip()
        else "default-location"
    )

    row = _upsert(
        "ebay_inventory_location",
        user_id,
        {
            "merchant_location_key": key,
            "address_line1": body.addressLine1.strip(),
            "address_line2": address_line2,
            "city": body.city.strip(),
            "state_or_province": body.stateOrProvince.strip(),
            "postal_code": body.postalCode.strip(),
            "country": country,
        },
    )
    return {"success": True, **_location_response(row)}


# ---------------------------------------------------------------------------
# Per-media-type default package dimensions / weight
# ---------------------------------------------------------------------------


class MediaDefaultUpdate(BaseModel):
    mediaType: str
    height: Optional[float] = None
    width: Optional[float] = None
    depth: Optional[float] = None
    dimensionUnits: Optional[str] = None
    weight: Optional[float] = None
    weightUnits: Optional[str] = None


def _media_default_response(row: dict) -> dict:
    return {
        "mediaType": row["media_type"],
        "height": row["height"],
        "width": row["width"],
        "depth": row["depth"],
        "dimensionUnits": row["dimension_units"],
        "weight": row["weight"],
        "weightUnits": row["weight_units"],
    }


@router.get("/media-defaults")
def get_media_defaults(user_id: str = Depends(get_user_id)):
    """Return all per-media-type dimension/weight defaults for the user."""
    res = (
        supabase.table("media_type_dimension_defaults")
        .select("*")
        .eq("user_id", user_id)
        .order("media_type")
        .execute()
    )
    return {"defaults": [_media_default_response(r) for r in (res.data or [])]}


@router.post("/media-defaults")
def set_media_defaults(body: MediaDefaultUpdate, user_id: str = Depends(get_user_id)):
    if not body.mediaType or not body.mediaType.strip():
        raise HTTPException(status_code=400, detail="mediaType is required")
    payload = {
        "user_id": user_id,
        "media_type": body.mediaType.strip(),
        "height": body.height,
        "width": body.width,
        "depth": body.depth,
        "dimension_units": (body.dimensionUnits or None),
        "weight": body.weight,
        "weight_units": (body.weightUnits or None),
    }
    res = (
        supabase.table("media_type_dimension_defaults")
        .upsert(payload, on_conflict="user_id,media_type")
        .execute()
    )
    row = (res.data or [payload])[0]
    return {"success": True, **_media_default_response(row)}


@router.get("/ebay-policies")
def get_ebay_policies(user_id: str = Depends(get_user_id)):
    return _policies_response(fetch_one("ebay_business_policies", user_id))


@router.post("/ebay-policies")
def set_ebay_policies(body: EbayPoliciesUpdate, user_id: str = Depends(get_user_id)):
    values = {col: getattr(body, camel) for camel, col in _POLICY_FIELDS.items()}
    row = _upsert("ebay_business_policies", user_id, values)
    return {"success": True, **_policies_response(row)}
