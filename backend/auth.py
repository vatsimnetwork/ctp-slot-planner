import os
import httpx
from flask import abort
from dotenv import load_dotenv

load_dotenv()

SSO_URL = os.environ.get("SSO_URL")
if not SSO_URL:
    raise RuntimeError("SSO_URL env not set")

INTERNAL_API_KEY = os.environ.get("INTERNAL_API_KEY")
if not INTERNAL_API_KEY:
    raise RuntimeError("INTERNAL_API_KEY env not set")

DEBUG = os.getenv("DEBUG", "").lower() == "true"


def validate_session(req) -> dict:
    session_id = req.cookies.get("session_id")
    if not session_id:
        abort(401, description="no session_id cookie")
    try:
        resp = httpx.get(
            SSO_URL,
            headers={
                "X-Internal-Key": INTERNAL_API_KEY,
                "Cookie": f"session_id={session_id}",
                "User-Agent": req.headers.get("User-Agent", ""),
                "X-Forwarded-For": req.headers.get("X-Forwarded-For", req.remote_addr or ""),
            },
            timeout=10,
        )
    except httpx.HTTPError as exc:
        abort(502, description=f"session validation failed: {exc}")

    if resp.status_code != 200:
        error = resp.json().get("error", "unknown")
        abort(401, description=f"session invalid: {error}")

    return resp.json()  # {"cid": "1234567", "roles": ["administrator"]}
