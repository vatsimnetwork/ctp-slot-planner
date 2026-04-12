import os
import json
import re
import sys
import requests
from datetime import datetime, timezone
from flask import Flask, request, jsonify, redirect, abort
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()

import auth
import ctp_api

app = Flask(__name__, static_folder='frontend_dist', static_url_path='')

CORS(app, supports_credentials=True, resources={r"/*": {"origins": "*"}})

DEBUG = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
AUTH_PUBLIC_URL = os.environ.get("AUTH_PUBLIC_URL", "").rstrip("/")
SELF_PUBLIC_PATH = os.environ.get("BASE_PATH", "/slots/").rstrip("/")


# ─── Auth helpers ─────────────────────────────────────────────────────────────

def _ext_error(e: requests.HTTPError):
    status = e.response.status_code if e.response is not None else 502
    try:
        body = e.response.json()
    except Exception:
        body = {"message": str(e)}
    return jsonify({"error": "External API error", "upstream": body}), status


WRITE_ROLES = {"slot_staff", "developer", "administrator"}

ROUTE_ROLES = {"route_staff"}


def _require_staff(user: dict):
    if not WRITE_ROLES.intersection(user.get("roles", [])):
        abort(403, description="insufficient role")

def _require_routes(user: dict):
    if not ROUTE_ROLES.intersection(user.get("roles", [])) and not WRITE_ROLES.intersection(user.get("roles", [])):
        abort(403, description="insufficient role")


# ─── Time format helpers ──────────────────────────────────────────────────────

def _to_api_time(t: str) -> str:
    """Convert '1600z' → '16:00:00' for the VATSIM event API."""
    t = (t or "").strip().lower().rstrip("z")
    t = t.zfill(4)
    return f"{t[:2]}:{t[2:4]}:00"


def _from_api_time(t: str) -> str:
    """Convert '16:00:00' → '1600z' for the frontend TimeSpinner."""
    t = (t or "").strip()
    parts = t.split(":")
    if len(parts) >= 2:
        return f"{parts[0].zfill(2)}{parts[1].zfill(2)}z"
    return t


def _from_api_datetime(dt_str: str) -> str:
    """Extract UTC time from an ISO-8601 datetime string → '1700z'."""
    try:
        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        dt_utc = dt.astimezone(timezone.utc)
        return f"{dt_utc.hour:02d}{dt_utc.minute:02d}z"
    except Exception:
        return ""


def _to_api_datetime(spinner_val: str, event_date_str: str) -> str | None:
    """Convert a TimeSpinner value '1700z' + event date '2025-04-01' → RFC3339 UTC datetime string."""
    try:
        val = (spinner_val or "").strip().lower().rstrip("z")
        if len(val) == 4:
            hh, mm = int(val[:2]), int(val[2:])
        elif ":" in val:
            parts = val.split(":")
            hh, mm = int(parts[0]), int(parts[1])
        else:
            return None
        date_parts = event_date_str.split("-")
        dt = datetime(int(date_parts[0]), int(date_parts[1]), int(date_parts[2]), hh, mm, 0, tzinfo=timezone.utc)
        return dt.isoformat().replace("+00:00", "Z")
    except Exception:
        return None


# ─── /setup/ ──────────────────────────────────────────────────────────────────

@app.get("/setup/")
def setup():
    user = auth.validate_session(request)
    roles = user.get("roles", [])
    is_staff = bool(WRITE_ROLES.intersection(roles))
    is_route_staff = bool(ROUTE_ROLES.intersection(roles)) or is_staff
    try:
        route_segments = ctp_api.get_route_segments()
        airports = ctp_api.get_airports()
        event = ctp_api.get_event_basic()
    except requests.HTTPError as e:
        return _ext_error(e)
    except requests.ConnectionError:
        return jsonify({"error": "Cannot reach the CTP API"}), 502
    except Exception as e:
        return jsonify({"error": f"Setup failed: {e}"}), 500

    # departureTimeWindow is stored in nanoseconds (Go time.Duration)
    dtw_ns = 10_800_000_000_000  # default 3h
    if event:
        raw = event.get("departureTimeWindow")
        if isinstance(raw, (int, float)):
            dtw_ns = int(raw)
        elif isinstance(raw, str):
            # serialized as Go duration string e.g. "3h0m0s" — parse it
            total_ns = 0
            for val, unit in re.findall(r"(\d+(?:\.\d+)?)([hms])", raw):
                v = float(val)
                if unit == "h":   total_ns += int(v * 3_600_000_000_000)
                elif unit == "m": total_ns += int(v * 60_000_000_000)
                elif unit == "s": total_ns += int(v * 1_000_000_000)
            if total_ns:
                dtw_ns = total_ns

    try:
        derived = ctp_api.derive_setup(route_segments, airports, departure_time_window_ns=dtw_ns)
    except Exception as e:
        return jsonify({"error": f"Failed to parse API data: {e}"}), 500

    try:
        latest = ctp_api.get_latest_slot_revision()
        if latest:
            entries = []
            try:
                entries = ctp_api.get_draft_entries(latest["id"])
            except Exception:
                pass
            if not entries:
                sg = _parse_commentary(latest.get("slotPlannerDraftCommentary", ""))
                if sg:
                    entries = sg.get("slotGroups", [])
            if entries:
                rs_ident_by_id = {
                    seg["id"]: (seg.get("identifier") or "").strip()
                    for seg in route_segments if seg.get("id")
                }
                saved_tracks = set()
                for item in entries:
                    track_id = item.get("trackId") or item.get("track_id")
                    if track_id and track_id in rs_ident_by_id:
                        saved_tracks.add(rs_ident_by_id[track_id])
                derived["tracks"] = sorted(set(derived["tracks"]) | saved_tracks)
    except Exception:
        pass

    try:
        rev = ctp_api.get_latest_route_revision()
        routes_revision = rev["number"] if rev else None
    except Exception:
        routes_revision = None

    try:
        tag_limits = ctp_api.get_tag_limits()
    except Exception:
        tag_limits = []

    try:
        sector_limits = ctp_api.get_sectors()
    except Exception:
        sector_limits = []

    tag_map = {}
    sector_map = {}
    tag_to_routes = {}   # tag_name → [{identifier, routeSegmentGroup, enabled}]
    sector_to_routes = {}  # sector_identifier → [{identifier, routeSegmentGroup, enabled}]
    disabled_routes = []
    for seg in route_segments:
        ident = (seg.get("identifier") or "").strip()
        group = (seg.get("routeSegmentGroup") or "").strip()
        enabled = seg.get("enabled", True)
        if not ident:
            continue
        if not enabled:
            disabled_routes.append(ident)
        tags = [t.get("tag") for t in (seg.get("tags") or []) if t.get("tag")]
        if tags:
            tag_map[ident] = tags
            for tag in tags:
                tag_to_routes.setdefault(tag, []).append({"identifier": ident, "routeSegmentGroup": group, "enabled": enabled})
        pfp = seg.get("providedFacilityProgression") or []
        if pfp:
            sector_map[ident] = [
                {
                    "id": s["id"],
                    "identifier": s["identifier"],
                    "maximumAircraftPerHour": s.get("maximumAircraftPerHour") or 65535,
                }
                for s in pfp if s.get("id")
            ]
            for s in pfp:
                if s.get("identifier"):
                    sector_to_routes.setdefault(s["identifier"], []).append(
                        {"identifier": ident, "routeSegmentGroup": group, "enabled": enabled}
                    )

    route_list = ctp_api.build_route_list(route_segments, airports)

    # Build per-airport departure time window start map (ICAO → "HHMMz")
    dep_times = {}
    arr_times = {}
    for a in airports:
        icao = (a.get("waypoint", {}).get("identifier") or a.get("identifier") or "").strip().upper()
        if not icao:
            continue
        dtws = a.get("departureTimeWindowStart")
        if dtws:
            spinner_val = _from_api_datetime(dtws)
            if spinner_val:
                dep_times[icao] = spinner_val
        eat = a.get("earliestArrivalTime")
        if eat:
            spinner_val = _from_api_datetime(eat)
            if spinner_val:
                arr_times[icao] = spinner_val

    _SLOT_GEN_MODE_NAMES     = {0: "Random", 1: "MaximizeAirportPairs", 2: "MaximizeSlots"}
    _DTW_OFFSETS_MODE_NAMES  = {0: "None", 1: "EarliestRoutes", 2: "LatestRoutes", 3: "RouteAverage"}
    _WAYPOINT_TP_MODE_NAMES  = {0: "None", 1: "FirstWaypointsOfNATRouteSegmentsOnly", 2: "AllWaypoints"}

    calc_params = {}
    if event:
        calc_params = {
            "IntendedSlotGenerationMode":                            _SLOT_GEN_MODE_NAMES.get(event.get("intendedSlotGenerationMode", 2), "MaximizeSlots"),
            "DepartureTimeWindowOffsetSynchronizationLongitude":     event.get("departureTimeWindowOffsetSynchronizationLongitude", -30),
            "SimulationAnalysisResolutionInMinutes":                 event.get("simulationAnalysisResolutionInMinutes", 2),
            "ShouldSimulationUseActualWeatherForecastData":          event.get("shouldSimulationUseActualWeatherForecastData", False),
            "IntendedDepartureTimeWindowOffsetsCalculationMode":     _DTW_OFFSETS_MODE_NAMES.get(event.get("intendedDepartureTimeWindowOffsetsCalculationMode", 1), "EarliestRoutes"),
            "DepartureTimeWindowOffsetSynchronizationTimeOfDay":     _from_api_time(event.get("departureTimeWindowOffsetSynchronizationTimeOfDay", "16:00:00")),
            "CalculateThroughputDataOnlyForManuallyProvidedSectors": event.get("calculateThroughputDataOnlyForManuallyProvidedSectors", True),
            "IntendedWaypointThroughputCalculationMode":             _WAYPOINT_TP_MODE_NAMES.get(event.get("intendedWaypointThroughputCalculationMode", 1), "FirstWaypointsOfNATRouteSegmentsOnly"),
            "ThresholdToCheckIfAirplaneIsCountedAtWaypointInNm":     event.get("thresholdToCheckIfAirplaneIsCountedAtWaypointInNm", 5),
            "CalculationFallbackGroundSpeed":                        event.get("calculationFallbackGroundSpeed", 300),
            "HighSimulationAccuracy":                                event.get("highSimulationAccuracy", False),
        }

    # Only expose tags/sectors that currently have at least one route.
    # The records themselves persist in the DB so limits are not lost.
    active_tag_limits = [t for t in tag_limits if t.get("name") in tag_to_routes or t.get("tag") in tag_to_routes]
    active_sector_limits = [s for s in sector_limits if s.get("identifier") in sector_to_routes]

    return jsonify({
        **derived,
        "routesRevision": routes_revision,
        "isStaff": is_staff,
        "isRouteStaff": is_route_staff,
        "syncTime": _from_api_time(event.get("departureTimeWindowOffsetSynchronizationTimeOfDay", "16:00:00")) if event else "1600z",
        "calcParams": calc_params,
        "tagMap": tag_map,
        "sectorMap": sector_map,
        "tagLimits": active_tag_limits,
        "sectorLimits": active_sector_limits,
        "tagToRoutes": tag_to_routes,
        "sectorToRoutes": sector_to_routes,
        "disabledRoutes": disabled_routes,
        "routeList": route_list,
        "eventId": ctp_api.event_id(),
        "depTimes": dep_times,
        "arrTimes": arr_times,
    })


# ─── /departure-pair-preferences/ ──────────────────────────────────────────────

@app.get("/departure-pair-preferences/")
def get_deferred_departure_pairs():
    auth.validate_session(request)
    try:
        pairs = ctp_api.get_deferred_departure_pairs()
    except requests.HTTPError as e:
        return _ext_error(e)
    except requests.ConnectionError:
        return jsonify({"error": "Cannot reach the CTP API"}), 502
    return jsonify(pairs if pairs else [])


@app.put("/departure-pair-preferences/")
def set_deferred_departure_pairs():
    user = auth.validate_session(request)
    _require_staff(user)
    body = request.get_json(force=True)
    try:
        result = ctp_api.set_deferred_departure_pairs(body)
    except requests.HTTPError as e:
        return _ext_error(e)
    except requests.ConnectionError:
        return jsonify({"error": "Cannot reach the CTP API"}), 502
    return jsonify(result if result else [])


# ─── /slotgroups/ ─────────────────────────────────────────────────────────────

@app.get("/slotgroups/")
def get_slotgroups():
    auth.validate_session(request)
    try:
        latest = ctp_api.get_latest_slot_revision()
        rev = ctp_api.get_latest_route_revision()
    except requests.HTTPError as e:
        return _ext_error(e)
    except requests.ConnectionError:
        return jsonify({"error": "Cannot reach the CTP API"}), 502

    routes_revision   = rev["number"] if rev else None
    planner_revisions = latest.get("number", 0) if latest else 0

    slot_groups = []

    if latest:
        try:
            entries = ctp_api.get_draft_entries(latest["id"])
        except Exception:
            entries = []

        if entries:
            try:
                route_segments = ctp_api.get_route_segments()
                airports = ctp_api.get_airports()
            except Exception:
                route_segments, airports = [], []
            airport_ident_by_id, rs_ident_by_id = _build_ident_lookups(route_segments, airports)
            slot_groups = _id_groups_to_ident_groups(entries, airport_ident_by_id, rs_ident_by_id)
        else:
            draft = _parse_commentary(latest.get("slotPlannerDraftCommentary", ""))
            if draft:
                raw_groups = draft.get("slotGroups", [])
                if raw_groups and "depAirportId" in raw_groups[0]:
                    try:
                        route_segments = ctp_api.get_route_segments()
                        airports = ctp_api.get_airports()
                    except Exception:
                        route_segments, airports = [], []
                    airport_ident_by_id, rs_ident_by_id = _build_ident_lookups(route_segments, airports)
                    slot_groups = _id_groups_to_ident_groups(raw_groups, airport_ident_by_id, rs_ident_by_id)

    return jsonify({
        "slotGroups":       slot_groups,
        "routesRevision":   routes_revision,
        "plannerRevisions": planner_revisions,
    })


# ─── /slotgroups/save/ ────────────────────────────────────────────────────────

@app.post("/slotgroups/save/")
def save_slotgroups():
    user = auth.validate_session(request)
    _require_staff(user)
    body = request.get_json(force=True)

    id_based_groups = []
    for g in body.get("slotGroups", []):
        value = int(g.get("value", 0))
        if value <= 0:
            continue
        if all(g.get(k) is not None for k in ("depAirportId", "depRouteId", "trackId", "arrRouteId", "arrAirportId")):
            id_based_groups.append({
                "departureAirportId": g["depAirportId"],
                "depRouteId":         g["depRouteId"],
                "trackId":            g["trackId"],
                "arrRouteId":         g["arrRouteId"],
                "arrivalAirportId":   g["arrAirportId"],
                "slotCount":          value,
            })

    merged = {}
    for g in id_based_groups:
        key = (g["departureAirportId"], g["depRouteId"], g["trackId"], g["arrRouteId"], g["arrivalAirportId"])
        if key in merged:
            merged[key]["slotCount"] += g["slotCount"]
        else:
            merged[key] = dict(g)
    id_based_groups = list(merged.values())

    try:
        new_revision = ctp_api.create_slot_revision(metadata={
            "eventId": ctp_api.event_id(),
        })
        new_revision_id = new_revision["id"]
        new_revision_number = new_revision["number"]
        if id_based_groups:
            ctp_api.add_draft_entries(new_revision_id, id_based_groups)
    except requests.HTTPError as e:
        return _ext_error(e)
    except requests.ConnectionError:
        return jsonify({"error": "Cannot reach the CTP API"}), 502

    return jsonify({"ok": True, "revisionNumber": new_revision_number})


# ─── /slotgroups/submit/ ──────────────────────────────────────────────────────

@app.post("/slotgroups/submit/")
def submit_slotgroups():
    user = auth.validate_session(request)
    _require_staff(user)
    body = request.get_json(force=True)
    mode = body.get("mode", "calculate")

    sim_params = body.get("simulatorParams", {})

    # The Go API stores these as int enums (iota); the frontend sends the string names.
    _SLOT_GENERATION_MODE = {"Random": 0, "MaximizeAirportPairs": 1, "MaximizeSlots": 2}
    _DTW_OFFSETS_MODE     = {"None": 0, "EarliestRoutes": 1, "LatestRoutes": 2, "RouteAverage": 3}
    _WAYPOINT_TP_MODE     = {"None": 0, "FirstWaypointsOfNATRouteSegmentsOnly": 1, "AllWaypoints": 2}

    def _coerce(key, raw):
        if key == "IntendedSlotGenerationMode":
            return _SLOT_GENERATION_MODE.get(raw, raw)
        if key == "IntendedDepartureTimeWindowOffsetsCalculationMode":
            return _DTW_OFFSETS_MODE.get(raw, raw)
        if key == "IntendedWaypointThroughputCalculationMode":
            return _WAYPOINT_TP_MODE.get(raw, raw)
        return raw

    field_map = {
        "IntendedSlotGenerationMode":                            "intendedSlotGenerationMode",
        "DepartureTimeWindowOffsetSynchronizationLongitude":     "departureTimeWindowOffsetSynchronizationLongitude",
        "SimulationAnalysisResolutionInMinutes":                 "simulationAnalysisResolutionInMinutes",
        "ShouldSimulationUseActualWeatherForecastData":          "shouldSimulationUseActualWeatherForecastData",
        "IntendedDepartureTimeWindowOffsetsCalculationMode":     "intendedDepartureTimeWindowOffsetsCalculationMode",
        "DepartureTimeWindowOffsetSynchronizationTimeOfDay":     "departureTimeWindowOffsetSynchronizationTimeOfDay",
        "CalculateThroughputDataOnlyForManuallyProvidedSectors": "calculateThroughputDataOnlyForManuallyProvidedSectors",
        "IntendedWaypointThroughputCalculationMode":             "intendedWaypointThroughputCalculationMode",
        "ThresholdToCheckIfAirplaneIsCountedAtWaypointInNm":     "thresholdToCheckIfAirplaneIsCountedAtWaypointInNm",
        "CalculationFallbackGroundSpeed":                        "calculationFallbackGroundSpeed",
        "HighSimulationAccuracy":                                "highSimulationAccuracy",
    }
    event_update = {
        api_k: (_to_api_time(_coerce(fe_k, sim_params[fe_k])) if fe_k == "DepartureTimeWindowOffsetSynchronizationTimeOfDay" else _coerce(fe_k, sim_params[fe_k]))
        for fe_k, api_k in field_map.items()
        if fe_k in sim_params
    }

    try:
        if event_update:
            ctp_api.patch_event_calculation_params(ctp_api.event_id(), event_update)

        if mode == "simulate":
            slot_groups, caps, planner_revisions, sim_warning, commentary = _submit_simulate(body)
        else:
            slot_groups, caps, planner_revisions, commentary = _submit_calculate(body)
            sim_warning = None

    except requests.HTTPError as e:
        return _ext_error(e)
    except requests.ConnectionError:
        return jsonify({"error": "Cannot reach the CTP API"}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    resp = {
        "slotGroups":       slot_groups,
        "caps":             caps,
        "plannerRevisions": planner_revisions,
        "mode":             mode,
    }
    if sim_warning:
        resp["warning"] = sim_warning
    if commentary:
        resp["commentary"] = commentary
    return jsonify(resp)


def _submit_simulate(body: dict):
    sim_warning = None
    commentary = ""
    try:
        sim_result = ctp_api.simulate_slots()
        commentary = (sim_result or {}).get("simulationOutputCommentary", "")
        planner_revisions = (sim_result or {}).get("slotRevisionNumber", body.get("plannerRevisions", 0))
    except (requests.HTTPError, requests.ConnectionError, requests.Timeout) as exc:
        sim_warning = f"Simulator unavailable: {exc}"
        planner_revisions = body.get("plannerRevisions", 0)

    return [], {}, planner_revisions, sim_warning, commentary


def _submit_calculate(body: dict):
    calc_result = ctp_api.calculate_slots()
    commentary = calc_result.get("slotGenerationOutputCommentary", "") if calc_result else ""

    calc_revision = ctp_api.get_latest_slot_revision()

    route_segments = ctp_api.get_route_segments()
    airports = ctp_api.get_airports()
    raw_slots = calc_revision.get("slots", []) if calc_revision else []
    id_based_groups = _derive_slot_groups_from_slots(raw_slots, route_segments, airports)

    derived = ctp_api.derive_setup(route_segments, airports)
    caps = derived["defaultCaps"]

    draft_revision = ctp_api.create_slot_revision(metadata={
        "eventId": ctp_api.event_id(),
    })
    draft_revision_id = draft_revision["id"]
    if id_based_groups:
        try:
            ctp_api.add_draft_entries(draft_revision_id, id_based_groups)
        except Exception:
            pass

    planner_revisions = draft_revision.get("number", body.get("plannerRevisions", 0))
    airport_ident_by_id, rs_ident_by_id = _build_ident_lookups(route_segments, airports)
    ident_slot_groups = _id_groups_to_ident_groups(id_based_groups, airport_ident_by_id, rs_ident_by_id)

    return ident_slot_groups, caps, planner_revisions, commentary


# ─── /synctime/ ──────────────────────────────────────────────────────────────

@app.patch("/synctime/")
def update_sync_time():
    user = auth.validate_session(request)
    _require_staff(user)
    body = request.get_json(force=True)
    value = body.get("value")
    if not value:
        return jsonify({"error": "value required"}), 400
    try:
        ctp_api.update_event(ctp_api.event_id(), {
            "departureTimeWindowOffsetSynchronizationTimeOfDay": _to_api_time(value),
        })
    except requests.HTTPError as e:
        return _ext_error(e)
    except requests.ConnectionError:
        return jsonify({"error": "Cannot reach the CTP API"}), 502
    return jsonify({"ok": True})


# ─── /caps/ ───────────────────────────────────────────────────────────────────

@app.post("/caps/")
def update_cap():
    user = auth.validate_session(request)
    _require_routes(user)
    body = request.get_json(force=True)
    entity_type = body.get("type")   # "airport" | "routeSegment"
    entity_id   = body.get("id")     # DB id (integer)
    value       = body.get("value")  # integer

    if entity_id is None or value is None:
        return jsonify({"error": "id and value required"}), 400

    try:
        if entity_type == "airport":
            result = ctp_api.patch_airport_capacity(int(entity_id), maximum_slots=int(value))
        elif entity_type == "routeSegment":
            result = ctp_api.patch_route_segment_capacity(int(entity_id), maximum_aircraft_per_hour=int(value))
        else:
            return jsonify({"error": f"Unknown type: {entity_type}"}), 400
    except requests.HTTPError as e:
        return _ext_error(e)
    except requests.ConnectionError:
        return jsonify({"error": "Cannot reach the CTP API"}), 502

    return jsonify({"ok": True, "result": result})


# ─── /airports/<id>/departure-time/ ──────────────────────────────────────────

@app.post("/airports/<int:airport_id>/departure-time/")
def update_airport_departure_time(airport_id: int):
    user = auth.validate_session(request)
    _require_staff(user)
    body = request.get_json(force=True)
    spinner_val = body.get("departureTimeWindowStart")  # "HHMMz" from TimeSpinner

    if not spinner_val:
        return jsonify({"error": "departureTimeWindowStart required"}), 400

    # We need the event date to reconstruct a full datetime
    try:
        event = ctp_api.get_event_basic()
    except (requests.HTTPError, requests.ConnectionError) as e:
        return jsonify({"error": str(e)}), 502

    event_date_str = (event.get("date") or "")[:10] if event else ""
    iso_str = _to_api_datetime(spinner_val, event_date_str) if event_date_str else None

    if not iso_str:
        return jsonify({"error": "Could not convert departure time; ensure event date is set"}), 400

    try:
        result = ctp_api.patch_airport_departure_time_window_start(airport_id, iso_str)
    except requests.HTTPError as e:
        return _ext_error(e)
    except requests.ConnectionError:
        return jsonify({"error": "Cannot reach the CTP API"}), 502

    return jsonify({"ok": True, "result": result})




@app.get("/throughput-limits/")
def get_throughput_limits():
    auth.validate_session(request)
    try:
        tag_limits = ctp_api.get_tag_limits()
        sectors = ctp_api.get_sectors()
    except requests.HTTPError as e:
        return _ext_error(e)
    except requests.ConnectionError:
        return jsonify({"error": "Cannot reach the CTP API"}), 502
    return jsonify({"tagLimits": tag_limits, "sectors": sectors})


@app.post("/throughput-limits/")
def save_throughput_limits():
    user = auth.validate_session(request)
    _require_routes(user)
    body = request.get_json(force=True)
    tag_limits = body.get("tagLimits", [])
    sector_updates = body.get("sectors", [])
    try:
        if tag_limits:
            ctp_api.patch_tag_limits(tag_limits)
        for s in sector_updates:
            ctp_api.patch_sector_capacity(s["id"], s.get("maximumAircraftPerHour", 65535))
    except requests.HTTPError as e:
        return _ext_error(e)
    except requests.ConnectionError:
        return jsonify({"error": "Cannot reach the CTP API"}), 502
    return jsonify({"ok": True})


@app.get("/health/")
def health():
    external_ok = False
    try:
        ctp_api.list_events()
        external_ok = True
    except Exception:
        pass
    return jsonify({
        "status":       "ok",
        "external_api": "reachable" if external_ok else "unreachable",
        "event_id":     ctp_api.event_id(),
        "debug":        DEBUG,
    })


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _parse_commentary(raw: str):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def _build_ident_lookups(route_segments: list, airports: list):
    """Return (airport_ident_by_id, rs_ident_by_id) maps for converting DB IDs → identifiers."""
    def norm(v):
        return (v or "").strip().upper()
    airport_ident_by_id = {
        a["id"]: norm(a.get("waypoint", {}).get("identifier", "") or a.get("identifier", ""))
        for a in (airports or []) if a.get("id")
    }
    rs_ident_by_id = {
        seg["id"]: (seg.get("identifier") or "").strip()
        for seg in (route_segments or []) if seg.get("id")
    }
    return airport_ident_by_id, rs_ident_by_id


def _id_groups_to_ident_groups(slot_groups: list, airport_ident_by_id: dict, rs_ident_by_id: dict) -> list:
    """
    Convert ID-based slot groups [{departureAirportId, depRouteId, trackId, arrRouteId, arrivalAirportId, slotCount}]
    to identifier-based [{id: "dep|depRoute|track|arrRoute|arr", value}].
    Logs and skips groups where any ID cannot be resolved to a current identifier
    (e.g. a route or airport was deleted).
    """
    result = []
    for group in slot_groups:
        value = int(group.get("slotCount") or group.get("value", 0))
        if value <= 0:
            continue
        dep   = airport_ident_by_id.get(group.get("departureAirportId"))
        dr    = rs_ident_by_id.get(group.get("depRouteId"))
        track = rs_ident_by_id.get(group.get("trackId"))
        ar    = rs_ident_by_id.get(group.get("arrRouteId"))
        arr   = airport_ident_by_id.get(group.get("arrivalAirportId"))
        if not all([dep, dr, track, ar, arr]):
            missing = []
            if not dep:   missing.append(f"departureAirportId={group.get('departureAirportId')}")
            if not dr:    missing.append(f"depRouteId={group.get('depRouteId')}")
            if not track: missing.append(f"trackId={group.get('trackId')}")
            if not ar:    missing.append(f"arrRouteId={group.get('arrRouteId')}")
            if not arr:   missing.append(f"arrivalAirportId={group.get('arrivalAirportId')}")
            print(
                f"[slot-planner] WARNING: could not resolve {', '.join(missing)} "
                f"({value} slots) — route or airport may have been deleted",
                file=sys.stderr,
            )
            continue
        ident = f"{dep}|{dr}|{track}|{ar}|{arr}"
        result.append({
            "id":                ident,
            "value":             value,
            "depAirportId":      group.get("departureAirportId"),
            "depRouteId":        group.get("depRouteId"),
            "trackId":           group.get("trackId"),
            "arrRouteId":       group.get("arrRouteId"),
            "arrAirportId":     group.get("arrivalAirportId"),
        })

    merged = {}
    for g in result:
        key = g["id"]
        if key in merged:
            merged[key]["value"] += g["value"]
        else:
            merged[key] = dict(g)
    return list(merged.values())


def _generate_slots_from_groups(slot_groups: list) -> list:
    """Generate slot records from ID-based slot groups for submission to the API."""
    result = []
    for group in slot_groups:
        count = int(group.get("slotCount") or group.get("value", 0))
        if count <= 0:
            continue
        dep_airport_id = group.get("departureAirportId") or group.get("depAirportId")
        dep_route_id   = group.get("depRouteId")
        track_id       = group.get("trackId")
        arr_route_id   = group.get("arrRouteId")
        arr_airport_id = group.get("arrivalAirportId") or group.get("arrAirportId")
        if not all([dep_airport_id, dep_route_id, track_id, arr_route_id, arr_airport_id]):
            print(
                f"[slot-planner] WARNING: incomplete ID-based slot group {group} — skipping",
                file=sys.stderr,
            )
            continue
        slot_template = {
            "departureAirportId": dep_airport_id,
            "arrivalAirportId":   arr_airport_id,
            "routeSegments":      [{"id": dep_route_id}, {"id": track_id}, {"id": arr_route_id}],
        }
        result.extend([slot_template.copy() for _ in range(count)])
    return result


def _derive_slot_groups_from_slots(slots: list, route_segments: list, airports: list) -> list:
    airport_icao_by_id = {}
    airport_icaos = set()
    for a in (airports or []):
        icao = (a.get("waypoint", {}).get("identifier") or a.get("identifier", "")).strip().upper()
        if icao and a.get("id"):
            airport_icao_by_id[a["id"]] = icao
            airport_icaos.add(icao)

    def _norm(v):
        return (v or "").strip().upper()

    def _sorted_locs(seg):
        return sorted(seg.get("locations") or [], key=lambda l: l.get("sortOrder", 0))

    def _first_fix(seg):
        locs = _sorted_locs(seg)
        return _norm(locs[0].get("waypoint", {}).get("identifier", "")) if locs else None

    def _last_fix(seg):
        locs = _sorted_locs(seg)
        return _norm(locs[-1].get("waypoint", {}).get("identifier", "")) if locs else None

    def _classify(seg):
        """Return 'dep', 'track', or 'arr'."""
        if _norm(seg.get("routeSegmentGroup", "")) == "OCA":
            return "track"
        if _first_fix(seg) in airport_icaos:
            return "dep"
        if _last_fix(seg) in airport_icaos:
            return "arr"
        return "dep"

    rs_class_by_id = {}
    for rs in (route_segments or []):
        if rs.get("id"):
            rs_class_by_id[rs["id"]] = (_classify(rs), (rs.get("identifier") or "").strip())

    counts: dict = {}

    for slot in (slots or []):
        dep_airport_id = slot.get("departureAirportId")
        arr_airport_id = slot.get("arrivalAirportId")
        if not dep_airport_id or not arr_airport_id:
            continue

        dep_route_id = None
        track_id     = None
        arr_route_id = None

        for rs in (slot.get("routeSegments") or []):
            rs_id = rs.get("id")
            if rs_id is None:
                continue
            info = rs_class_by_id.get(rs_id)
            if not info:
                continue
            kind, ident = info

            if kind == "dep" and dep_route_id is None:
                dep_route_id = rs_id
            elif kind == "track" and track_id is None:
                track_id = rs_id
            elif kind == "arr" and arr_route_id is None:
                arr_route_id = rs_id

        if not all([dep_route_id, track_id, arr_route_id]):
            continue

        key = (dep_airport_id, dep_route_id, track_id, arr_route_id, arr_airport_id)
        counts[key] = counts.get(key, 0) + 1

    return [
        {
            "departureAirportId": k[0],
            "depRouteId":         k[1],
            "trackId":            k[2],
            "arrRouteId":         k[3],
            "arrivalAirportId":   k[4],
            "slotCount":          v,
        }
        for k, v in sorted(counts.items())
    ]


# ── Auth redirects ────────────────────────────────────────────────────────────

@app.get("/login/")
def login():
    return_to = request.args.get("return_to", AUTH_PUBLIC_URL + SELF_PUBLIC_PATH + "/")
    if return_to.startswith("/"):
        return_to = AUTH_PUBLIC_URL + return_to
    return redirect(f"{AUTH_PUBLIC_URL}/auth/redirect?return_to={return_to}")


@app.get("/logout/")
def logout():
    return redirect(f"{AUTH_PUBLIC_URL}/auth/logout?return_to={SELF_PUBLIC_PATH}/")


# ── Frontend SPA ──────────────────────────────────────────────────────────────

@app.get('/', defaults={'path': ''})
@app.get('/<path:path>')
def serve_frontend(path):
    full_path = os.path.join(app.static_folder, path)
    if path and os.path.exists(full_path):
        return app.send_static_file(path)
    return app.send_static_file('index.html')


# ─── Run ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=5000,
        debug=DEBUG,
    )
