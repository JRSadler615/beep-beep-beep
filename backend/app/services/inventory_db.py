"""Local eBay inventory mirror (`eBay_inventory` Supabase table).

The app keeps a global, single-seller mirror of the eBay inventory so the
product-search duplicate check is a fast local query instead of paginating the
eBay Inventory API on every search. SKU is the primary key; duplicates are
matched by UPC.

Responsibilities:
  - `sync_from_ebay` / `maybe_sync_on_startup`: refresh the mirror from eBay
    (upsert present items, delete SKUs eBay no longer reports), throttled so the
    dev `--reload` loop doesn't hammer the API.
  - `find_duplicates_by_upc`: the duplicate-check lookup.
  - `record_listing` / `set_quantity`: keep the mirror in step with listings and
    inventory increases.

eBay's Inventory API reports SKU/UPC/Title/quantity but not price, our media
type, or free-shipping, so `Current_price` / `Type` / `Free_shipping` are only
written when WE list an item; the sync leaves them untouched on existing rows.
"""

from datetime import datetime, timedelta, timezone

import httpx

from app.config import settings
from app.db import supabase
from app.services.ebay_client import (
    EbayTokenError,
    ebay_headers,
    get_valid_ebay_token,
)
from app.services.media import CATEGORY_TO_MEDIA_TYPE
from app.services.upc import normalize_no_zeros

TABLE = "eBay_inventory"
_STATE_TABLE = "inventory_sync_state"


def _upc_int(value: object) -> int | None:
    """Normalize a UPC to the numeric form stored in the table (leading zeros
    stripped), or None if there are no digits. The `UPC` column is NOT NULL, so
    rows without a UPC can't be mirrored."""
    n = normalize_no_zeros(value)
    return int(n) if n else None


# ---------------------------------------------------------------------------
# Duplicate lookup (used by /check-duplicate)
# ---------------------------------------------------------------------------


def find_duplicates_by_upc(upc: object) -> list[dict]:
    """Return [{sku, title}] for inventory rows matching this UPC (empty if none)."""
    upc_int = _upc_int(upc)
    if upc_int is None:
        return []
    rows = (
        supabase.table(TABLE)
        .select("SKU,Title,Inventory")
        .eq("UPC", upc_int)
        .execute()
        .data
        or []
    )
    return [{"sku": r["SKU"], "title": r.get("Title") or "Unknown product"} for r in rows]


# ---------------------------------------------------------------------------
# Mirror updates from listing actions
# ---------------------------------------------------------------------------


def record_listing(
    sku: str | None,
    upc: object,
    title: str | None = None,
    media_type: str | None = None,
    price: object = None,
    user_id: str | None = None,
    category_id: object = None,
    listing_id: object = None,
) -> None:
    """Add (or reset) a row for a freshly listed, non-duplicate item: quantity 1.
    Fills in what we already know at list time (account, category, listing id) so
    the row is complete without waiting for the daily offer-enrichment pass.
    No-op without a SKU and a UPC (UPC is NOT NULL)."""
    upc_int = _upc_int(upc)
    if not sku or upc_int is None:
        return
    row: dict = {"SKU": sku, "UPC": upc_int, "Inventory": 1}
    if title:
        row["Title"] = title
    if media_type:
        row["Type"] = media_type
    if user_id:
        row["user_id"] = user_id
    if category_id:
        row["Category_id"] = str(category_id)
    if listing_id:
        row["Listing_id"] = str(listing_id)
    if price is not None and str(price).strip() != "":
        try:
            row["Current_price"] = float(price)
        except (TypeError, ValueError):
            pass
    supabase.table(TABLE).upsert(row, on_conflict="SKU").execute()


def set_quantity(
    sku: str | None,
    quantity: object,
    upc: object = None,
    title: str | None = None,
    user_id: str | None = None,
) -> None:
    """Set a row's Inventory to eBay's new quantity after an increase. Updates by
    SKU; if the row doesn't exist yet and a UPC is available, inserts it."""
    if not sku or not isinstance(quantity, int):
        return
    res = supabase.table(TABLE).update({"Inventory": quantity}).eq("SKU", sku).execute()
    if not (res.data or []):
        upc_int = _upc_int(upc)
        if upc_int is not None:
            row: dict = {"SKU": sku, "UPC": upc_int, "Inventory": quantity}
            if title:
                row["Title"] = title
            if user_id:
                row["user_id"] = user_id
            supabase.table(TABLE).upsert(row, on_conflict="SKU").execute()


# ---------------------------------------------------------------------------
# Sync from eBay
# ---------------------------------------------------------------------------


async def _fetch_all_inventory(access_token: str) -> list[dict]:
    """Page through the eBay Inventory API and return every inventory item."""
    base = settings.ebay_base_url
    items: list[dict] = []
    url = f"{base}/sell/inventory/v1/inventory_item?limit=200&offset=0"
    pages = 0
    async with httpx.AsyncClient(timeout=30) as client:
        while url and pages < 100:
            r = await client.get(url, headers=ebay_headers(access_token))
            if r.status_code >= 400:
                break
            data = r.json()
            items.extend(data.get("inventoryItems") or [])
            nxt = data.get("next")
            if not nxt:
                break
            if nxt.startswith("http"):
                url = nxt
            else:
                url = f"{base}{nxt if nxt.startswith('/') else '/' + nxt}"
            pages += 1
    return items


def _row_from_item(item: dict, user_id: str | None = None) -> dict | None:
    """Map an eBay inventory item to a mirror row, or None if it has no SKU/UPC."""
    sku = item.get("sku")
    if not sku:
        return None
    product = item.get("product") or {}
    upc_src = (product.get("upc") or [None])[0] or product.get("gtin")
    if not upc_src:
        for pi in product.get("productIdentifiers") or []:
            if pi.get("type") in ("UPC", "UPC_A", "UPC_E", "GTIN", "EAN"):
                upc_src = pi.get("value") or pi.get("identifier")
                if upc_src:
                    break
    upc_int = _upc_int(upc_src)
    if upc_int is None:
        return None  # UPC is NOT NULL — can't mirror without it
    qty = (
        (item.get("availability") or {})
        .get("shipToLocationAvailability", {})
        .get("quantity")
    )
    row: dict = {
        "SKU": sku,
        "UPC": upc_int,
        "Title": product.get("title"),
        "Inventory": qty if isinstance(qty, int) else 0,
    }
    if user_id:
        row["user_id"] = user_id
    return row


async def sync_from_ebay() -> dict:
    """Refresh the mirror from eBay for every connected account: upsert present
    items (SKU/UPC/Title/Inventory) and delete SKUs eBay no longer reports.
    Returns {synced, deleted}."""
    accounts = supabase.table("ebay_tokens").select("user_id").execute().data or []
    mirror_rows: list[dict] = []
    seen: set[str] = set()
    for acct in accounts:
        try:
            token = await get_valid_ebay_token(acct["user_id"])
        except EbayTokenError:
            continue
        for item in await _fetch_all_inventory(token):
            row = _row_from_item(item, acct["user_id"])
            if row:
                mirror_rows.append(row)
                seen.add(row["SKU"])

    if mirror_rows:
        supabase.table(TABLE).upsert(mirror_rows, on_conflict="SKU").execute()

    # Full mirror: delete local SKUs eBay no longer reports.
    existing = supabase.table(TABLE).select("SKU").execute().data or []
    stale = [e["SKU"] for e in existing if e["SKU"] not in seen]
    for i in range(0, len(stale), 100):
        supabase.table(TABLE).delete().in_("SKU", stale[i : i + 100]).execute()

    _mark_synced()
    return {"synced": len(mirror_rows), "deleted": len(stale)}


# ---------------------------------------------------------------------------
# Enrich from offers (price / category / listing id / free shipping)
# ---------------------------------------------------------------------------
#
# These fields live on the eBay *Offer*, not the inventory item, so enrichment
# costs one offer call per SKU — hence it runs at most once per day.


def _policy_free_shipping(policy: dict) -> bool:
    """True if a fulfillment policy offers free domestic shipping."""
    for opt in policy.get("shippingOptions") or []:
        if opt.get("optionType") and opt["optionType"] != "DOMESTIC":
            continue
        for svc in opt.get("shippingServices") or []:
            if svc.get("freeShipping") is True:
                return True
            cost = (svc.get("shippingCost") or {}).get("value")
            if cost is not None and float(cost or 0) == 0:
                return True
    return False


async def _free_shipping_by_policy(client: httpx.AsyncClient, token: str) -> dict:
    """Map fulfillmentPolicyId -> free-shipping bool for the account."""
    base = settings.ebay_base_url
    result: dict = {}
    r = await client.get(
        f"{base}/sell/account/v1/fulfillment_policy?marketplace_id={settings.EBAY_MARKETPLACE_ID}",
        headers=ebay_headers(token),
    )
    if r.status_code < 400:
        for policy in r.json().get("fulfillmentPolicies") or []:
            pid = policy.get("fulfillmentPolicyId")
            if pid:
                result[pid] = _policy_free_shipping(policy)
    return result


async def _published_offer_for_sku(
    client: httpx.AsyncClient, token: str, sku: str
) -> dict | None:
    """Return the published offer for a SKU (or the first offer), else None."""
    base = settings.ebay_base_url
    r = await client.get(
        f"{base}/sell/inventory/v1/offer?sku={sku}&limit=25", headers=ebay_headers(token)
    )
    if r.status_code >= 400:
        return None
    offers = r.json().get("offers") or []
    return next((o for o in offers if o.get("status") == "PUBLISHED"), None) or (
        offers[0] if offers else None
    )


async def enrich_from_offers() -> dict:
    """Daily pass: for each mirrored SKU, pull its eBay offer and fill in
    Current_price, Category_id, Listing_id, and Free_shipping. Returns
    {enriched}."""
    accounts = supabase.table("ebay_tokens").select("user_id").execute().data or []
    enriched = 0
    async with httpx.AsyncClient(timeout=30) as client:
        for acct in accounts:
            uid = acct["user_id"]
            try:
                token = await get_valid_ebay_token(uid)
            except EbayTokenError:
                continue
            free_map = await _free_shipping_by_policy(client, token)
            skus = (
                supabase.table(TABLE)
                .select("SKU,Type")
                .eq("user_id", uid)
                .execute()
                .data
                or []
            )
            for r in skus:
                sku = r["SKU"]
                offer = await _published_offer_for_sku(client, token, sku)
                if not offer:
                    continue
                update: dict = {}
                price = ((offer.get("pricingSummary") or {}).get("price") or {}).get("value")
                if price is not None:
                    try:
                        update["Current_price"] = float(price)
                    except (TypeError, ValueError):
                        pass
                if offer.get("categoryId"):
                    category_id = str(offer["categoryId"])
                    update["Category_id"] = category_id
                    # Derive the media type from the category, but only fill Type
                    # when it's blank (don't clobber a specific type — e.g.
                    # Blu-ray — that we set when listing). Leave null if no match.
                    if not r.get("Type"):
                        media_type = CATEGORY_TO_MEDIA_TYPE.get(category_id)
                        if media_type:
                            update["Type"] = media_type
                listing_id = (offer.get("listing") or {}).get("listingId")
                if listing_id:
                    update["Listing_id"] = str(listing_id)
                fpid = (offer.get("listingPolicies") or {}).get("fulfillmentPolicyId")
                if fpid in free_map:
                    update["Free_shipping"] = free_map[fpid]
                if update:
                    supabase.table(TABLE).update(update).eq("SKU", sku).execute()
                    enriched += 1
    _mark_enriched()
    return {"enriched": enriched}


# ---------------------------------------------------------------------------
# Startup throttle
# ---------------------------------------------------------------------------


def _mark_synced() -> None:
    supabase.table(_STATE_TABLE).upsert(
        {"id": 1, "last_synced_at": datetime.now(timezone.utc).isoformat()}
    ).execute()


def _mark_enriched() -> None:
    supabase.table(_STATE_TABLE).upsert(
        {"id": 1, "last_enriched_at": datetime.now(timezone.utc).isoformat()}
    ).execute()


def _state_time(column: str) -> datetime | None:
    rows = (
        supabase.table(_STATE_TABLE).select(column).eq("id", 1).limit(1).execute().data or []
    )
    if not rows or not rows[0].get(column):
        return None
    try:
        return datetime.fromisoformat(str(rows[0][column]).replace("Z", "+00:00"))
    except ValueError:
        return None


async def maybe_sync_on_startup() -> None:
    """On startup: refresh the mirror (throttled to the sync interval) and run
    the heavier offer-enrichment pass at most once per the enrich interval. Each
    is guarded independently. Swallows errors — sync must never block the server."""
    now = datetime.now(timezone.utc)

    # 1) Inventory mirror (SKU/UPC/Title/Inventory/user_id).
    try:
        interval = timedelta(minutes=settings.INVENTORY_SYNC_MIN_INTERVAL_MINUTES)
        last = _state_time("last_synced_at")
        if last and now - last < interval:
            print("[inventory-sync] throttled (last synced", last.isoformat(), ")")
        else:
            print("[inventory-sync] done:", await sync_from_ebay())
    except Exception as e:  # noqa: BLE001
        print("[inventory-sync] skipped:", e)

    # 2) Offer enrichment (price/category/listing/free-shipping), at most daily.
    try:
        interval = timedelta(hours=settings.INVENTORY_ENRICH_MIN_INTERVAL_HOURS)
        last = _state_time("last_enriched_at")
        if last and now - last < interval:
            print("[inventory-enrich] throttled (last enriched", last.isoformat(), ")")
        else:
            print("[inventory-enrich] done:", await enrich_from_offers())
    except Exception as e:  # noqa: BLE001
        print("[inventory-enrich] skipped:", e)
