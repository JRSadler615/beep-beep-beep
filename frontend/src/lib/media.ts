/**
 * Media-type maps for the listing flow — the single frontend source of truth.
 *
 * The backend owns the canonical copy in `app/services/media.py` and serves it
 * at `GET /api/ebay/media-config`; `fetchMediaConfig()` below returns that live
 * copy. These bundled constants mirror it so components can use the maps
 * synchronously during render (and as an offline fallback). If you change a
 * mapping, change it in `app/services/media.py` too.
 */
import { apiFetch } from "./api"

// Media type -> eBay leaf category id. DVD / Blu-ray / 4k DVD all live under
// "DVDs & Blu-ray Discs" (617).
export const MEDIA_CATEGORY_IDS: Record<string, string> = {
  DVD: "617",
  "Blu-ray": "617",
  "4k DVD": "617",
  CD: "176984",
  Cassette: "176983",
  VHS: "309",
}

// eBay's required "Format" item specific, mapped from our media type.
export const MEDIA_FORMAT_ASPECT: Record<string, string> = {
  DVD: "DVD",
  "Blu-ray": "Blu-ray",
  "4k DVD": "4K UHD",
  CD: "CD",
  Cassette: "Cassette",
  VHS: "VHS",
}

// The required "title" item specific differs by category. Video formats use
// "Movie/TV Title"; music formats use "Release Title". Its value is the title.
export const MEDIA_TITLE_ASPECT: Record<string, string> = {
  DVD: "Movie/TV Title",
  "Blu-ray": "Movie/TV Title",
  "4k DVD": "Movie/TV Title",
  VHS: "Movie/TV Title",
  CD: "Release Title",
  Cassette: "Release Title",
}

// Media types backed by an in-house catalog (catalog check + save).
export const CATALOG_TYPES = ["DVD", "Blu-ray", "4k DVD", "CD", "VHS", "Cassette"]

export interface MediaConfig {
  categoryIds: Record<string, string>
  formatAspects: Record<string, string>
  titleAspects: Record<string, string>
  catalogTypes: string[]
}

/** Fetch the canonical maps from the backend (single source of truth). */
export async function fetchMediaConfig(): Promise<MediaConfig> {
  return apiFetch<MediaConfig>("/api/ebay/media-config")
}
