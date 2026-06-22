"""DVD catalog writes + manual photo upload.

- POST /api/catalog/dvd   : upsert a row into dvd_upc_catalog ("This is a DVD").
- POST /api/upload-photo  : upload an image to Supabase Storage, return its
  public URL (for use as a listing photo).
"""

from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel

from app.auth import get_user_id
from app.config import settings
from app.services.catalog import lookup_dvd_by_upc, upsert_dvd

router = APIRouter(prefix="/api", tags=["catalog"])

_PHOTO_BUCKET = "listing-photos"
_ALLOWED_EXT = {"jpg", "jpeg", "png", "webp", "gif"}


class DvdCatalogEntry(BaseModel):
    upc: str
    title: str
    type: str | None = None
    year: str | None = None
    description: str | None = None
    publisher: str | None = None
    genre: str | None = None
    rated: str | None = None
    length: str | None = None
    images: str | None = None


@router.get("/catalog/dvd")
def get_dvd(upc: str = Query(...), user_id: str = Depends(get_user_id)):
    """Look up a DVD in the catalog by UPC. Used when the user selects the
    'DVD' media type so the form can auto-populate from the catalog."""
    row = lookup_dvd_by_upc(upc)
    if not row:
        return {"found": False}
    return {
        "found": True,
        "title": row.get("title"),
        "fields": {k: (v or "") for k, v in row["fields"].items()},
    }


@router.post("/catalog/dvd")
def save_dvd(entry: DvdCatalogEntry, user_id: str = Depends(get_user_id)):
    """Upsert the item into the DVD catalog ("This is a DVD")."""
    if not entry.upc or not entry.upc.strip():
        raise HTTPException(status_code=400, detail="UPC is required")
    if not entry.title or not entry.title.strip():
        raise HTTPException(status_code=400, detail="Title is required")
    fields = {
        "type": entry.type,
        "year": entry.year,
        "description": entry.description,
        "publisher": entry.publisher,
        "genre": entry.genre,
        "rated": entry.rated,
        "length": entry.length,
    }
    row = upsert_dvd(entry.upc.strip(), entry.title.strip(), fields, entry.images)
    return {"success": True, "saved": row}


@router.post("/upload-photo")
async def upload_photo(
    file: UploadFile = File(...), user_id: str = Depends(get_user_id)
):
    """Upload an image to Supabase Storage and return its public URL."""
    filename = file.filename or ""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "jpg"
    if ext not in _ALLOWED_EXT:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: .{ext}")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large (max 10 MB)")

    # Namespaced by user so uploads don't collide.
    path = f"{user_id}/{uuid4().hex}.{ext}"
    content_type = file.content_type or f"image/{'jpeg' if ext == 'jpg' else ext}"

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{settings.SUPABASE_URL}/storage/v1/object/{_PHOTO_BUCKET}/{path}",
            headers={
                "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
                "Content-Type": content_type,
                "x-upsert": "true",
            },
            content=content,
        )
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Upload failed: {resp.text[:200]}")

    public_url = f"{settings.SUPABASE_URL}/storage/v1/object/public/{_PHOTO_BUCKET}/{path}"
    return {"success": True, "url": public_url}
