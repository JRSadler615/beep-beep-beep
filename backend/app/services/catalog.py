"""DVD UPC catalog (Supabase `dvd_upc_catalog` table).

Columns (note the mixed casing as created in Supabase):
  UPC, Title, PUBLISHER, Description, IMAGES, Type, Year, Genres, Rated, Length

UPCs are stored without leading zeros (e.g. '31398218487'), so lookups try a
few normalized forms.
"""

import re

from app.db import supabase

# The 7 structured listing fields, mapped to their catalog column names.
FIELD_COLUMNS = {
    "type": "Type",
    "year": "Year",
    "description": "Description",
    "publisher": "PUBLISHER",
    "genre": "Genres",
    "rated": "Rated",
    "length": "Length",
}


def _candidates(upc: str) -> list[str]:
    """UPC forms to try: raw, digits-only, no-leading-zeros, zero-padded."""
    digits = re.sub(r"\D", "", upc or "")
    cands = {upc, digits, digits.lstrip("0")}
    if digits:
        cands.add(digits.zfill(12))
        cands.add(digits.zfill(13))
    return [c for c in cands if c]


def lookup_dvd_by_upc(upc: str) -> dict | None:
    """Return a normalized catalog dict for a UPC, or None if not found."""
    cands = _candidates(upc)
    if not cands:
        return None
    or_expr = ",".join(f"UPC.eq.{c}" for c in cands)
    res = supabase.table("dvd_upc_catalog").select("*").or_(or_expr).limit(1).execute()
    rows = res.data or []
    if not rows:
        return None
    r = rows[0]
    return {
        "upc": r.get("UPC"),
        "title": r.get("Title"),
        "images": r.get("IMAGES"),
        "fields": {key: r.get(col) for key, col in FIELD_COLUMNS.items()},
    }


def upsert_dvd(upc: str, title: str, fields: dict, images: str | None = None) -> dict:
    """Insert or update a catalog row from a listing. `fields` keys are the
    7 lowercase field names; mapped back to catalog columns."""
    digits = re.sub(r"\D", "", upc or "")
    stored_upc = digits.lstrip("0") or digits  # match the table's no-leading-zero style
    row: dict = {"UPC": stored_upc, "Title": title}
    for key, col in FIELD_COLUMNS.items():
        if key in fields and fields[key] is not None:
            row[col] = fields[key]
    if images is not None:
        row["IMAGES"] = images
    res = supabase.table("dvd_upc_catalog").upsert(row, on_conflict="UPC").execute()
    return (res.data or [row])[0]
