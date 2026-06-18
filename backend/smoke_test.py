"""Headless smoke test for the core chain:
Supabase admin create-user -> password sign-in -> backend JWT verify ->
settings table read/write/read-back. Run with: uv run python smoke_test.py
Reads config (URL + keys) from .env via app.config.
"""

import sys
import time
import httpx

from app.config import settings

BACKEND = "http://127.0.0.1:8000"
EMAIL = f"smoke+{int(time.time())}@example.com"
PASSWORD = "smoke-test-pw-123!"


def main() -> int:
    url = settings.SUPABASE_URL
    anon = settings.SUPABASE_ANON_KEY
    service = settings.SUPABASE_SERVICE_ROLE_KEY

    admin_headers = {"apikey": service, "Authorization": f"Bearer {service}"}
    user_id = None
    with httpx.Client(timeout=20) as c:
        # 1. Create a confirmed user via the admin API (service role).
        r = c.post(
            f"{url}/auth/v1/admin/users",
            headers=admin_headers,
            json={"email": EMAIL, "password": PASSWORD, "email_confirm": True},
        )
        print(f"[1] admin create-user: {r.status_code}")
        if r.status_code >= 400:
            print("    ", r.text[:300])
            return 1
        user_id = r.json().get("id")

        # 2. Sign in (password grant) with the anon key to get an access token.
        r = c.post(
            f"{url}/auth/v1/token?grant_type=password",
            headers={"apikey": anon, "Content-Type": "application/json"},
            json={"email": EMAIL, "password": PASSWORD},
        )
        print(f"[2] sign-in: {r.status_code}")
        if r.status_code >= 400:
            print("    ", r.text[:300])
            return 1
        token = r.json()["access_token"]
        alg = token.split(".")[0]
        print(f"    got access token (header b64: {alg[:24]}...)")

        h = {"Authorization": f"Bearer {token}"}

        # 3. GET settings/sku (defaults, no row yet)
        r = c.get(f"{BACKEND}/api/settings/sku", headers=h)
        print(f"[3] GET /api/settings/sku: {r.status_code} {r.text}")
        if r.status_code != 200:
            print("    -> JWT verify or table read failed")
            return 1

        # 4. POST settings/sku/prefix (write)
        r = c.post(f"{BACKEND}/api/settings/sku/prefix", headers=h, json={"skuPrefix": "DVD"})
        print(f"[4] POST /api/settings/sku/prefix: {r.status_code} {r.text}")
        if r.status_code != 200:
            return 1

        # 5. GET again -> should now show the persisted prefix
        r = c.get(f"{BACKEND}/api/settings/sku", headers=h)
        print(f"[5] GET /api/settings/sku (after write): {r.status_code} {r.text}")
        if r.status_code != 200 or r.json().get("skuPrefix") != "DVD":
            print("    -> read-back did not reflect the write")
            return 1

        # 6. No-token call should be rejected
        r = c.get(f"{BACKEND}/api/settings/sku")
        print(f"[6] GET without token (expect 401/403): {r.status_code}")

        # Cleanup: delete the test user (cascades to its settings rows).
        if user_id:
            d = c.delete(f"{url}/auth/v1/admin/users/{user_id}", headers=admin_headers)
            print(f"[cleanup] delete test user: {d.status_code}")

    print("\nSMOKE TEST PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
