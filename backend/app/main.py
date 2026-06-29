"""FastAPI application entry point.

Builds the `app`: initializes logging and (optionally) Sentry, applies CORS so
the SPA's origin can call the API cross-origin, and mounts the feature routers
(eBay OAuth/listing, user settings, media catalog). Exposes GET /health for
uptime checks. Run with `uvicorn app.main:app`.
"""

import logging

import sentry_sdk
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers import catalog, ebay, settings as settings_router

logging.basicConfig(level=logging.INFO)

if settings.SENTRY_DSN:
    sentry_sdk.init(dsn=settings.SENTRY_DSN, traces_sample_rate=0.1)

app = FastAPI(title="Beep Beep API", version="0.1.0")

# SPA (Cloudflare) and API (Hetzner) are different origins in production.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.FRONTEND_URL],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ebay.router)
app.include_router(settings_router.router)
app.include_router(catalog.router)


@app.on_event("startup")
async def _sync_inventory_on_startup():
    """On startup, in the background (so server readiness isn't delayed, and each
    throttled independently): refresh the eBay_inventory mirror + offer
    enrichment, and poll orders to record sales into all_item_catalog."""
    import asyncio

    from app.services.all_item_catalog import maybe_sync_sales
    from app.services.inventory_db import maybe_sync_on_startup

    asyncio.create_task(maybe_sync_on_startup())
    asyncio.create_task(maybe_sync_sales())


@app.get("/health")
def health():
    return {"status": "ok"}
