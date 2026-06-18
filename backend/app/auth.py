import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import settings

_bearer = HTTPBearer(auto_error=True)


def get_user_id(
    creds: HTTPAuthorizationCredentials = Depends(_bearer),
) -> str:
    """FastAPI dependency that verifies the Supabase (GoTrue) access token the
    SPA sends as `Authorization: Bearer <jwt>` and returns the user id.

    Replaces the Next.js `await auth()` session check. Add it to any endpoint
    that needs an authenticated user:

        @router.get("/whatever")
        def handler(user_id: str = Depends(get_user_id)):
            ...
    """
    try:
        payload = jwt.decode(
            creds.credentials,
            settings.SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            audience="authenticated",
        )
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
