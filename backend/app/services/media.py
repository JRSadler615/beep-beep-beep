"""Canonical media-type maps — the single source of truth for how the app's
media types map onto eBay categories, item specifics, and in-house catalogs.

These used to be redefined in `services/search.py`, `services/listing.py`, and
`services/catalog.py` (and again in the frontend), which meant four copies to
keep in sync. They now live here and are served to the SPA via
`GET /api/ebay/media-config` so the frontend can mirror them from one place.
"""

# Media type -> eBay leaf category id. DVD / Blu-ray / 4k DVD all live under
# "DVDs & Blu-ray Discs" (617). "Other" has no single category.
MEDIA_CATEGORY_IDS: dict[str, str] = {
    "DVD": "617",
    "Blu-ray": "617",
    "4k DVD": "617",
    "CD": "176984",
    "Cassette": "176983",
    "VHS": "309",
}

# eBay category id -> a representative media type (reverse of MEDIA_CATEGORY_IDS).
# Used to derive the inventory `Type` column from a category we discovered via
# eBay. 617 is shared by DVD/Blu-ray/4k DVD, so it maps to the family default
# "DVD" (the specific format is preserved when WE list the item).
CATEGORY_TO_MEDIA_TYPE: dict[str, str] = {
    "617": "DVD",
    "176984": "CD",
    "176983": "Cassette",
    "309": "VHS",
}

# Allowed media categories (leaves + the Movies & TV / Music parents). eBay
# Browse allows only ONE category_id per search (error 12030), so each search is
# scoped to the single category matching the selected media type.
ALLOWED_CATEGORY_IDS: list[str] = ["617", "176984", "176983", "309", "11232", "11233"]

# Media type -> eBay's required "Format" item specific.
MEDIA_FORMAT_ASPECT: dict[str, str] = {
    "DVD": "DVD",
    "Blu-ray": "Blu-ray",
    "4k DVD": "4K UHD",
    "CD": "CD",
    "Cassette": "Cassette",
    "VHS": "VHS",
}

# Media type -> the category's required "title" item specific. Its value is the
# listing title. Video formats use "Movie/TV Title"; music uses "Release Title".
MEDIA_TITLE_ASPECT: dict[str, str] = {
    "DVD": "Movie/TV Title",
    "Blu-ray": "Movie/TV Title",
    "4k DVD": "Movie/TV Title",
    "VHS": "Movie/TV Title",
    "CD": "Release Title",
    "Cassette": "Release Title",
}

# Media type -> its in-house catalog table. Types not listed (e.g. "Other") have
# no catalog. DVD-family formats share the DVD catalog.
CATALOG_TABLES: dict[str, str] = {
    "DVD": "dvd_upc_catalog",
    "Blu-ray": "dvd_upc_catalog",
    "4k DVD": "dvd_upc_catalog",
    "CD": "cd_upc_catalog",
    "VHS": "vhs_upc_catalog",
    "Cassette": "cassette_upc_catalog",
}

# Media types backed by an in-house catalog (the catalog check/save path).
CATALOG_TYPES: list[str] = list(CATALOG_TABLES.keys())


def media_config() -> dict:
    """Serializable bundle of the maps the SPA needs, for `media-config`."""
    return {
        "categoryIds": MEDIA_CATEGORY_IDS,
        "formatAspects": MEDIA_FORMAT_ASPECT,
        "titleAspects": MEDIA_TITLE_ASPECT,
        "catalogTypes": CATALOG_TYPES,
    }
