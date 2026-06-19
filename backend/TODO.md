# Backend TODOs

## Photo database per UPC/Title with a web scraper (requested)

Add the ability to set up a database of photos keyed by UPC/Title that new
listings can pull from automatically, backed by a **web scraper on the backend**
that searches for new photos.

Sketch / considerations:
- Storage: reuse the Supabase Storage `listing-photos` bucket (or a dedicated
  `catalog-photos` bucket); store image URLs in `dvd_upc_catalog.IMAGES`
  (currently unused) keyed by UPC.
- Scraper: a background worker (the group stack runs `python -m app.workers.*`
  systemd units) that, given a UPC/Title with no photo, searches sources for a
  product image, downloads it, uploads to Storage, and writes the URL back to
  the catalog row. Rate-limit and cache to respect source sites.
- Search integration: when a catalog hit has an `IMAGES` URL, prefer it over
  the eBay seller/stock image (the search service already surfaces `IMAGES`
  via `lookup_dvd_by_upc`, so wiring it in is small).
- Respect each source site's terms of service / robots.txt; prefer official
  product APIs where available.
