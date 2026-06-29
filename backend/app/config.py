"""Application settings.

Defines the typed `Settings` model (Supabase keys, CORS/redirect origin, eBay
OAuth credentials/flags, Sentry DSN) loaded from the environment, with derived
eBay URL properties that switch between sandbox and production. `settings` is the
cached singleton imported throughout the app.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """App configuration. Values come from the environment (Doppler in
    production, a local .env file in development)."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Supabase
    SUPABASE_URL: str = ""
    SUPABASE_ANON_KEY: str = ""
    SUPABASE_SERVICE_ROLE_KEY: str = ""
    SUPABASE_JWT_SECRET: str = ""

    # CORS / redirects.
    # PROD HOSTNAME: override via env (FRONTEND_URL) to the deployed SPA origin
    # in production; this localhost default is for local dev only.
    FRONTEND_URL: str = "http://localhost:3000"

    # eBay
    EBAY_SANDBOX: bool = False
    EBAY_CLIENT_ID: str = ""
    EBAY_CLIENT_SECRET: str = ""
    EBAY_RUNAME: str = ""
    EBAY_SCOPE: str = "https://api.ebay.com/oauth/api_scope"
    EBAY_MARKETPLACE_ID: str = "EBAY_US"
    EBAY_DEBUG: bool = False

    # Local eBay-inventory mirror: minimum minutes between startup syncs (the
    # dev --reload loop restarts often, so we throttle to avoid hammering eBay).
    INVENTORY_SYNC_MIN_INTERVAL_MINUTES: int = 10
    # The "enrich from offers" pass (price/category/listing/free-shipping) is far
    # heavier (one offer call per SKU), so it runs at most once per this window.
    INVENTORY_ENRICH_MIN_INTERVAL_HOURS: int = 24
    # Sales detection (Fulfillment/Orders API -> all_item_catalog FIFO): poll at
    # most this often, and look back this many days for orders on each poll
    # (idempotent — already-recorded order line items are skipped).
    ORDERS_SYNC_MIN_INTERVAL_MINUTES: int = 60
    ORDERS_SYNC_LOOKBACK_DAYS: int = 90

    # Observability
    SENTRY_DSN: str = ""

    @property
    def ebay_base_url(self) -> str:
        return (
            "https://api.sandbox.ebay.com" if self.EBAY_SANDBOX else "https://api.ebay.com"
        )

    @property
    def ebay_token_endpoint(self) -> str:
        return f"{self.ebay_base_url}/identity/v1/oauth2/token"

    @property
    def ebay_authorize_url(self) -> str:
        # OAuth consent page lives on a different host than the API base.
        host = "auth.sandbox.ebay.com" if self.EBAY_SANDBOX else "auth.ebay.com"
        return f"https://{host}/oauth2/authorize"


@lru_cache
def get_settings() -> Settings:
    """Return the process-wide Settings singleton (built once, then cached)."""
    return Settings()


settings = get_settings()
