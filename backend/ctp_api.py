import os
import requests

_BASE  = os.environ.get("CTP_API_BASE", "https://planning.ctp.vatsim.net/api")
_KEY   = os.environ.get("CTP_API_KEY",  "")
_EVENT = int(os.environ.get("CTP_EVENT_ID", "1"))


def _headers():
    return {"X-API-Key": _KEY, "Accept": "application/json"}


def _get(path: str, **kwargs):
    r = requests.get(f"{_BASE}{path}", headers=_headers(), timeout=15, **kwargs)
    r.raise_for_status()
    return r.json()


def _post(path: str, body):
    r = requests.post(
        f"{_BASE}{path}",
        headers={**_headers(), "Content-Type": "application/json"},
        json=body,
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def _put(path: str, body):
    r = requests.put(
        f"{_BASE}{path}",
        headers={**_headers(), "Content-Type": "application/json"},
        json=body,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


# ── Event ID ──────────────────────────────────────────────────────────────────

def event_id() -> int:
    return _EVENT


# ── Events ────────────────────────────────────────────────────────────────────

def list_events():
    return _get("/events")


def get_event_basic(eid: int = None):
    events = list_events()
    target = eid or _EVENT
    for e in events:
        if e.get("id") == target:
            return e
    return None


def update_event(eid: int, fields: dict):
    return _put(f"/events/{eid}", fields)


# ── Route segments ────────────────────────────────────────────────────────────

def get_route_segments(eid: int = None):
    return _get(f"/events/{eid or _EVENT}/route-segments")


# ── Airports ──────────────────────────────────────────────────────────────────

def get_airports(eid: int = None):
    return _get(f"/events/{eid or _EVENT}/airports")


def update_airport(airport_id: int, fields: dict):
    return _put(f"/airports/{airport_id}", fields)


# ── Slot revisions ────────────────────────────────────────────────────────────

def list_slot_revisions(eid: int = None):
    return _get(f"/events/{eid or _EVENT}/slot-revisions")


def get_latest_slot_revision(eid: int = None):
    try:
        return _get(f"/events/{eid or _EVENT}/slot-revisions/latest")
    except requests.HTTPError as e:
        if e.response is not None and e.response.status_code == 404:
            return None
        raise


def get_slot_revision(number: int, eid: int = None):
    return _get(f"/events/{eid or _EVENT}/slot-revisions/{number}")


def create_slot_revision(eid: int = None, metadata: dict = None):
    return _post(f"/events/{eid or _EVENT}/slot-revisions", metadata or {})


def update_slot_revision(revision_id: int, fields: dict):
    return _put(f"/slot-revisions/{revision_id}", fields)


def add_slots_to_revision(revision_id: int, slots: list):
    return _post(f"/slot-revisions/{revision_id}/slots", slots)


# ── Route revisions ───────────────────────────────────────────────────────────

def get_latest_route_revision():
    revisions = _get("/route-revisions")
    if not revisions:
        return None
    return max(revisions, key=lambda r: r.get("number", 0))


# ── Simulator ─────────────────────────────────────────────────────────────────

def calculate_slots(eid: int = None):
    return _post(f"/events/{eid or _EVENT}/calculate-slots", {})


def simulate_slots(eid: int = None):
    return _post(f"/events/{eid or _EVENT}/simulate-slots", {})


# ── Helpers: derive setup from route segments ─────────────────────────────────

def derive_setup(route_segments: list, airports: list) -> dict:
    def norm(value: str) -> str:
        return (value or "").strip().upper()

    airport_ids = sorted({
        norm(a.get("waypoint", {}).get("identifier", "") or a.get("identifier", ""))
        for a in (airports or [])
        if norm(a.get("waypoint", {}).get("identifier", "") or a.get("identifier", ""))
    })

    route_ids = set()
    track_ids = set()

    for seg in route_segments or []:
        if not isinstance(seg, dict):
            continue
        if not seg.get("enabled", True):
            continue

        identifier = (seg.get("identifier") or "").strip()
        group = norm(seg.get("routeSegmentGroup", ""))

        if not identifier:
            continue

        if group == "OCA":
            track_ids.add(identifier)
        else:
            route_ids.add(identifier)

    routes_sorted = sorted(route_ids)
    tracks_sorted = sorted(track_ids)

    return {
        "deps": airport_ids,
        "depRoutesByDep": { airport: routes_sorted[:] for airport in airport_ids },
        "tracks": tracks_sorted,
        "arrRoutes": routes_sorted,
        "arrs": airport_ids,
    }