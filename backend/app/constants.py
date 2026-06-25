"""Cross-cutting constants shared across routers and services.

Kept here (rather than duplicated per-module) so there is exactly one source of
truth. The frontend mirrors these in `frontend/src/lib/constants.ts`.
"""

# Default eBay "condition description" (seller note) used when the user hasn't
# enabled a custom note. Worded media-agnostically because the app lists DVDs,
# CDs, VHS, and cassettes — saying "the DVD" was wrong for non-DVD listings.
DEFAULT_SELLER_NOTE = (
    "Please note: any mention of a digital copy or code may be expired and/or "
    "unavailable. This does not affect the quality or functionality of the product."
)
