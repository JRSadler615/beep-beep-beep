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

    # CORS / redirects
    FRONTEND_URL: str = "http://localhost:3000"

    # eBay
    EBAY_SANDBOX: bool = False
    EBAY_CLIENT_ID: str = ""
    EBAY_CLIENT_SECRET: str = ""
    EBAY_RUNAME: str = ""
    EBAY_SCOPE: str = "https://api.ebay.com/oauth/api_scope"
    EBAY_MARKETPLACE_ID: str = "EBAY_US"
    EBAY_DEBUG: bool = False

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
    return Settings()


settings = get_settings()
