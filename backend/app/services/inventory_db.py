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
) -> None:
    """Add (or reset) a row for a freshly listed, non-duplicate item: quantity 1.
    No-op without a SKU and a UPC (UPC is NOT NULL)."""
    upc_int = _upc_int(upc)
    if not sku or upc_int is None:
        return
    row: dict = {"SKU": sku, "UPC": upc_int, "Inventory": 1}
    if title:
        row["Title"] = title
    if media_type:
        row["Type"] = media_type
    if price is not None and str(price).strip() != "":
        try:
            row["Current_price"] = float(price)
        except (TypeError, ValueError):
            pass
    supabase.table(TABLE).upsert(row, on_conflict="SKU").execute()


def set_quantity(
    sku: str | None, quantity: object, upc: object = None, title: str | None = None
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


def _row_from_item(item: dict) -> dict | None:
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
    return {
        "SKU": sku,
        "UPC": upc_int,
        "Title": product.get("title"),
        "Inventory": qty if isinstance(qty, int) else 0,
    }


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
            row = _row_from_item(item)
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
# Startup throttle
# ---------------------------------------------------------------------------


def _mark_synced() -> None:
    supabase.table(_STATE_TABLE).upsert(
        {"id": 1, "last_synced_at": datetime.now(timezone.utc).isoformat()}
    ).execute()


def _last_synced_at() -> datetime | None:
    rows = (
        supabase.table(_STATE_TABLE)
        .select("last_synced_at")
        .eq("id", 1)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows or not rows[0].get("last_synced_at"):
        return None
    try:
        return datetime.fromisoformat(str(rows[0]["last_synced_at"]).replace("Z", "+00:00"))
    except ValueError:
        return None


async def maybe_sync_on_startup() -> None:
    """Run a sync on startup unless one ran within the configured interval.
    Swallows errors — a failed/throttled sync must never block the server."""
    try:
        interval = timedelta(minutes=settings.INVENTORY_SYNC_MIN_INTERVAL_MINUTES)
        last = _last_synced_at()
        if last and datetime.now(timezone.utc) - last < interval:
            print("[inventory-sync] throttled (last synced", last.isoformat(), ")")
            return
        result = await sync_from_ebay()
        print("[inventory-sync] done:", result)
    except Exception as e:  # noqa: BLE001
        print("[inventory-sync] skipped:", e)
