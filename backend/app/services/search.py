"""Port of app/api/ebay/search/route.ts — UPC product search.

Returns a single flattened product object (a random Browse API result with its
price replaced by the mean of the first results), enriched with a stock image
from the Catalog API when one of usable size is available, else the seller
image. The SPA's ProductSearch page consumes this exact shape.
"""

import random
import re

import httpx

from app.config import settings
from app.services.ebay_client import EbayTokenError, debug_log, get_valid_ebay_token


def _image_size_from_url(url: str | None) -> int:
    """Pixel size from an eBay image URL (/s-l640.jpg -> 640). 999 if no size
    param (treat as probably-full-res), 0 if no url."""
    if not url:
        return 0
    m = re.search(r"/s-l(\d+)\.jpg", url, re.IGNORECASE)
    return int(m.group(1)) if m else 999


def _high_res_image_url(url: str | None) -> dict | None:
    if not url:
        return None
    size = _image_size_from_url(url)
    if size >= 1200:
        return {"url": url, "isHighRes": True}
    if size > 640:
        return {"url": url, "isHighRes": True}
    if size == 640:
        return {"url": url, "isHighRes": False}
    if 500 <= size < 640:
        return {"url": url, "isHighRes": True}
    if 0 < size < 500:
        return {"url": re.sub(r"/s-l\d+\.jpg", "/s-l500.jpg", url, flags=re.IGNORECASE),
                "isHighRes": False}
    return {"url": url, "isHighRes": True}


def _high_res_image(image: dict | None) -> dict | None:
    if not image or not image.get("imageUrl"):
        return image
    result = _high_res_image_url(image["imageUrl"])
    if result:
        return {**image, "imageUrl": result["url"]}
    return None


async def search_product(
    user_id: str, value: str, search_type: str = "upc"
) -> tuple[int, dict]:
    """search_type:
    - "upc":   exact GTIN match (Browse API `gtin` filter) — no fuzzy results.
    - "title": keyword search (approximate).
    - "any":   keyword search across all fields (approximate).
    """
    try:
        access_token = await get_valid_ebay_token(user_id)
    except EbayTokenError as e:
        return e.status_code, {
            "error": e.message,
            "needsReconnect": e.needs_reconnect,
            "details": e.details,
        }

    base = settings.ebay_base_url
    browse_headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    }

    is_upc = search_type == "upc"
    # Browse API: `gtin` is an exact-match filter; `q` is fuzzy keyword search.
    browse_params = (
        {"gtin": value, "fieldgroups": "EXTENDED"}
        if is_upc
        else {"q": value, "fieldgroups": "EXTENDED"}
    )

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(
            f"{base}/buy/browse/v1/item_summary/search",
            params=browse_params,
            headers=browse_headers,
        )
        if r.status_code >= 400:
            text = r.text
            try:
                import json
                ed = json.loads(text) if text else {}
            except (ValueError, TypeError):
                ed = {}
            msg = (ed.get("errors") or [{}])[0].get("message") or "Failed to search eBay"
            return r.status_code, {"error": msg, "details": ed}

        data = r.json()
        items = data.get("itemSummaries") or []
        if not items:
            msg = (
                "No products found for this UPC code"
                if is_upc
                else "No products found matching your search"
            )
            return 404, {"error": msg}

        # Mean price across the first 10 items that have a price
        items_for_mean = items[:10]
        prices = [
            float(i["price"]["value"])
            for i in items_for_mean
            if i.get("price", {}).get("value")
        ]
        mean_price = f"{sum(prices) / len(prices):.2f}" if prices else "0.00"

        # Pick a RANDOM item, but display the mean price
        random_index = random.randrange(len(items))
        selected = items[random_index]
        product = {
            **selected,
            "price": {
                **(selected.get("price") or {}),
                "value": mean_price,
                "currency": (selected.get("price") or {}).get("currency") or "USD",
            },
        }

        original_seller_image = product.get("image")
        original_seller_additional = product.get("additionalImages") or []

        # Image enrichment: prefer a usable (>640px) Catalog stock image, else
        # fall back to the seller image. Never fatal — any failure keeps seller.
        try:
            cat = await client.get(
                f"{base}/commerce/catalog/v1_beta/product_summary/search",
                params=(
                    {"gtin": value, "fieldgroups": "FULL"}
                    if is_upc
                    else {"q": value, "fieldgroups": "FULL"}
                ),
                headers=browse_headers,
            )
            source = "seller_only"
            if cat.status_code < 400:
                summaries = (cat.json() or {}).get("productSummaries") or []
                if summaries:
                    cp = summaries[0]
                    stock_image = cp.get("image")
                    stock_additional = cp.get("additionalImages") or []
                    if stock_image and stock_image.get("imageUrl"):
                        size = _image_size_from_url(stock_image["imageUrl"])
                        if 0 < size <= 640:
                            source = "seller_only_fallback_due_to_size"
                        else:
                            hi = _high_res_image(stock_image)
                            if not hi:
                                source = "seller_only_fallback_conversion_failed"
                            else:
                                hi_additional = []
                                for img in stock_additional:
                                    obj = {"imageUrl": img} if isinstance(img, str) else img
                                    conv = _high_res_image(obj) or obj
                                    sz = _image_size_from_url(conv.get("imageUrl"))
                                    if sz == 0 or sz > 640:
                                        hi_additional.append(conv)
                                product["image"] = hi
                                product["additionalImages"] = (
                                    hi_additional if hi_additional else original_seller_additional
                                )
                                source = "stock_preferred_with_seller_fallback"
            product["_imageSources"] = {"source": source}
        except Exception as e:  # noqa: BLE001
            debug_log("[IMAGE FETCH] exception:", e)
            product["_imageSources"] = {"source": "seller_only"}

        product["_searchMetadata"] = {
            "totalResults": len(items),
            "selectedIndex": random_index,
            "itemsUsedForMean": len(prices),
            "isMeanPrice": True,
            "originalPrice": (selected.get("price") or {}).get("value"),
            "meanPrice": mean_price,
            "searchQuery": value,
            "searchType": search_type,
        }
        return 200, product
