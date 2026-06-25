"""Port of app/api/ebay/increase-inventory/route.ts — bump a published
listing's quantity by 1.

Flow: find the PUBLISHED offer (by SKU or UPC) -> read canonical quantity
(inventory item is source of truth) -> +1 -> update offer -> update the
inventory item availability (preferred sync path) -> fall back to Trading API
ReviseItem, then the bulk price/quantity endpoint -> publish if not yet
published.

increase_inventory() returns (status_code, payload).
"""

import json
import re

import httpx

from app.config import settings
from app.services.ebay_client import (
    EbayTokenError,
    ebay_headers,
    get_valid_ebay_token,
    read_error_body,
)
from app.services.upc import digits_only


async def update_via_trading_api(
    client: httpx.AsyncClient,
    access_token: str,
    item_id: str | None,
    sku: str | None,
    new_quantity: int,
    is_sandbox: bool,
) -> dict:
    """ReviseItem via the legacy Trading API (XML). Used as a fallback for
    listings the Inventory API can't manage."""
    url = (
        "https://api.sandbox.ebay.com/ws/api.dll"
        if is_sandbox
        else "https://api.ebay.com/ws/api.dll"
    )
    if item_id:
        identifier = f"<ItemID>{item_id}</ItemID>"
    elif sku:
        identifier = f"<SKU>{sku}</SKU>"
    else:
        return {"success": False, "error": "Either ItemID or SKU is required for Trading API update"}

    xml = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
        f"<RequesterCredentials><eBayAuthToken>{access_token}</eBayAuthToken></RequesterCredentials>"
        f"<Item>{identifier}<Quantity>{new_quantity}</Quantity></Item>"
        "<WarningLevel>High</WarningLevel>"
        "</ReviseItemRequest>"
    )
    resp = await client.post(
        url,
        headers={
            "Content-Type": "text/xml",
            "X-EBAY-API-SITEID": "0",
            "X-EBAY-API-COMPATIBILITY-LEVEL": "1349",
            "X-EBAY-API-CALL-NAME": "ReviseItem",
            "X-EBAY-API-IAF-TOKEN": access_token,
        },
        content=xml,
    )
    body = resp.text
    if "<Ack>Success</Ack>" in body or "<Ack>Warning</Ack>" in body:
        return {"success": True}
    short = re.search(r"<ShortMessage>([\s\S]*?)</ShortMessage>", body)
    long = re.search(r"<LongMessage>([\s\S]*?)</LongMessage>", body)
    return {
        "success": False,
        "error": (long.group(1) if long else (short.group(1) if short else "Unknown error")),
        "details": body,
    }


async def increase_inventory(user_id: str, sku: str | None, upc: str | None) -> tuple[int, dict]:
    if not sku and not upc:
        return 400, {"error": "Either SKU or UPC is required"}

    try:
        access_token = await get_valid_ebay_token(user_id)
    except EbayTokenError as e:
        return e.status_code, {"error": e.message, "needsReconnect": e.needs_reconnect}

    is_sandbox = settings.EBAY_SANDBOX
    base = settings.ebay_base_url

    async with httpx.AsyncClient(timeout=30) as client:
        offers: list[dict] = []

        if upc and not sku:
            # Find inventory items matching the UPC, then their offers
            inv = await client.get(
                f"{base}/sell/inventory/v1/inventory_item?limit=25&offset=0",
                headers=ebay_headers(access_token),
            )
            if inv.status_code < 400:
                items = inv.json().get("inventoryItems", []) or []
                matching = []
                for item in items:
                    product = item.get("product")
                    if product:
                        iu = (
                            (product.get("upc") or [None])[0]
                            or product.get("gtin")
                            or next(
                                (
                                    pi.get("value")
                                    for pi in (product.get("productIdentifiers") or [])
                                    if pi.get("type") == "UPC"
                                ),
                                None,
                            )
                        )
                        if iu and digits_only(iu) == digits_only(upc):
                            matching.append(item.get("sku"))
                for item_sku in matching:
                    r = await client.get(
                        f"{base}/sell/inventory/v1/offer?sku={item_sku}&limit=25",
                        headers=ebay_headers(access_token),
                    )
                    if r.status_code < 400:
                        offers.extend(r.json().get("offers", []) or [])

        if sku and not offers:
            r = await client.get(
                f"{base}/sell/inventory/v1/offer?sku={sku}&limit=25",
                headers=ebay_headers(access_token),
            )
            if r.status_code < 400:
                offers.extend(r.json().get("offers", []) or [])

        # Prefer a PUBLISHED offer with a listing id
        offer = next(
            (o for o in offers if o.get("status") == "PUBLISHED" and o.get("listing", {}).get("listingId")),
            None,
        ) or next((o for o in offers if o.get("status") == "PUBLISHED"), None)

        if not offer:
            return 404, {
                "error": "No published listing found for this product. The item may not be "
                "currently listed on eBay, or there may be an unpublished draft. Please list the "
                "item first before increasing inventory.",
                "hint": "If you see a duplicate notice, try refreshing and checking your eBay listings.",
            }

        offer_id = offer.get("offerId")
        offer_status = offer.get("status")
        listing_id = offer.get("listingId") or offer.get("listing", {}).get("listingId")

        if not offer_id:
            return 404, {"error": "Offer ID not found"}
        if offer_status != "PUBLISHED":
            return 400, {
                "error": f'Cannot increase inventory for unpublished offer. The offer status is '
                f'"{offer_status}". Only published listings can have their inventory increased.',
                "hint": "Please ensure the item is published on eBay before trying to increase inventory.",
            }

        get_offer_url = f"{base}/sell/inventory/v1/offer/{offer_id}"
        go = await client.get(get_offer_url, headers=ebay_headers(access_token))
        if go.status_code >= 400:
            error_data, _ = read_error_body(go)
            return go.status_code, {
                "error": f"Failed to get offer details: {go.status_code}",
                "details": error_data,
            }
        current_offer = go.json()

        # Canonical current quantity: prefer the inventory item's quantity
        current_quantity = (
            current_offer.get("availableQuantity")
            if isinstance(current_offer.get("availableQuantity"), int)
            else 0
        )
        offer_sku = current_offer.get("sku")
        try:
            if offer_sku:
                ii = await client.get(
                    f"{base}/sell/inventory/v1/inventory_item/{offer_sku}",
                    headers=ebay_headers(access_token),
                )
                if ii.status_code < 400:
                    q = ii.json().get("availability", {}).get("shipToLocationAvailability", {}).get("quantity")
                    if isinstance(q, int):
                        current_quantity = q
        except Exception as e:  # noqa: BLE001
            print("[INVENTORY] Could not fetch inventory item for canonical quantity:", e)

        if not isinstance(current_quantity, int) or current_quantity < 0:
            current_quantity = 0
        new_quantity = current_quantity + 1

        # Update the offer
        listing_description = (current_offer.get("listingDescription") or "").strip() or "No description provided."
        if len(listing_description) == 0 or len(listing_description) > 500000:
            listing_description = "Product listing."
        update_payload = {
            "sku": current_offer.get("sku"),
            "marketplaceId": current_offer.get("marketplaceId") or "EBAY_US",
            "format": current_offer.get("format") or "FIXED_PRICE",
            "availableQuantity": new_quantity,
            "listingDescription": listing_description,
            "listingDuration": current_offer.get("listingDuration") or "GTC",
            "pricingSummary": current_offer.get("pricingSummary"),
            "categoryId": current_offer.get("categoryId"),
        }
        if current_offer.get("includeCatalogProductDetails") is not None:
            update_payload["includeCatalogProductDetails"] = current_offer["includeCatalogProductDetails"]
        if current_offer.get("listingPolicies"):
            update_payload["listingPolicies"] = current_offer["listingPolicies"]
        if current_offer.get("merchantLocationKey"):
            update_payload["merchantLocationKey"] = current_offer["merchantLocationKey"]
        if current_offer.get("product"):
            update_payload["product"] = current_offer["product"]

        upd = await client.put(
            get_offer_url, headers=ebay_headers(access_token), content=json.dumps(update_payload)
        )
        if upd.status_code >= 400:
            error_data, error_text = read_error_body(upd)
            print("[INVENTORY] Failed to update offer:", upd.status_code, error_data, error_text)
            return upd.status_code, {
                "error": f"Failed to update inventory: {upd.status_code}",
                "details": error_data,
            }

        active_listing_id = listing_id or current_offer.get("listing", {}).get("listingId")

        if offer_status == "PUBLISHED" or active_listing_id or current_offer.get("listing", {}).get("listingStatus") == "ACTIVE":
            # Preferred: update the inventory item availability (source of truth)
            try:
                inv_url = f"{base}/sell/inventory/v1/inventory_item/{offer_sku}"
                gi = await client.get(inv_url, headers=ebay_headers(access_token))
                if gi.status_code < 400:
                    inventory_item = gi.json()
                    avail = dict(inventory_item.get("availability") or {})
                    ship = dict(avail.get("shipToLocationAvailability") or {})
                    ship["quantity"] = new_quantity
                    avail["shipToLocationAvailability"] = ship
                    inventory_item["availability"] = avail
                    ui = await client.put(
                        inv_url, headers=ebay_headers(access_token), content=json.dumps(inventory_item)
                    )
                    if ui.status_code < 400:
                        vi = await client.get(inv_url, headers=ebay_headers(access_token))
                        if vi.status_code < 400:
                            vq = vi.json().get("availability", {}).get("shipToLocationAvailability", {}).get("quantity")
                            if vq == new_quantity:
                                return 200, {
                                    "success": True,
                                    "newQuantity": new_quantity,
                                    "message": f"Inventory increased successfully! Quantity updated to "
                                    f"{new_quantity}. Changes should appear on your eBay listing within "
                                    f"1-2 minutes.",
                                    "listingId": active_listing_id or None,
                                    "method": "inventory_item_update",
                                }
                    else:
                        ed, et = read_error_body(ui)
                        print("[INVENTORY] Failed to update inventory item:", ui.status_code, ed, et)
            except Exception as e:  # noqa: BLE001
                print("[INVENTORY] Error updating inventory item:", e)

            # Fallback 1: Trading API ReviseItem
            if active_listing_id:
                tr = await update_via_trading_api(
                    client, access_token, active_listing_id, sku or current_offer.get("sku"),
                    new_quantity, is_sandbox,
                )
                if tr.get("success"):
                    return 200, {
                        "success": True,
                        "newQuantity": new_quantity,
                        "message": f"Inventory increased successfully! Quantity updated to {new_quantity} "
                        f"on your eBay listing.",
                        "listingId": active_listing_id,
                        "method": "trading_api",
                    }

            # Fallback 2: bulk_update_price_quantity (offerId, then SKU)
            bulk_url = f"{base}/sell/inventory/v1/bulk_update_price_quantity"
            ps = current_offer.get("pricingSummary") or {}
            price = ps.get("price", {})
            current_price = price.get("value") or price or "0.00"
            currency = price.get("currency") or "USD"
            payload_offer = {"requests": [{"offerId": offer_id, "availableQuantity": new_quantity,
                                           "price": {"value": str(current_price), "currency": currency}}]}
            payload_sku = {"requests": [{"sku": offer_sku, "availableQuantity": new_quantity,
                                         "price": {"value": str(current_price), "currency": currency}}]}

            bulk = await client.post(bulk_url, headers=ebay_headers(access_token), content=json.dumps(payload_offer))
            if bulk.status_code >= 400:
                bulk = await client.post(bulk_url, headers=ebay_headers(access_token), content=json.dumps(payload_sku))

            if bulk.status_code >= 400:
                error_data, error_text = read_error_body(bulk)
                print("[INVENTORY] Bulk update failed:", bulk.status_code, error_data, error_text)
                not_supported = (
                    "not currently supported" in error_text
                    or "not supported" in error_text
                    or any(
                        (e.get("message") or "").find("not supported") >= 0
                        or e.get("errorId") in (25710, 25002)
                        for e in (error_data.get("errors") or [])
                    )
                )
                if (not_supported or bulk.status_code == 400) and active_listing_id:
                    tr = await update_via_trading_api(
                        client, access_token, active_listing_id, sku or current_offer.get("sku"),
                        new_quantity, is_sandbox,
                    )
                    if tr.get("success"):
                        return 200, {
                            "success": True,
                            "newQuantity": new_quantity,
                            "message": f"Inventory increased successfully! Quantity updated to "
                            f"{new_quantity} on your eBay listing (via Trading API).",
                            "listingId": active_listing_id,
                            "method": "trading_api",
                        }
                    return 400, {
                        "success": False,
                        "error": f"Failed to update quantity. This listing may have restrictions. "
                        f"Error: {tr.get('error')}",
                        "listingId": active_listing_id,
                        "inventoryApiError": error_data,
                        "tradingApiError": tr.get("details"),
                    }
                return 200, {
                    "success": True,
                    "newQuantity": new_quantity,
                    "warning": f"Offer quantity updated to {new_quantity}, but failed to update live "
                    f"listing. Error: {bulk.status_code}",
                    "listingId": active_listing_id or None,
                    "details": error_data,
                }

            bulk_result = bulk.json() if bulk.text else {}
            responses = bulk_result.get("responses") or []
            errs = [e for r in responses for e in (r.get("errors") or [])]
            if errs:
                not_supported = any(
                    (e.get("message") or "").find("not supported") >= 0 or e.get("errorId") in (25710, 25002)
                    for e in errs
                )
                if not_supported and active_listing_id:
                    tr = await update_via_trading_api(
                        client, access_token, active_listing_id, sku or current_offer.get("sku"),
                        new_quantity, is_sandbox,
                    )
                    if tr.get("success"):
                        return 200, {
                            "success": True,
                            "newQuantity": new_quantity,
                            "message": f"Inventory increased successfully! Quantity updated to "
                            f"{new_quantity} on your eBay listing (via Trading API).",
                            "listingId": active_listing_id,
                            "method": "trading_api",
                        }
                return 400, {
                    "success": False,
                    "error": f"Failed to update live listing quantity: {errs[0].get('message', 'Unknown error')}",
                    "listingId": active_listing_id or None,
                    "details": errs,
                }

            return 200, {
                "success": True,
                "newQuantity": new_quantity,
                "message": f"Inventory increased successfully! Quantity updated from {current_quantity} "
                f"to {new_quantity} on your eBay listing.",
                "listingId": active_listing_id or None,
                "bulkUpdateResult": bulk_result,
            }

        # Not published yet -> publish
        pub = await client.post(
            f"{base}/sell/inventory/v1/offer/{offer_id}/publish", headers=ebay_headers(access_token)
        )
        if pub.status_code >= 400:
            error_data, _ = read_error_body(pub)
            return 200, {
                "success": True,
                "newQuantity": new_quantity,
                "warning": "Inventory updated but failed to publish. You may need to publish manually.",
                "details": error_data,
            }
        publish_result = pub.json() if pub.text else {}
        return 200, {
            "success": True,
            "newQuantity": new_quantity,
            "message": "Inventory increased and published successfully",
            "listingId": publish_result.get("listingId"),
        }
