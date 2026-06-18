from functools import lru_cache

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient

from app.config import settings

_bearer = HTTPBearer(auto_error=True)


@lru_cache
def _jwk_client() -> PyJWKClient:
    """Cached JWKS client for the project's public signing keys."""
    return PyJWKClient(f"{settings.SUPABASE_URL}/auth/v1/.well-known/jwks.json")


def _decode(token: str) -> dict:
    """Verify a Supabase access token.

    Supabase issues asymmetric (ES256/RS256) tokens for newer projects and
    symmetric (HS256) tokens for older ones. We branch on the token header so
    both work: HS256 uses the shared JWT secret; ES256/RS256 fetch the public
    key from the project's JWKS endpoint.
    """
    alg = jwt.get_unverified_header(token).get("alg")
    if alg == "HS256":
        return jwt.decode(
            token,
            settings.SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            audience="authenticated",
        )
    signing_key = _jwk_client().get_signing_key_from_jwt(token)
    return jwt.decode(
        token,
        signing_key.key,
        algorithms=["ES256", "RS256"],
        audience="authenticated",
    )


def get_user_id(
    creds: HTTPAuthorizationCredentials = Depends(_bearer),
) -> str:
    """FastAPI dependency that verifies the Supabase access token and returns
    the user id. Replaces the Next.js `await auth()` session check."""
    try:
        payload = _decode(creds.credentials)
    except jwt.PyJWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized"
        )

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized"
        )
    return user_id
