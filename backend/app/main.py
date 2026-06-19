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


@app.get("/health")
def health():
    return {"status": "ok"}
