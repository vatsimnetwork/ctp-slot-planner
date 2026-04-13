import os
import requests

_BASE  = os.environ.get("CTP_API_BASE", "https://planning.ctp.vatsim.net/api")
_KEY   = os.environ.get("CTP_API_KEY",  "")
_EVENT = int(os.environ.get("CTP_EVENT_ID", "1"))


def _headers():
    return {"X-API-Key": _KEY, "Accept": "application/json"}


def _get(path: str, **kwargs):
    r = requests.get(f"{_BASE}{path}", headers=_headers(), timeout=60, **kwargs)
    r.raise_for_status()
    return r.json()


def _post(path: str, body):
    r = requests.post(
        f"{_BASE}{path}",
        headers={**_headers(), "Content-Type": "application/json"},
        json=body,
        timeout=120,
    )
    r.raise_for_status()
    return r.json()


def _put(path: str, body):
    r = requests.put(
        f"{_BASE}{path}",
        headers={**_headers(), "Content-Type": "application/json"},
        json=body,
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def _patch(path: str, body):
    r = requests.patch(
        f"{_BASE}{path}",
        headers={**_headers(), "Content-Type": "application/json"},
        json=body,
        timeout=60,
    )
    r.raise_for_status()
    return r.json()




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


def patch_event_calculation_params(eid: int, fields: dict):
    return _patch(f"/events/{eid}/calculation-params", fields)


# ── Route segments ────────────────────────────────────────────────────────────

def get_route_segments(eid: int = None):
    return _get(f"/events/{eid or _EVENT}/route-segments")


# ── Airports ──────────────────────────────────────────────────────────────────

def get_airports(eid: int = None):
    return _get(f"/events/{eid or _EVENT}/airports")


def update_airport(airport_id: int, fields: dict):
    return _put(f"/airports/{airport_id}", fields)


def patch_airport_capacity(airport_id: int, maximum_slots: int):
    return _patch(f"/airports/{airport_id}/capacity", {"maximumSlots": maximum_slots})


def patch_airport_departure_time_window_start(airport_id: int, iso_str: str):
    return _patch(f"/airports/{airport_id}/departure-time-window-start", {"departureTimeWindowStart": iso_str})


def patch_route_segment_capacity(segment_id: int, maximum_aircraft_per_hour: int):
    return _patch(f"/route-segments/{segment_id}/capacity", {"maximumAircraftPerHour": maximum_aircraft_per_hour})


def get_tag_limits(eid: int = None):
    return _get(f"/events/{eid or _EVENT}/tag-limits")


def patch_tag_limits(limits: list, eid: int = None):
    return _patch(f"/events/{eid or _EVENT}/tag-limits", limits)


def get_sectors(eid: int = None):
    return _get(f"/events/{eid or _EVENT}/sectors")


def patch_sector_capacity(sector_id: int, maximum_aircraft_per_hour: int):
    return _patch(f"/sectors/{sector_id}/capacity", {"maximumAircraftPerHour": maximum_aircraft_per_hour})


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


def get_draft_entries(revision_id: int):
    return _get(f"/slot-revisions/{revision_id}/draft-entries")


def add_draft_entries(revision_id: int, entries: list):
    return _post(f"/slot-revisions/{revision_id}/draft-entries", entries)


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


# ── Window shifts ─────────────────────────────────────────────────────────────

def list_window_shifts(revision_id: int):
    return _get(f"/slot-revisions/{revision_id}/window-shifts")


def put_window_shifts(revision_id: int, shifts: list):
    return _put(f"/slot-revisions/{revision_id}/window-shifts", shifts)


# ── Helpers: derive setup from route segments ─────────────────────────────────

def derive_setup(route_segments: list, airports: list, departure_time_window_ns: int = 10800000000000) -> dict:
    # Convert nanoseconds to hours (Go time.Duration is nanoseconds)
    departure_hours = departure_time_window_ns / 3_600_000_000_000
    def norm(value: str) -> str:
        return (value or "").strip().upper()

    def sorted_locations(seg):
        return sorted(seg.get("locations") or [], key=lambda l: l.get("sortOrder", 0))

    def first_fix(seg):
        locs = sorted(seg.get("locations") or [], key=lambda l: l.get("sortOrder", 0))
        return norm(locs[0].get("waypoint", {}).get("identifier", "")) if locs else None

    def last_fix(seg):
        locs = sorted(seg.get("locations") or [], key=lambda l: l.get("sortOrder", 0))
        return norm(locs[-1].get("waypoint", {}).get("identifier", "")) if locs else None

    airport_map = {
        norm(a.get("waypoint", {}).get("identifier", "") or a.get("identifier", "")): a
        for a in (airports or [])
    }
    airport_ids = {k for k in airport_map if k}

    dep_segs, track_segs, arr_segs = [], [], []

    for seg in route_segments or []:
        if not isinstance(seg, dict):
            continue
        if not seg.get("enabled", True):
            continue
        identifier = (seg.get("identifier") or "").strip()
        if not identifier:
            continue
        group = norm(seg.get("routeSegmentGroup", ""))
        if group == "OCA":
            track_segs.append(seg)
        elif first_fix(seg) in airport_ids:
            dep_segs.append(seg)
        elif last_fix(seg) in airport_ids:
            arr_segs.append(seg)
        else:
            dep_segs.append(seg)

    # depRoutesByDep: { depAirport → [routeIds] }
    dep_routes_by_dep: dict = {}
    for seg in dep_segs:
        ff = first_fix(seg)
        if ff and ff in airport_ids:
            dep_routes_by_dep.setdefault(ff, [])
            dep_routes_by_dep[ff].append(seg["identifier"].strip())
    for k in dep_routes_by_dep:
        dep_routes_by_dep[k] = sorted(dep_routes_by_dep[k])

    dep_route_last: dict = {seg["identifier"].strip(): last_fix(seg) for seg in dep_segs}

    # Tracks
    track_first: dict = {seg["identifier"].strip(): first_fix(seg) for seg in track_segs}
    track_last:  dict = {seg["identifier"].strip(): last_fix(seg)  for seg in track_segs}

    # tracksByDepRoute: { depRouteId → [trackIds] }
    tracks_by_dep_route: dict = {}
    for dep_route_id, lf in dep_route_last.items():
        tracks_by_dep_route[dep_route_id] = sorted(
            ident for ident, ff in track_first.items() if ff == lf
        )

    # Arr routes
    arr_route_first: dict = {seg["identifier"].strip(): first_fix(seg) for seg in arr_segs}
    arr_route_last:  dict = {seg["identifier"].strip(): last_fix(seg)  for seg in arr_segs}

    # arrRoutesByTrack: { trackId → [arrRouteIds] }
    arr_routes_by_track: dict = {}
    for track_id, lf in track_last.items():
        arr_routes_by_track[track_id] = sorted(
            ident for ident, ff in arr_route_first.items() if ff == lf
        )

    # arrByArrRoute: { arrRouteId → arrAirport }
    arr_by_arr_route = {
        ident: lf
        for ident, lf in arr_route_last.items()
        if lf in airport_ids
    }

    def seg_cap(seg):
        # Non-airport throughput points: edit per-hour, show total slots
        v = seg.get("maximumAircraftPerHour", 0)
        if not v or v >= 65535:
            return None
        total = int(v * departure_hours)
        return total if total else None

    def airport_cap(icao):
        # Airports: show and edit maximum_slots directly
        a = airport_map.get(icao, {})
        v = a.get("maximumSlots", 0)
        if not v or v >= 65535:
            return None
        return int(v)

    default_caps = {
        "deps":      {icao: airport_cap(icao) for icao in dep_routes_by_dep if airport_cap(icao)},
        "arrs":      {icao: airport_cap(icao) for icao in arr_by_arr_route.values() if airport_cap(icao)},
        "depRoutes": {seg["identifier"].strip(): cap for seg in dep_segs if (cap := seg_cap(seg))},
        "tracks":    {seg["identifier"].strip(): cap for seg in track_segs if (cap := seg_cap(seg))},
        "arrRoutes": {seg["identifier"].strip(): cap for seg in arr_segs if (cap := seg_cap(seg))},
    }

    # DB IDs for PATCH capacity endpoints
    db_ids = {
        "airports":      {norm(a.get("waypoint", {}).get("identifier", "") or a.get("identifier", "")): a["id"] for a in (airports or []) if a.get("id")},
        "routeSegments": {(seg.get("identifier") or "").strip(): seg["id"] for seg in route_segments if seg.get("id")},
    }

    return {
        "deps": sorted(dep_routes_by_dep.keys()),
        "depRoutesByDep":   dep_routes_by_dep,
        "tracksByDepRoute": tracks_by_dep_route,
        "arrRoutesByTrack": arr_routes_by_track,
        "arrByArrRoute":    arr_by_arr_route,
        "defaultCaps":      default_caps,
        "dbIds":            db_ids,
        "departureHours":   departure_hours,
        # Legacy flat lists kept for the Sankey display
        "tracks":    sorted(track_first.keys()),
        "arrRoutes": sorted(arr_route_first.keys()),
        "arrs":      sorted(airport_ids),
    }


def build_route_list(route_segments: list, airports: list) -> list:
    """Return metadata for every route segment (enabled and disabled) for the slot planner grid visibility filters."""
    def norm(value: str) -> str:
        return (value or "").strip().upper()

    def first_fix(seg):
        locs = sorted(seg.get("locations") or [], key=lambda l: l.get("sortOrder", 0))
        return norm(locs[0].get("waypoint", {}).get("identifier", "")) if locs else None

    def last_fix(seg):
        locs = sorted(seg.get("locations") or [], key=lambda l: l.get("sortOrder", 0))
        return norm(locs[-1].get("waypoint", {}).get("identifier", "")) if locs else None

    airport_ids = {
        norm(a.get("waypoint", {}).get("identifier", "") or a.get("identifier", ""))
        for a in (airports or [])
        if a.get("waypoint", {}).get("identifier", "") or a.get("identifier", "")
    }

    result = []
    for seg in route_segments or []:
        if not isinstance(seg, dict):
            continue
        ident = (seg.get("identifier") or "").strip()
        if not ident:
            continue
        group = (seg.get("routeSegmentGroup") or "").strip()
        enabled = seg.get("enabled", True)
        acph = seg.get("maximumAircraftPerHour") or 0

        g = norm(group)
        if g == "OCA":
            rtype = "track"
        elif first_fix(seg) in airport_ids:
            rtype = "dep"
        elif last_fix(seg) in airport_ids:
            rtype = "arr"
        else:
            rtype = "dep"

        result.append({
            "identifier": ident,
            "enabled": enabled,
            "routeSegmentGroup": group,
            "type": rtype,
            "maximumAircraftPerHour": acph if acph and acph < 65535 else None,
        })
    return result