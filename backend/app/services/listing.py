"""Port of app/api/ebay/list/route.ts — create an eBay listing.

Flow: validate -> claim SKU -> build product -> validate required aspects ->
PUT inventory item -> get location -> resolve policies -> POST offer (handle
25002 "offer exists" by updating) -> publish (handle missing item-specifics) ->
optional Best Offer ensure/recreate -> success.

create_listing() returns (status_code, payload) so the route can return a
JSONResponse with the matching status, preserving the Next.js response shapes.
"""

import difflib
import json
import re

import httpx

from app.config import settings
from app.constants import DEFAULT_SELLER_NOTE
from app.db import fetch_one, supabase
from app.services.ebay_client import (
    EbayTokenError,
    debug_log,
    ebay_headers,
    first_error,
    get_valid_ebay_token,
    read_error_body,
)
from app.services.media import MEDIA_FORMAT_ASPECT, MEDIA_TITLE_ASPECT

_CONDITION_MAP = {
    "Brand New": "NEW",
    "New Other": "NEW_OTHER",
    "New with Defects": "NEW_WITH_DEFECTS",
    "Manufacturer Refurbished": "MANUFACTURER_REFURBISHED",
    "Seller Refurbished": "SELLER_REFURBISHED",
    "Used - Excellent": "USED_EXCELLENT",
    "Used - Very Good": "USED_VERY_GOOD",
    "Used - Good": "USED_GOOD",
    "Used - Acceptable": "USED_ACCEPTABLE",
    "For Parts or Not Working": "FOR_PARTS_OR_NOT_WORKING",
}


def map_condition_to_ebay(condition: str) -> str:
    return _CONDITION_MAP.get(condition, "NEW")


def _num(value) -> float | None:
    """Parse a numeric form value (str/number) to float, or None if blank/invalid."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def auto_adopt_aspects(defs: list, formatted_aspects: dict, text_src: str) -> list[str]:
    """Feature 1: auto-fill item specifics from eBay's category data where we're
    confident, so the user isn't prompted for them. Conservatively adopts:
      - any aspect whose text-based guess matches an eBay allowed value
        (high confidence — this is eBay's own suggested value),
      - required aspects that have exactly one allowed value,
      - required free-text aspects with a non-empty text guess.

    Mutates `formatted_aspects` in place; returns the aspect names it filled.
    """
    existing = {k.lower() for k in formatted_aspects}
    adopted: list[str] = []
    for a in defs:
        name = a.get("localizedAspectName") or a.get("aspectName")
        if not name or name.lower() in existing:
            continue
        constraint = a.get("aspectConstraint", {}) or {}
        required = constraint.get("aspectRequired") is True
        mode = constraint.get("aspectMode")
        allowed = [
            (x.get("localizedValue") or x.get("value"))
            for x in (a.get("aspectValues") or [])
            if (x.get("localizedValue") or x.get("value"))
        ]
        guess = extract_aspect_value(name, text_src)
        value = None
        if allowed:
            lower_map = {al.lower(): al for al in allowed}
            if guess and guess.lower() in lower_map:
                value = lower_map[guess.lower()]  # confident match -> canonical casing
            elif required and len(allowed) == 1:
                value = allowed[0]  # only one valid choice
        elif required and mode != "SELECTION_ONLY" and guess:
            value = guess  # required free-text aspect, best-effort guess
        if value:
            formatted_aspects[name] = [value]
            existing.add(name.lower())
            adopted.append(name)
    return adopted


def validate_genre_against_allowed(defs: list, formatted_aspects: dict | None) -> dict | None:
    """Validate the listing's "Genre" item specific against eBay's allowed values.

    - No Genre value, no Genre aspect, or a free-text Genre aspect -> returns None.
    - Genre value matches an allowed value -> normalizes its casing in place, None.
    - Otherwise -> returns {rejected, suggestion, allowed} so the caller can ask
      the user "did you mean ...?".
    """
    if not formatted_aspects:
        return None
    genre_key = next((k for k in formatted_aspects if k.lower() == "genre"), None)
    if not genre_key:
        return None
    vals = formatted_aspects.get(genre_key) or []
    current = (vals[0] if isinstance(vals, list) and vals else "").strip()
    if not current:
        return None

    gdef = next(
        (a for a in defs if (a.get("localizedAspectName") or a.get("aspectName") or "").lower() == "genre"),
        None,
    )
    if not gdef:
        return None
    allowed = [
        (x.get("localizedValue") or x.get("value"))
        for x in (gdef.get("aspectValues") or [])
        if (x.get("localizedValue") or x.get("value"))
    ]
    mode = (gdef.get("aspectConstraint", {}) or {}).get("aspectMode")
    # Only validate when eBay constrains Genre to a value list (not free text).
    if not allowed or mode == "FREE_TEXT":
        return None

    lower_map = {a.lower(): a for a in allowed}
    if current.lower() in lower_map:
        formatted_aspects[genre_key] = [lower_map[current.lower()]]  # canonical casing
        return None

    match = difflib.get_close_matches(current, allowed, n=1, cutoff=0.4)
    return {"rejected": current, "suggestion": match[0] if match else None, "allowed": allowed}


def build_package_weight_and_size(dimensions: dict | None, weight: dict | None) -> dict | None:
    """Map the form's dimensions/weight to eBay's packageWeightAndSize object.

    eBay dimensions use height/length/width (depth -> length). Unit enums are the
    uppercase form of the catalog values: INCH/CENTIMETER, OUNCE/POUND/GRAM/KILOGRAM.
    Only emits a sub-object when it has the values eBay requires.
    """
    result: dict = {}

    if isinstance(dimensions, dict):
        h = _num(dimensions.get("height"))
        w = _num(dimensions.get("width"))
        d = _num(dimensions.get("depth"))
        unit = (dimensions.get("unit") or "").strip().upper()
        # eBay requires all three dimensions and a unit together.
        if None not in (h, w, d) and unit:
            result["dimensions"] = {
                "height": h,
                "length": d,  # depth maps to eBay's "length"
                "width": w,
                "unit": unit,
            }

    if isinstance(weight, dict):
        value = _num(weight.get("value"))
        unit = (weight.get("unit") or "").strip().upper()
        if value is not None and unit:
            result["weight"] = {"value": value, "unit": unit}

    return result or None


def extract_aspect_value(aspect_name: str, text: str) -> str | None:
    """Best-effort guess for a missing aspect from free text (title/desc)."""
    if not text:
        return None
    aspect_lower = aspect_name.lower()
    text_lower = text.lower()

    if aspect_lower == "platform":
        m = re.search(r"platform:\s*([^.,;]+)", text, re.IGNORECASE)
        if m:
            return m.group(1).strip()
        if "ps5" in text_lower or "playstation 5" in text_lower:
            return "PlayStation 5"
        if "ps4" in text_lower or "playstation 4" in text_lower:
            return "PlayStation 4"
        if "xbox one" in text_lower:
            return "Xbox One"
        if "xbox series" in text_lower:
            return "Xbox Series X|S"
        if "nintendo switch" in text_lower:
            return "Nintendo Switch"
        if "pc" in text_lower and "ps" not in text_lower:
            return "PC"

    m = re.search(rf"{re.escape(aspect_name)}:\s*([^.,;]+)", text, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    return None


# --- Best Offer helpers (port of the same-named TS helpers) -----------------


async def _log_offer_state(client, base, token, offer_id, label) -> dict | None:
    try:
        r = await client.get(
            f"{base}/sell/inventory/v1/offer/{offer_id}", headers=ebay_headers(token)
        )
        if r.status_code >= 400:
            return None
        return r.json()
    except Exception:  # noqa: BLE001
        return None


def _has_best_offer(offer_details: dict | None) -> bool:
    return bool((offer_details or {}).get("bestOfferTerms", {}).get("bestOfferEnabled"))


async def _try_ensure_best_offer(client, base, token, offer_id, offer_payload) -> dict:
    before = await _log_offer_state(client, base, token, offer_id, "ENSURE_BEFORE_RETRY")
    if _has_best_offer(before):
        return {"ensured": True, "attempted": False}

    r = await client.put(
        f"{base}/sell/inventory/v1/offer/{offer_id}",
        headers=ebay_headers(token),
        content=json.dumps(offer_payload),
    )
    if r.status_code >= 400:
        return {"ensured": False, "attempted": True}
    after = await _log_offer_state(client, base, token, offer_id, "ENSURE_AFTER_RETRY")
    return {"ensured": _has_best_offer(after), "attempted": True}


async def _recreate_offer_with_best_offer(client, base, token, existing_offer_id, offer_payload) -> dict:
    # Withdraw first; abort the recreate if it fails rather than risk deleting a
    # live listing we can't cleanly take down.
    try:
        w = await client.post(
            f"{base}/sell/inventory/v1/offer/{existing_offer_id}/withdraw",
            headers=ebay_headers(token),
            content=json.dumps({"reason": "OTHER"}),
        )
        if w.status_code >= 400:
            return {"recreated": False, "ensured": False}
    except Exception:  # noqa: BLE001
        return {"recreated": False, "ensured": False}

    d = await client.delete(
        f"{base}/sell/inventory/v1/offer/{existing_offer_id}", headers=ebay_headers(token)
    )
    if d.status_code >= 400:
        return {"recreated": False, "ensured": False}

    c = await client.post(
        f"{base}/sell/inventory/v1/offer",
        headers=ebay_headers(token),
        content=json.dumps(offer_payload),
    )
    if c.status_code >= 400:
        return {"recreated": False, "ensured": False}
    new_offer_id = (c.json() or {}).get("offerId")
    if not new_offer_id:
        return {"recreated": False, "ensured": False}

    p = await client.post(
        f"{base}/sell/inventory/v1/offer/{new_offer_id}/publish", headers=ebay_headers(token)
    )
    if p.status_code >= 400:
        return {"recreated": True, "ensured": False, "recreatedOfferId": new_offer_id}

    publish_data = p.json() if p.text else {}
    state = await _log_offer_state(client, base, token, new_offer_id, "RECREATE_AFTER_PUBLISH")
    return {
        "recreated": True,
        "ensured": _has_best_offer(state),
        "recreatedOfferId": new_offer_id,
        "recreatedListingId": publish_data.get("listingId"),
    }


async def create_listing(user_id: str, body: dict) -> tuple[int, dict]:
    title = body.get("title")
    description = body.get("description")
    price = body.get("price")
    condition = body.get("condition")
    condition_description = body.get("conditionDescription")
    image_url = body.get("imageUrl")
    category_id = body.get("categoryId")
    upc = body.get("upc")
    ean = body.get("ean")
    isbn = body.get("isbn")
    mpn = body.get("mpn")
    brand = body.get("brand")
    aspects = body.get("aspects")
    epid = body.get("epid")
    additional_images = body.get("additionalImages")
    categories = body.get("categories")
    short_description = body.get("shortDescription")
    dimensions = body.get("dimensions")  # {height, width, depth, unit}
    weight = body.get("weight")  # {value, unit}
    media_type = body.get("mediaType")  # for the Format aspect safety net
    artist = body.get("artist")  # CD/Cassette only -> "Artist" item specific

    missing: list[str] = []

    if not title or (isinstance(title, str) and not title.strip()):
        missing.append("title")
    else:
        title = title.strip()

    # Description default (preserve intentional empty -> default)
    if description is None:
        description = "No description provided."
    elif isinstance(description, str) and not description.strip():
        description = "No description provided."
    else:
        description = description.strip()

    # Seller note (+ user settings, loaded together)
    seller_note_settings = fetch_one("seller_note_settings", user_id)
    offer_settings = fetch_one("offer_settings", user_id)
    saved_policies = fetch_one("ebay_business_policies", user_id)
    saved_location = fetch_one("ebay_inventory_location", user_id)

    seller_note = DEFAULT_SELLER_NOTE
    if seller_note_settings and seller_note_settings.get("enable_seller_note_editing"):
        universal = (seller_note_settings.get("seller_note_text") or "").strip()
        seller_note = universal if universal else DEFAULT_SELLER_NOTE
    elif condition_description is not None:
        if not isinstance(condition_description, str):
            return 400, {"error": "conditionDescription must be a string"}
        trimmed = condition_description.strip()
        seller_note = trimmed if trimmed else DEFAULT_SELLER_NOTE

    try:
        price_num = float(price)
    except (TypeError, ValueError):
        price_num = 0.0
    if not price or price_num <= 0:
        missing.append("price (must be a valid number greater than 0)")

    if not condition or (isinstance(condition, str) and not condition.strip()):
        missing.append("condition")
    else:
        condition = condition.strip()

    has_image = bool(image_url and image_url.strip()) or bool(
        isinstance(additional_images, list) and additional_images
    )
    if not has_image:
        missing.append("image (at least one product image is required)")

    if missing:
        return 400, {
            "error": f"Missing or invalid required fields: {', '.join(missing)}",
            "received": {
                "title": title or None,
                "description": description or None,
                "price": price,
                "condition": condition or None,
                "hasImage": has_image,
            },
        }

    # eBay token
    try:
        access_token = await get_valid_ebay_token(user_id)
    except EbayTokenError as e:
        return e.status_code, {
            "error": e.message,
            "needsReconnect": e.needs_reconnect,
            "details": e.details,
        }

    base = settings.ebay_base_url

    # Atomically claim SKU counter via the Postgres function
    prefix, counter = "SKU", 1
    try:
        res = supabase.rpc("claim_sku_counter", {"p_user_id": user_id}).execute()
        if res.data:
            row = res.data[0]
            counter = row["claimed_counter"]
            prefix = row.get("prefix") or "SKU"
    except Exception as e:  # noqa: BLE001
        print("SKU counter claim failed, using default:", e)
    sku = f"{prefix}-0000{counter}"
    debug_log("Generated SKU:", sku)

    # Build product object
    product_obj: dict = {"title": title[:80]}
    if epid and epid.strip():
        product_obj["epid"] = epid.strip()
    if description and description.strip() and description != "No description":
        product_obj["description"] = description[:50000]

    all_images: list[str] = []
    if image_url and image_url.strip():
        all_images.append(image_url.strip())
    if isinstance(additional_images, list):
        for img in additional_images:
            img_url = img if isinstance(img, str) else (img or {}).get("imageUrl")
            if img_url and img_url.strip() and img_url not in all_images:
                all_images.append(img_url.strip())
    if all_images:
        product_obj["imageUrls"] = all_images[:12]

    if upc and upc.strip():
        product_obj["upc"] = [upc.strip()]
    if ean and ean.strip():
        product_obj["ean"] = [ean.strip()]
    if isbn and isbn.strip():
        product_obj["isbn"] = [isbn.strip()]
    if mpn and mpn.strip():
        product_obj["mpn"] = mpn.strip()
    if brand and brand.strip():
        product_obj["brand"] = brand.strip()

    # Aspects (Browse array form or dict form)
    formatted_aspects: dict | None = None
    if isinstance(aspects, (dict, list)) and aspects:
        formatted_aspects = {}
        if isinstance(aspects, list):
            for a in aspects:
                if a.get("name") and a.get("value") is not None:
                    v = a["value"]
                    formatted_aspects[a["name"]] = v if isinstance(v, list) else [v]
        else:
            for k, v in aspects.items():
                formatted_aspects[k] = v if isinstance(v, list) else [v]
        if "Brand" not in formatted_aspects and brand and brand.strip():
            formatted_aspects["Brand"] = [brand.strip()]
        if (
            "MPN" not in formatted_aspects
            and "Manufacturer Part Number" not in formatted_aspects
            and mpn
            and mpn.strip()
        ):
            formatted_aspects["MPN"] = [mpn.strip()]
        product_obj["aspects"] = formatted_aspects
    elif brand and brand.strip():
        formatted_aspects = {"Brand": [brand.strip()]}
        product_obj["aspects"] = formatted_aspects

    # Safety net: auto-fill required item specifics from the media type if the
    # caller didn't already provide them (case-insensitive check).
    #   - "Format"        <- media type (e.g. DVD, Blu-ray, 4K UHD)
    #   - title aspect    <- listing title (e.g. "Movie/TV Title")
    mt = (media_type or "").strip()
    auto_aspects: list[tuple[str, str | None]] = [
        ("Format", MEDIA_FORMAT_ASPECT.get(mt)),
        (MEDIA_TITLE_ASPECT.get(mt) or "", (title or "").strip()[:65] if title else None),
    ]
    # Artist applies to music formats only (CD/Cassette).
    if mt in ("CD", "Cassette") and artist and artist.strip():
        auto_aspects.append(("Artist", artist.strip()[:65]))
    for aspect_name, aspect_value in auto_aspects:
        if not aspect_name or not aspect_value:
            continue
        if formatted_aspects is None:
            formatted_aspects = {}
        already_set = any(
            k.lower() == aspect_name.lower() and formatted_aspects.get(k)
            for k in formatted_aspects
        )
        if not already_set:
            formatted_aspects[aspect_name] = [aspect_value]
            product_obj["aspects"] = formatted_aspects

    # Final category
    final_category_id = category_id
    if not final_category_id and isinstance(categories, list) and categories:
        primary = categories[0]
        if primary and primary.get("categoryId"):
            final_category_id = primary["categoryId"]
    if not final_category_id:
        final_category_id = "267"  # Movies & TV default

    async with httpx.AsyncClient(timeout=30) as client:
        # Validate required aspects up-front (prevent 25002)
        try:
            v = await client.get(
                f"{base}/sell/taxonomy/v1/category_tree/0/get_item_aspects_for_category"
                f"?category_id={final_category_id}",
                headers=ebay_headers(access_token),
            )
            if v.status_code < 400:
                defs = v.json().get("aspects", []) or []
                text_src = short_description or description or title or ""

                # Feature 1: auto-adopt eBay's suggested item specifics where we
                # have a confident value, reducing how often the user is prompted.
                if formatted_aspects is None:
                    formatted_aspects = {}
                adopted = auto_adopt_aspects(defs, formatted_aspects, text_src)
                if adopted:
                    product_obj["aspects"] = formatted_aspects
                    debug_log("Auto-adopted item specifics:", adopted)

                required = [
                    (a.get("localizedAspectName") or a.get("aspectName"))
                    for a in defs
                    if a.get("aspectConstraint", {}).get("aspectRequired") is True
                ]
                name_map = {k.lower(): k for k in (formatted_aspects or {}).keys()}
                missing_aspects: list[str] = []
                for req in required:
                    rl = req.lower()
                    exact = name_map.get(rl)
                    key = exact or next(
                        (name_map[k] for k in name_map if k == rl or rl in k or k in rl),
                        None,
                    )
                    vals = formatted_aspects.get(key) if (key and formatted_aspects) else None
                    if not vals or (isinstance(vals, list) and len(vals) == 0):
                        missing_aspects.append(req)

                if missing_aspects:
                    defs_out = []
                    for ma in missing_aspects:
                        ad = next(
                            (
                                a
                                for a in defs
                                if (a.get("localizedAspectName") or a.get("aspectName")) == ma
                                or (a.get("localizedAspectName") or a.get("aspectName") or "").lower()
                                == ma.lower()
                            ),
                            None,
                        )
                        defs_out.append(
                            {
                                "name": (ad.get("localizedAspectName") or ad.get("aspectName"))
                                if ad
                                else ma,
                                "required": True,
                                "values": [
                                    (x.get("localizedValue") or x.get("value"))
                                    for x in (ad.get("aspectValues") or [])
                                ]
                                if ad
                                else [],
                                "suggestedValue": extract_aspect_value(ma, text_src),
                            }
                        )
                    return 400, {
                        "error": "Missing required item specifics for this category",
                        "missingItemSpecifics": missing_aspects,
                        "requiredAspects": required,
                        "currentAspects": formatted_aspects or {},
                        "categoryId": final_category_id,
                        "hint": f"This category requires the following item specifics: "
                        f"{', '.join(missing_aspects)}. Please provide these details before listing.",
                        "action": "missing_item_specifics",
                        "canRetry": False,
                        "aspectDefinitions": defs_out,
                    }

                # Validate Genre against eBay's allowed values (after required
                # aspects are satisfied). Returns a "did you mean" prompt if the
                # value isn't accepted for a constrained Genre aspect.
                genre_issue = validate_genre_against_allowed(defs, formatted_aspects)
                if genre_issue:
                    suggestion = genre_issue["suggestion"]
                    hint = (
                        f'Did you mean "{suggestion}"? If no, type SKIP to drop the genre.'
                        if suggestion
                        else "No close match found. Type SKIP to drop the genre, or enter an allowed value."
                    )
                    return 400, {
                        "error": f'Genre "{genre_issue["rejected"]}" isn\'t an accepted '
                        "eBay value for this category.",
                        "action": "genre_suggestion",
                        "genreRejectedValue": genre_issue["rejected"],
                        "genreSuggestion": suggestion,
                        "genreAllowedValues": genre_issue["allowed"],
                        "categoryId": final_category_id,
                        "hint": hint,
                        "canRetry": False,
                    }
        except Exception as e:  # noqa: BLE001
            print("Could not validate aspects (continuing):", e)

        # Step 1: create inventory item
        inventory_payload = {
            "product": product_obj,
            "condition": map_condition_to_ebay(condition),
            "availability": {"shipToLocationAvailability": {"quantity": 1}},
            "conditionDescription": seller_note,
        }
        package = build_package_weight_and_size(dimensions, weight)
        if package:
            inventory_payload["packageWeightAndSize"] = package
        inv = await client.put(
            f"{base}/sell/inventory/v1/inventory_item/{sku}",
            headers=ebay_headers(access_token),
            content=json.dumps(inventory_payload),
        )
        if inv.status_code != 204 and inv.status_code >= 400:
            error_data, _ = read_error_body(inv)
            fe = first_error(error_data)
            msg = fe.get("message") or fe.get("longMessage") or error_data.get("message") or "Failed to create inventory item"
            code = fe.get("errorId") or fe.get("code")
            needs_reconnect = code == 2004
            hint = "Make sure your eBay account has selling privileges and the required permissions."
            if code == 2004:
                hint = ("Error 2004: Your eBay token is missing the 'sell.inventory' scope required "
                        "for listing. Please disconnect and reconnect your eBay account.")
            elif "seller" in str(msg) or "account" in str(msg):
                hint = "Your eBay seller account may not be fully set up. Complete seller registration on eBay first."
            else:
                hint = msg
            return inv.status_code, {
                "error": msg,
                "errorCode": code,
                "details": error_data,
                "hint": hint,
                "needsReconnect": needs_reconnect,
                "rawEbayError": error_data,
                "ebayErrorMessage": fe or error_data,
            }

        inventory_data = inv.json() if inv.status_code != 204 and inv.text else {}
        final_sku = inventory_data.get("sku") or sku

        # Step 2: inventory location (required for publish)
        merchant_location_key = ""
        try:
            loc = await client.get(
                f"{base}/sell/inventory/v1/location", headers=ebay_headers(access_token)
            )
            if loc.status_code < 400:
                locs = loc.json().get("locations") or []
                if locs:
                    merchant_location_key = locs[0]["merchantLocationKey"]
        except Exception as e:  # noqa: BLE001
            print("Error fetching inventory locations:", e)

        # No location on eBay yet — auto-create one from the user's saved address.
        if not merchant_location_key:
            if not saved_location:
                # eBay does not expose the account address via API, so the user
                # must provide a ship-from address once (saved in app settings).
                return 400, {
                    "error": "No inventory location found. Please set up your inventory location first.",
                    "hint": "Save your ship-from address in app settings and it will be created on eBay automatically.",
                    "needsSetup": True,
                    "needsAddress": True,
                    "setupUrl": "https://www.ebay.com/sh/locationsettings",
                }

            desired_key = saved_location.get("merchant_location_key") or "default-location"
            address: dict = {
                "addressLine1": saved_location["address_line1"],
                "city": saved_location["city"],
                "stateOrProvince": saved_location["state_or_province"],
                "postalCode": saved_location["postal_code"],
                "country": saved_location.get("country") or "US",
            }
            if saved_location.get("address_line2"):
                address["addressLine2"] = saved_location["address_line2"]
            location_payload = {
                "location": {"address": address},
                "locationTypes": ["WAREHOUSE"],
                "name": "Default Location",
                "merchantLocationStatus": "ENABLED",
            }
            create_loc = await client.post(
                f"{base}/sell/inventory/v1/location/{desired_key}",
                headers=ebay_headers(access_token),
                content=json.dumps(location_payload),
            )
            # 204 = created; 409 = already exists (key is usable). Anything else fails.
            if create_loc.status_code == 204 or create_loc.status_code == 409:
                merchant_location_key = desired_key
            else:
                error_data, _ = read_error_body(create_loc)
                print("Failed to auto-create inventory location:", create_loc.status_code, error_data)
                return 400, {
                    "error": "Could not create your eBay inventory location automatically. Please verify your saved address.",
                    "hint": "Check that the ship-from address in settings is complete and valid.",
                    "needsSetup": True,
                    "needsAddress": True,
                    "rawEbayError": error_data,
                }

        # Step 3: policies (saved preferences, else fetch first of each in parallel)
        fulfillment_policy_id = payment_policy_id = return_policy_id = "default"
        if saved_policies:
            fulfillment_policy_id = saved_policies.get("fulfillment_policy_id") or "default"
            payment_policy_id = saved_policies.get("payment_policy_id") or "default"
            return_policy_id = saved_policies.get("return_policy_id") or "default"
        else:
            import asyncio

            async def first_policy(endpoint, list_key, id_key):
                try:
                    r = await client.get(
                        f"{base}/sell/account/v1/{endpoint}", headers=ebay_headers(access_token)
                    )
                    if r.status_code >= 400:
                        return None
                    items = r.json().get(list_key) or []
                    return items[0].get(id_key) if items else None
                except Exception:  # noqa: BLE001
                    return None

            ff, pay, ret = await asyncio.gather(
                first_policy("fulfillment_policy", "fulfillmentPolicies", "fulfillmentPolicyId"),
                first_policy("payment_policy", "paymentPolicies", "paymentPolicyId"),
                first_policy("return_policy", "returnPolicies", "returnPolicyId"),
            )
            fulfillment_policy_id = ff or "default"
            payment_policy_id = pay or "default"
            return_policy_id = ret or "default"

        # Offer settings validation
        allow_offers = bool(offer_settings and offer_settings.get("allow_offers"))
        minimum_offer_amount = float(
            offer_settings.get("minimum_offer_amount", 10.0) if offer_settings else 10.0
        )
        if allow_offers:
            if minimum_offer_amount <= 0:
                return 400, {
                    "error": "Minimum offer amount must be greater than 0 when Allow Offers is enabled.",
                    "action": "invalid_offer_settings",
                }
            if minimum_offer_amount >= price_num:
                return 400, {
                    "error": f"Minimum offer amount (${minimum_offer_amount:.2f}) must be lower "
                    f"than listing price (${price_num:.2f}).",
                    "action": "invalid_offer_settings",
                }

        # Step 4: build + create offer
        listing_description = (description or "")[:50000]
        offer_payload: dict = {
            "sku": final_sku,
            "marketplaceId": "EBAY_US",
            "format": "FIXED_PRICE",
            "listingDescription": listing_description,
            "listingDuration": "GTC",
            "includeCatalogProductDetails": True,
            "pricingSummary": {"price": {"value": f"{price_num:.2f}", "currency": "USD"}},
            "categoryId": final_category_id,
            "availableQuantity": 1,
            "merchantLocationKey": merchant_location_key,
        }
        if allow_offers:
            offer_payload["bestOfferTerms"] = {
                "bestOfferEnabled": True,
                "minimumBestOfferAmount": {"value": f"{minimum_offer_amount:.2f}", "currency": "USD"},
            }
        if "default" not in (fulfillment_policy_id, payment_policy_id, return_policy_id):
            offer_payload["listingPolicies"] = {
                "fulfillmentPolicyId": fulfillment_policy_id,
                "paymentPolicyId": payment_policy_id,
                "returnPolicyId": return_policy_id,
            }

        offer_resp = await client.post(
            f"{base}/sell/inventory/v1/offer",
            headers=ebay_headers(access_token),
            content=json.dumps(offer_payload),
        )

        if offer_resp.status_code >= 400:
            error_data, _ = read_error_body(offer_resp)
            fe = first_error(error_data)
            if offer_resp.status_code == 401 and (fe.get("errorId") or fe.get("code")) == 2004:
                return 401, {
                    "error": "Your eBay token is missing the required 'sell.inventory' scope for "
                    "creating offers. Please disconnect and reconnect your eBay account.",
                    "errorCode": 2004,
                    "needsReconnect": True,
                }
            error_code = fe.get("errorId")

            # 25002: an offer already exists -> update it then publish
            if error_code == 25002:
                params = fe.get("parameters") or []
                existing_offer_id = next(
                    (p.get("value") for p in params if p.get("name") == "offerId"), None
                )
                if existing_offer_id:
                    upd = await client.put(
                        f"{base}/sell/inventory/v1/offer/{existing_offer_id}",
                        headers=ebay_headers(access_token),
                        content=json.dumps(offer_payload),
                    )
                    if upd.status_code < 400:
                        result = await _publish_and_finish(
                            client, base, access_token, existing_offer_id, final_sku,
                            final_category_id, product_obj, offer_payload, allow_offers,
                            short_description, description, title, updated=True,
                        )
                        return result
                    upd_err, _ = read_error_body(upd)
                    return 409, {
                        "error": "An offer already exists for this SKU and could not be updated. "
                        "Please try a different product or wait a moment.",
                        "details": upd_err,
                        "existingOfferId": existing_offer_id,
                        "hint": "The SKU is already in use.",
                    }

            # Other offer-create failures: clean up the inventory item
            try:
                await client.delete(
                    f"{base}/sell/inventory/v1/inventory_item/{final_sku}",
                    headers=ebay_headers(access_token),
                )
            except Exception:  # noqa: BLE001
                pass
            msg = fe.get("message") or fe.get("longMessage") or "Failed to create offer"
            hint = "You may need to set up fulfillment, payment, and return policies in your eBay account first."
            if "policy" in str(msg).lower():
                hint = "Please set up fulfillment, payment, and return policies in your eBay Seller Hub first."
            elif "category" in str(msg).lower():
                hint = "The category ID might be invalid. Please check the product category."
            return offer_resp.status_code, {
                "error": msg,
                "details": error_data,
                "hint": hint,
                "rawEbayError": error_data,
                "ebayErrorMessage": fe or error_data,
            }

        offer_data = offer_resp.json()
        offer_id = offer_data.get("offerId")
        if not offer_id:
            return 500, {"error": "Offer created but no offer ID returned", "details": offer_data}

        return await _publish_and_finish(
            client, base, access_token, offer_id, final_sku, final_category_id,
            product_obj, offer_payload, allow_offers, short_description, description, title,
            updated=False,
        )


async def _publish_and_finish(
    client, base, token, offer_id, final_sku, final_category_id, product_obj,
    offer_payload, allow_offers, short_description, description, title, updated: bool,
) -> tuple[int, dict]:
    """Publish the offer and build the success / missing-item-specifics response.
    Shared by the new-offer and 25002-update paths."""
    pub = await client.post(
        f"{base}/sell/inventory/v1/offer/{offer_id}/publish", headers=ebay_headers(token)
    )

    if pub.status_code >= 400:
        error_data, _ = read_error_body(pub)
        fe = first_error(error_data)
        if pub.status_code == 401 and (fe.get("errorId") or fe.get("code")) == 2004:
            return 401, {
                "error": "Your eBay token is missing the required 'sell.inventory' scope for "
                "publishing listings. Please disconnect and reconnect your eBay account.",
                "errorCode": 2004,
                "needsReconnect": True,
            }
        msg = fe.get("message") or fe.get("longMessage") or "Failed to publish listing"
        code = fe.get("errorId")
        params = fe.get("parameters") or []

        # eBay sometimes returns 25002 not for a missing item specific but because
        # the connected eBay account hasn't finished seller registration (payments
        # / business setup). Detect that and return a clear, accurate message
        # instead of a bogus "item specific" form.
        haystack = f"{msg} {' '.join(str(p.get('value', '')) for p in params)}".lower()
        if "seller's account" in haystack or "seller account" in haystack or "create a seller" in haystack:
            return pub.status_code, {
                "error": "Your eBay account isn't set up to sell yet. eBay requires you to "
                "complete seller registration (including payments/business setup) before you "
                "can list items.",
                "errorCode": code,
                "action": "seller_account_setup",
                "needsSellerRegistration": True,
                "setupUrl": "https://www.ebay.com/sl/sell",
                "hint": "Complete seller registration on eBay, then try listing again. "
                "This is an eBay account requirement, not a connection problem — your "
                "account is still linked.",
                "offerId": offer_id,
                "sku": final_sku,
                "details": error_data,
                "rawEbayError": error_data,
            }

        missing_list: list[str] = []
        if code == 25002:
            # eBay's message is the reliable source for the aspect name, e.g.
            # "The item specific Format is missing. Add Format to this listing..."
            m = re.search(r"item specific\s+(.+?)\s+is missing", msg or "", re.IGNORECASE)
            if m:
                missing_list = [m.group(1).strip()]
            else:
                # Fallback: take the first non-numeric parameter value (the
                # numeric params are positional indexes, not the aspect name).
                for p in params:
                    val = p.get("value")
                    if val and not str(val).strip().isdigit():
                        missing_list = [str(val).strip()]
                        break

        defs_out: list[dict] = []
        if code == 25002 and missing_list:
            text_src = short_description or description or title or ""
            try:
                tx = await client.get(
                    f"{base}/sell/taxonomy/v1/category_tree/0/get_item_aspects_for_category"
                    f"?category_id={final_category_id}",
                    headers=ebay_headers(token),
                )
                all_aspects = tx.json().get("aspects", []) if tx.status_code < 400 else []
            except Exception:  # noqa: BLE001
                all_aspects = []
            for ma in missing_list:
                ad = next(
                    (
                        a
                        for a in all_aspects
                        if (a.get("localizedAspectName") or a.get("aspectName")) == ma
                        or (a.get("localizedAspectName") or a.get("aspectName") or "").lower()
                        == ma.lower()
                    ),
                    None,
                )
                defs_out.append(
                    {
                        "name": (ad.get("localizedAspectName") or ad.get("aspectName")) if ad else ma,
                        "required": True,
                        "values": [
                            (x.get("localizedValue") or x.get("value"))
                            for x in (ad.get("aspectValues") or [])
                        ]
                        if ad
                        else [],
                        "suggestedValue": extract_aspect_value(ma, text_src),
                    }
                )

        if code == 25002 and missing_list:
            hint = (f"Missing required item specific: \"{', '.join(missing_list)}\". "
                    "This category requires this attribute to be specified.")
            payload = {
                "error": msg,
                "action": "missing_item_specifics",
                "missingItemSpecifics": missing_list,
                "aspectDefinitions": defs_out,
                "currentAspects": product_obj.get("aspects") or {},
                "categoryId": final_category_id,
                "hint": hint,
                "offerId": offer_id,
                "sku": final_sku,
                "details": error_data,
                "rawEbayError": error_data,
                "canRetry": False,
            }
            if updated:
                payload["updated"] = True
            return pub.status_code, payload

        hint = "Offer created but not published. You can publish it manually from your eBay Seller Hub."
        if "policy" in str(msg).lower():
            hint = "Missing or invalid business policies. Verify your payment, return, and fulfillment policies in eBay Seller Hub."
        elif "location" in str(msg).lower():
            hint = "Invalid or missing inventory location. Set up your inventory location in eBay Seller Hub first."
        payload = {
            "error": msg,
            "details": error_data,
            "offerId": offer_id,
            "sku": final_sku,
            "hint": hint,
            "missingItemSpecific": missing_list[0] if missing_list else None,
            "rawEbayError": error_data,
            "ebayErrorMessage": fe or error_data,
            "action": "publish_failed",
            "canRetry": code != 25002,
        }
        if updated:
            payload["updated"] = True
        return pub.status_code, payload

    publish_data = pub.json() if pub.text else {}

    # Best Offer ensure/recreate (only on the update path, matching the TS)
    best_offer_recreate = None
    best_offer_fix = None
    if updated and allow_offers:
        best_offer_fix = await _try_ensure_best_offer(client, base, token, offer_id, offer_payload)
        if not best_offer_fix["ensured"]:
            best_offer_recreate = await _recreate_offer_with_best_offer(
                client, base, token, offer_id, offer_payload
            )

    listing_id = (best_offer_recreate or {}).get("recreatedListingId") or publish_data.get("listingId")
    final_offer_id = (best_offer_recreate or {}).get("recreatedOfferId") or offer_id

    result = {
        "success": True,
        "message": "Product listing updated and published successfully on eBay"
        if updated
        else "Product listed successfully on eBay",
        "listingId": listing_id,
        "offerId": final_offer_id,
        "sku": final_sku,
        "listingUrl": f"https://www.ebay.com/itm/{listing_id}",
    }
    if updated:
        result["updated"] = True
    return 200, result
