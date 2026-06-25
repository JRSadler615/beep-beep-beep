"""UPC normalization helpers.

UPCs arrive in inconsistent forms (with/without leading zeros, with stray
punctuation, as ints) from the SPA, the catalog tables, and eBay's inventory
items. These helpers centralize the normalization that was previously
re-implemented as `_digits` (inventory), `_normalize_upc` (ebay router), and
`_candidates` (catalog).
"""

import re


def digits_only(value: object) -> str:
    """Strip everything but digits. `None`/blank -> empty string."""
    return re.sub(r"\D", "", str(value or ""))


def normalize_no_zeros(value: object) -> str:
    """Digits with leading zeros stripped (the catalog's storage form, e.g.
    '031398218487' -> '31398218487'). Falls back to the digit string if it is
    all zeros."""
    n = digits_only(value)
    if not n:
        return ""
    return n.lstrip("0") or n


def candidates(upc: object) -> list[str]:
    """UPC forms to try when matching: raw, digits-only, no-leading-zeros, and
    zero-padded to 12/13 digits. Deduplicated, blanks removed."""
    raw = str(upc or "")
    digits = digits_only(raw)
    cands = {raw, digits, digits.lstrip("0")}
    if digits:
        cands.add(digits.zfill(12))
        cands.add(digits.zfill(13))
    return [c for c in cands if c]
