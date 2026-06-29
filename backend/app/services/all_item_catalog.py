"""all_item_catalog — append-only per-item history for analytics.

Unlike `eBay_inventory` (a live mirror that deletes ended SKUs), every physical
item ever listed or added to inventory gets a permanent row here, so we can
analyze repricing, listing dates, time-to-sell, and sell-through/conversion.

One row per item: a new listing inserts one row; each inventory increase (+1)
inserts another. Sales are assigned **FIFO** — the oldest unsold item for a SKU
(by `Listing_date`) gets the `Sale_date` first.

Columns are the hand-built Supabase schema (mixed case): Unique_item_ID, SKU,
UPC, Title, Type, Year, Genres, Rated, Artist, Listing_date, Status,
Initial_price, Price_change_since_listing, Times_price_changed, Sale_date,
Sale_price, Time_listed, Last_update, Free_shipping, Duplicate_when_listed.
"""

from datetime import datetime, timedelta, timezone

import httpx

from app.config import settings
from app.db import supabase
from app.services.catalog import lookup_catalog_by_upc
from app.services.ebay_client import (
    EbayTokenError,
    ebay_headers,
    get_valid_ebay_token,
)
from app.services.upc import normalize_no_zeros

TABLE = "all_item_catalog"

STATUS_ACTIVE = "Active"
STATUS_SOLD = "Sold"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _upc_int(value: object) -> int | None:
    n = normalize_no_zeros(value)
    return int(n) if n else None


def _to_float(value: object) -> float | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Append (new listings + inventory additions)
# ---------------------------------------------------------------------------


def append_item(
    sku: str | None,
    upc: object,
    title: str | None,
    media_type: str | None,
    list_price: object,
    duplicate_when_listed: bool,
    free_shipping: bool | None = None,
) -> None:
    """Insert one per-item history row. Catalog fields (Year/Genres/Rated/Artist)
    are filled best-effort from the media catalog. No-op without a SKU + UPC
    (UPC is NOT NULL)."""
    upc_int = _upc_int(upc)
    if not sku or upc_int is None:
        return

    fields = (lookup_catalog_by_upc(upc, media_type) or {}).get("fields") or {}
    now = _now_iso()
    row: dict = {
        "SKU": sku,
        "UPC": upc_int,
        "Title": title or None,
        "Type": media_type or None,
        "Year": fields.get("year") or None,
        "Genres": fields.get("genre") or None,
        "Rated": fields.get("rated") or None,
        "Artist": fields.get("artist") or None,
        "Listing_date": now,
        "Status": STATUS_ACTIVE,
        "Initial_price": _to_float(list_price),
        "Price_change_since_listing": 0,
        "Times_price_changed": 0,
        "Last_update": now,
        "Duplicate_when_listed": duplicate_when_listed,
    }
    if free_shipping is not None:
        row["Free_shipping"] = free_shipping
    supabase.table(TABLE).insert(row).execute()


def append_new_listing(
    sku: str | None,
    upc: object,
    title: str | None,
    media_type: str | None,
    price: object,
) -> None:
    """Record a brand-new (non-duplicate) listing as one item."""
    append_item(sku, upc, title, media_type, price, duplicate_when_listed=False)


def append_inventory_increase(sku: str | None, upc: object) -> None:
    """Record an inventory addition (+1 on a duplicate) as one item, pulling
    Title/Type/price from the live eBay_inventory mirror row for the SKU."""
    if not sku:
        return
    rows = (
        supabase.table("eBay_inventory")
        .select("UPC,Title,Type,Current_price,Free_shipping")
        .eq("SKU", sku)
        .limit(1)
        .execute()
        .data
        or []
    )
    inv = rows[0] if rows else {}
    append_item(
        sku,
        upc or inv.get("UPC"),
        inv.get("Title"),
        inv.get("Type"),
        inv.get("Current_price"),
        duplicate_when_listed=True,
        free_shipping=inv.get("Free_shipping"),
    )


# ---------------------------------------------------------------------------
# Sale recording (FIFO)
# ---------------------------------------------------------------------------


def record_sale_fifo(
    sku: str,
    sale_date: str,
    sale_price: object = None,
    count: int = 1,
) -> int:
    """Mark the `count` oldest unsold items for a SKU as sold, in the order they
    were added (oldest `Listing_date` first). Sets Sale_date, Sale_price,
    Status, Time_listed (days listed), Last_update. Returns rows updated."""
    if not sku or count < 1:
        return 0
    candidates = (
        supabase.table(TABLE)
        .select("Unique_item_ID,Listing_date")
        .eq("SKU", sku)
        .is_("Sale_date", "null")
        .order("Listing_date", desc=False)
        .limit(count)
        .execute()
        .data
        or []
    )
    sale_dt = _parse_ts(sale_date)
    price = _to_float(sale_price)
    for row in candidates:
        update: dict = {
            "Sale_date": sale_date,
            "Status": STATUS_SOLD,
            "Last_update": _now_iso(),
        }
        if price is not None:
            update["Sale_price"] = price
        days = _days_between(row.get("Listing_date"), sale_dt)
        if days is not None:
            update["Time_listed"] = days
        supabase.table(TABLE).update(update).eq(
            "Unique_item_ID", row["Unique_item_ID"]
        ).execute()
    return len(candidates)


def _parse_ts(value: object) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _days_between(listing_date: object, sale_dt: datetime | None) -> float | None:
    listed = _parse_ts(listing_date)
    if not listed or not sale_dt:
        return None
    return round((sale_dt - listed).total_seconds() / 86400, 4)


# ---------------------------------------------------------------------------
# Sale detection — eBay Fulfillment/Orders API
# ---------------------------------------------------------------------------
#
# Reads real orders (exact SKU, quantity, sale date, sale price) and assigns
# them FIFO. Idempotent: each order line item is recorded once (tracked in
# processed_sale_lineitems), so overlapping poll windows never double-count.
# Requires the sell.fulfillment(.readonly) scope — reconnect eBay if newly added.

_STATE_TABLE = "inventory_sync_state"
_PROCESSED_TABLE = "processed_sale_lineitems"


async def _fetch_orders(client: httpx.AsyncClient, token: str, start_iso: str) -> list[dict]:
    """Page through orders created since `start_iso`."""
    base = settings.ebay_base_url
    orders: list[dict] = []
    offset, limit = 0, 200
    while True:
        r = await client.get(
            f"{base}/sell/fulfillment/v1/order",
            headers=ebay_headers(token),
            params={
                "filter": f"creationdate:[{start_iso}..]",
                "limit": str(limit),
                "offset": str(offset),
            },
        )
        if r.status_code >= 400:
            break
        data = r.json()
        batch = data.get("orders") or []
        orders.extend(batch)
        total = data.get("total") or 0
        offset += limit
        if not batch or offset >= total:
            break
    return orders


def _already_processed(line_item_ids: list[str]) -> set[str]:
    seen: set[str] = set()
    for i in range(0, len(line_item_ids), 100):
        chunk = line_item_ids[i : i + 100]
        rows = (
            supabase.table(_PROCESSED_TABLE)
            .select("line_item_id")
            .in_("line_item_id", chunk)
            .execute()
            .data
            or []
        )
        seen.update(r["line_item_id"] for r in rows)
    return seen


async def sync_sales_from_orders() -> dict:
    """Pull recent eBay orders and FIFO-assign each unseen line item as a sale.
    Returns {orders, items_sold}."""
    accounts = supabase.table("ebay_tokens").select("user_id").execute().data or []
    start_iso = (
        datetime.now(timezone.utc) - timedelta(days=settings.ORDERS_SYNC_LOOKBACK_DAYS)
    ).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    order_count = items_sold = 0

    async with httpx.AsyncClient(timeout=30) as client:
        for acct in accounts:
            try:
                token = await get_valid_ebay_token(acct["user_id"])
            except EbayTokenError:
                continue
            orders = await _fetch_orders(client, token, start_iso)
            order_count += len(orders)

            line_items: list[tuple] = []
            for o in orders:
                cdate = o.get("creationDate")
                for li in o.get("lineItems") or []:
                    lid, sku = li.get("lineItemId"), li.get("sku")
                    if lid and sku:
                        line_items.append((lid, o.get("orderId"), sku, cdate, li))
            if not line_items:
                continue

            seen = _already_processed([li[0] for li in line_items])
            for lid, oid, sku, cdate, li in line_items:
                if lid in seen:
                    continue
                qty = li.get("quantity") if isinstance(li.get("quantity"), int) else 1
                price = (li.get("lineItemCost") or {}).get("value")  # per-unit sale price
                items_sold += record_sale_fifo(sku, cdate, sale_price=price, count=qty)
                supabase.table(_PROCESSED_TABLE).insert(
                    {"line_item_id": lid, "order_id": oid, "sku": sku}
                ).execute()

    _mark_orders_checked()
    return {"orders": order_count, "items_sold": items_sold}


def _mark_orders_checked() -> None:
    supabase.table(_STATE_TABLE).upsert(
        {"id": 1, "last_orders_checked_at": _now_iso()}
    ).execute()


def _orders_checked_at() -> datetime | None:
    rows = (
        supabase.table(_STATE_TABLE)
        .select("last_orders_checked_at")
        .eq("id", 1)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows or not rows[0].get("last_orders_checked_at"):
        return None
    return _parse_ts(rows[0]["last_orders_checked_at"])


async def maybe_sync_sales() -> None:
    """Poll orders on startup unless polled within the configured interval.
    Swallows errors — must never block the server. Note: returns nothing useful
    until the eBay account is reconnected with the sell.fulfillment scope."""
    try:
        interval = timedelta(minutes=settings.ORDERS_SYNC_MIN_INTERVAL_MINUTES)
        last = _orders_checked_at()
        if last and datetime.now(timezone.utc) - last < interval:
            print("[sales-sync] throttled (last checked", last.isoformat(), ")")
            return
        print("[sales-sync] done:", await sync_sales_from_orders())
    except Exception as e:  # noqa: BLE001
        print("[sales-sync] skipped:", e)
