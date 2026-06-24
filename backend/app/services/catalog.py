"""Media UPC catalogs (Supabase `*_upc_catalog` tables).

One catalog table per media family, all sharing the same columns (mixed casing
as created in Supabase):
  UPC, Title, PUBLISHER, Description, IMAGES, Type, Year, Genres, Rated, Length,
  Weight, Weight_units, Height, Width, Depth, Dimension_units

The media type selects which table to read/write:
  DVD / Blu-ray / 4k DVD -> dvd_upc_catalog
  CD                     -> cd_upc_catalog
  VHS                    -> vhs_upc_catalog
  Cassette               -> cassette_upc_catalog

UPCs are stored without leading zeros (e.g. '31398218487'), so lookups try a
few normalized forms.
"""

import re

from app.db import supabase

# Media type -> catalog table. Types not listed (e.g. "Other") have no catalog.
CATALOG_TABLES = {
    "DVD": "dvd_upc_catalog",
    "Blu-ray": "dvd_upc_catalog",
    "4k DVD": "dvd_upc_catalog",
    "CD": "cd_upc_catalog",
    "VHS": "vhs_upc_catalog",
    "Cassette": "cassette_upc_catalog",
}


def catalog_table_for(media_type: str | None) -> str | None:
    """Return the catalog table for a media type, or None if it has no catalog.
    An empty/blank media type defaults to the DVD catalog (legacy behavior)."""
    mt = (media_type or "").strip()
    if not mt:
        return "dvd_upc_catalog"
    return CATALOG_TABLES.get(mt)

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

# Package dimension/weight fields, mapped to their catalog column names.
# Height/Width/Depth/Weight are numeric; the *_units columns are text.
DIM_COLUMNS = {
    "height": "Height",
    "width": "Width",
    "depth": "Depth",
    "dimensionUnits": "Dimension_units",
    "weight": "Weight",
    "weightUnits": "Weight_units",
}
_DIM_NUMERIC = {"height", "width", "depth", "weight"}


def _coerce_dim(key: str, value) -> object | None:
    """Numeric dim fields -> float (or None); unit fields -> trimmed str (or None)."""
    if value is None:
        return None
    if key in _DIM_NUMERIC:
        try:
            return float(value)
        except (TypeError, ValueError):
            return None
    text = str(value).strip()
    return text or None


def _candidates(upc: str) -> list[str]:
    """UPC forms to try: raw, digits-only, no-leading-zeros, zero-padded."""
    digits = re.sub(r"\D", "", upc or "")
    cands = {upc, digits, digits.lstrip("0")}
    if digits:
        cands.add(digits.zfill(12))
        cands.add(digits.zfill(13))
    return [c for c in cands if c]


def lookup_catalog_by_upc(upc: str, media_type: str | None = "DVD") -> dict | None:
    """Return a normalized catalog dict for a UPC from the media type's catalog,
    or None if there's no catalog for the type or no matching row."""
    table = catalog_table_for(media_type)
    if not table:
        return None
    cands = _candidates(upc)
    if not cands:
        return None
    or_expr = ",".join(f"UPC.eq.{c}" for c in cands)
    res = supabase.table(table).select("*").or_(or_expr).limit(1).execute()
    rows = res.data or []
    if not rows:
        return None
    r = rows[0]
    return {
        "upc": r.get("UPC"),
        "title": r.get("Title"),
        "images": r.get("IMAGES"),
        "fields": {key: r.get(col) for key, col in FIELD_COLUMNS.items()},
        "dims": {key: r.get(col) for key, col in DIM_COLUMNS.items()},
    }


def upsert_catalog(
    media_type: str | None,
    upc: str,
    title: str,
    fields: dict,
    images: str | None = None,
    dims: dict | None = None,
) -> dict | None:
    """Insert or update a row in the media type's catalog. `fields` keys are the
    7 lowercase field names; `dims` keys are the DIM_COLUMNS names. Both are
    mapped back to catalog columns. Returns None if the type has no catalog."""
    table = catalog_table_for(media_type)
    if not table:
        return None
    digits = re.sub(r"\D", "", upc or "")
    stored_upc = digits.lstrip("0") or digits  # match the table's no-leading-zero style
    row: dict = {"UPC": stored_upc, "Title": title}
    for key, col in FIELD_COLUMNS.items():
        if key in fields and fields[key] is not None:
            row[col] = fields[key]
    if dims:
        for key, col in DIM_COLUMNS.items():
            if key in dims:
                coerced = _coerce_dim(key, dims[key])
                if coerced is not None:
                    row[col] = coerced
    if images is not None:
        row["IMAGES"] = images
    res = supabase.table(table).upsert(row, on_conflict="UPC").execute()
    return (res.data or [row])[0]
