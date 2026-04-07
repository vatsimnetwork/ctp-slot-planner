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


def _require_staff(user: dict):
    if not WRITE_ROLES.intersection(user.get("roles", [])):
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
    is_staff = bool(WRITE_ROLES.intersection(user.get("roles", [])))
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
            sg = _parse_commentary(latest.get("slotPlannerDraftCommentary", ""))
            items = sg.get("slotGroups", []) if sg else []
            if items and _is_new_draft_format(items):
                rs_ident_by_id = {
                    seg["id"]: (seg.get("identifier") or "").strip()
                    for seg in route_segments if seg.get("id")
                }
                saved_tracks = {
                    ident for item in items
                    if (ident := rs_ident_by_id.get(item.get("trackId")))
                }
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

    return jsonify({
        **derived,
        "routesRevision": routes_revision,
        "isStaff": is_staff,
        "syncTime": _from_api_time(event.get("departureTimeWindowOffsetSynchronizationTimeOfDay", "16:00:00")) if event else "1600z",
        "tagMap": tag_map,
        "sectorMap": sector_map,
        "tagLimits": tag_limits,
        "sectorLimits": sector_limits,
        "tagToRoutes": tag_to_routes,
        "sectorToRoutes": sector_to_routes,
        "disabledRoutes": disabled_routes,
        "routeList": route_list,
        "eventId": ctp_api.event_id(),
        "depTimes": dep_times,
        "arrTimes": arr_times,
    })


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

    slot_groups, caps = [], {}

    if latest:
        draft = _parse_commentary(latest.get("slotPlannerDraftCommentary", ""))
        if draft:
            raw_groups = draft.get("slotGroups", [])
            caps       = draft.get("caps", {})

            if raw_groups:
                try:
                    route_segments = ctp_api.get_route_segments()
                    airports       = ctp_api.get_airports()
                except Exception:
                    route_segments, airports = [], []

                if _is_new_draft_format(raw_groups):
                    # New ID-based format: resolve IDs to current identifiers for the frontend.
                    airport_ident_by_id, rs_ident_by_id = _build_ident_lookups(route_segments, airports)
                    slot_groups = _id_groups_to_ident_groups(raw_groups, airport_ident_by_id, rs_ident_by_id)
                else:
                    # Legacy identifier format: auto-migrate to ID-based and save back.
                    print("[slot-planner] MIGRATION: draft uses legacy identifier format — migrating to ID-based", file=sys.stderr)
                    airport_id_by_ident, rs_id_by_ident = _build_id_lookups(route_segments, airports)
                    id_based = _ident_groups_to_id_groups(raw_groups, airport_id_by_ident, rs_id_by_ident)

                    new_commentary = json.dumps({
                        "slotGroups": id_based,
                        "caps":       caps,
                        "draft":      True,
                    })
                    try:
                        ctp_api.update_slot_revision(latest["id"], {
                            "slotPlannerDraftCommentary": new_commentary,
                        })
                        print(f"[slot-planner] MIGRATION: saved {len(id_based)} ID-based slot groups "
                              f"({len(raw_groups) - len(id_based)} could not be resolved)", file=sys.stderr)
                    except Exception as e:
                        print(f"[slot-planner] MIGRATION: failed to save migrated draft: {e}", file=sys.stderr)

                    # Return identifier format to frontend (resolved from the freshly migrated IDs)
                    airport_ident_by_id, rs_ident_by_id = _build_ident_lookups(route_segments, airports)
                    slot_groups = _id_groups_to_ident_groups(id_based, airport_ident_by_id, rs_ident_by_id)

    return jsonify({
        "slotGroups":       slot_groups,
        "routesRevision":   routes_revision,
        "plannerRevisions": planner_revisions,
        "caps":             caps,
    })


# ─── /slotgroups/save/ ────────────────────────────────────────────────────────

@app.post("/slotgroups/save/")
def save_slotgroups():
    user = auth.validate_session(request)
    _require_staff(user)
    body = request.get_json(force=True)

    ident_groups = body.get("slotGroups", [])

    # Convert identifier-based slot groups from the frontend to ID-based format for storage.
    id_based_groups = []
    needs_resolution = []
    for g in ident_groups:
        value = int(g.get("value", 0))
        if value <= 0:
            continue
        if all(g.get(k) is not None for k in ("depAirportId", "depRouteId", "trackId", "arrRouteId", "arrAirportId")):
            id_based_groups.append({
                "depAirportId": g["depAirportId"],
                "depRouteId":   g["depRouteId"],
                "trackId":      g["trackId"],
                "arrRouteId":   g["arrRouteId"],
                "arrAirportId": g["arrAirportId"],
                "value":        value,
            })
        else:
            needs_resolution.append(g)

    if needs_resolution:
        try:
            route_segments = ctp_api.get_route_segments()
            airports       = ctp_api.get_airports()
        except requests.HTTPError as e:
            return _ext_error(e)
        except requests.ConnectionError:
            return jsonify({"error": "Cannot reach the CTP API"}), 502
        airport_id_by_ident, rs_id_by_ident = _build_id_lookups(route_segments, airports)
        id_based_groups.extend(_ident_groups_to_id_groups(needs_resolution, airport_id_by_ident, rs_id_by_ident))

    commentary = json.dumps({
        "slotGroups": id_based_groups,
        "caps":       body.get("caps", {}),
        "draft":      True,
    })

    try:
        latest = ctp_api.get_latest_slot_revision()
        if latest:
            is_draft = bool(latest.get("slotPlannerDraftCommentary"))
            if is_draft:
                # Safe to overwrite — this is a draft revision
                ctp_api.update_slot_revision(latest["id"], {
                    "slotPlannerDraftCommentary": commentary,
                })
            else:
                # Latest revision is a sim/calc revision — don't overwrite it,
                # create a new draft instead so we don't corrupt simulator output
                ctp_api.create_slot_revision(metadata={
                    "eventId":                  ctp_api.event_id(),
                    "slotPlannerDraftCommentary": commentary,
                })
        else:
            ctp_api.create_slot_revision(metadata={
                "eventId":                  ctp_api.event_id(),
                "slotPlannerDraftCommentary": commentary,
            })
    except requests.HTTPError as e:
        return _ext_error(e)
    except requests.ConnectionError:
        return jsonify({"error": "Cannot reach the CTP API"}), 502

    return jsonify({"ok": True})


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
            ctp_api.update_event(ctp_api.event_id(), event_update)

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
    """
    Simulate flow:
    1. Parse draft slot groups from the latest revision's commentary.
    2. Generate actual slot records from those groups.
    3. Create a new slot revision and populate it with the actual slots.
    4. Call simulate_slots (uses the newly created latest revision).
       Go will update slot times and create a draft revision in the same transaction.
    5. If Go returned a draftRevisionNumber, use it; otherwise create the draft here.
    Returns (slot_groups, caps, new_planner_revisions).
    slot_groups returned are in identifier format for the frontend.
    """
    caps = body.get("caps", {})

    # Fetch draft slot groups from latest revision
    latest = ctp_api.get_latest_slot_revision()
    draft = _parse_commentary(latest.get("slotPlannerDraftCommentary", "")) if latest else None
    slot_groups = (draft.get("slotGroups", []) if draft else None) or body.get("slotGroups", [])
    if draft:
        caps = draft.get("caps", caps)

    # Build lookups for airports and route segments
    route_segments = ctp_api.get_route_segments()
    airports = ctp_api.get_airports()

    # Create a new revision to hold the actual slots (this becomes "locked" after simulate)
    sim_revision = ctp_api.create_slot_revision(metadata={
        "eventId": ctp_api.event_id(),
    })
    sim_revision_id = sim_revision["id"]

    # Generate and upload actual slots — this must succeed before calling the simulator
    slots = _generate_slots_from_groups(slot_groups)
    if slots:
        ctp_api.add_slots_to_revision(sim_revision_id, slots)

    # Run the simulator. If it is unavailable we continue anyway — the slots are
    # already saved and the draft revision is still created below so the planner
    # remains in a consistent state. The warning is surfaced to the frontend.
    sim_warning = None
    commentary = ""
    draft_revision_number = None
    try:
        # Pass ID-based slot_groups; Go stores them as-is in the new draft's commentary.
        sim_result = ctp_api.simulate_slots(slot_groups=slot_groups, caps=caps)
        commentary = (sim_result or {}).get("simulationOutputCommentary", "")
        draft_revision_number = (sim_result or {}).get("draftRevisionNumber")
    except (requests.HTTPError, requests.ConnectionError, requests.Timeout) as exc:
        sim_warning = f"Simulator unavailable — slots were created but not timed: {exc}"

    # If Go created the draft revision (draftRevisionNumber present), use that number.
    # Otherwise fall back to creating the draft here so the planner stays consistent.
    if draft_revision_number:
        planner_revisions = draft_revision_number
    else:
        draft_commentary = json.dumps({
            "slotGroups": slot_groups,  # ID-based
            "caps":       caps,
            "draft":      True,
        })
        draft_revision = ctp_api.create_slot_revision(metadata={
                "eventId":                   ctp_api.event_id(),
                "slotPlannerDraftCommentary": draft_commentary,
            })
        planner_revisions = draft_revision.get("number", body.get("plannerRevisions", 0))

    # Convert ID-based slot_groups to identifier format for the frontend response.
    airport_ident_by_id, rs_ident_by_id = _build_ident_lookups(route_segments, airports)
    ident_slot_groups = _id_groups_to_ident_groups(slot_groups, airport_ident_by_id, rs_ident_by_id)

    return ident_slot_groups, caps, planner_revisions, sim_warning, commentary


def _submit_calculate(body: dict):
    # Simulator creates Rev N+1 with proposed slots
    calc_result = ctp_api.calculate_slots()
    commentary = calc_result.get("slotGenerationOutputCommentary", "") if calc_result else ""

    # Fetch the newly created revision (now the latest) with full slot data
    calc_revision = ctp_api.get_latest_slot_revision()

    # Reverse-map slots → identifier-based slot groups (for the frontend response)
    route_segments = ctp_api.get_route_segments()
    airports = ctp_api.get_airports()
    raw_slots = calc_revision.get("slots", []) if calc_revision else []
    slot_groups = _derive_slot_groups_from_slots(raw_slots, route_segments, airports)

    # Derive caps from the DB so user-set capacities (airports.maximumSlots,
    # routeSegments.maximumAircraftPerHour) are reflected immediately.
    # Airport caps use maximumSlots directly (not a per-hour rate).
    # Route segment caps use maximumAircraftPerHour * departure_hours.
    derived = ctp_api.derive_setup(route_segments, airports)
    caps = derived["defaultCaps"]

    # Convert slot_groups to ID-based format for storage in the draft.
    airport_id_by_ident, rs_id_by_ident = _build_id_lookups(route_segments, airports)
    id_based_groups = _ident_groups_to_id_groups(slot_groups, airport_id_by_ident, rs_id_by_ident)

    # Create the draft revision for editing
    draft_commentary = json.dumps({
        "slotGroups": id_based_groups,  # ID-based for stability across renames
        "caps":       caps,
        "draft":      True,
    })
    draft_revision = ctp_api.create_slot_revision(metadata={
        "eventId":                   ctp_api.event_id(),
        "slotPlannerDraftCommentary": draft_commentary,
    })

    planner_revisions = draft_revision.get("number", body.get("plannerRevisions", 0))
    # Return identifier-based slot_groups to the frontend
    return slot_groups, caps, planner_revisions, commentary


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
    _require_staff(user)
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
    _require_staff(user)
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

def _split_slot_id(id_str):
    parts = id_str.split('|')
    return parts if len(parts) == 5 else None


def _parse_commentary(raw: str):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def _is_new_draft_format(slot_groups: list) -> bool:
    """Return True if slot_groups use the ID-based draft format (has depAirportId field)."""
    return bool(slot_groups) and "depAirportId" in slot_groups[0]


def _build_id_lookups(route_segments: list, airports: list):
    """Return (airport_id_by_ident, rs_id_by_ident) maps for converting identifiers → DB IDs."""
    def norm(v):
        return (v or "").strip().upper()
    airport_id_by_ident = {
        norm(a.get("waypoint", {}).get("identifier", "") or a.get("identifier", "")): a["id"]
        for a in (airports or []) if a.get("id")
    }
    rs_id_by_ident = {
        (seg.get("identifier") or "").strip(): seg["id"]
        for seg in (route_segments or []) if seg.get("id")
    }
    return airport_id_by_ident, rs_id_by_ident


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


def _ident_groups_to_id_groups(slot_groups: list, airport_id_by_ident: dict, rs_id_by_ident: dict) -> list:
    """
    Convert identifier-based slot groups [{id: "dep|depRoute|track|arrRoute|arr", value}]
    to ID-based [{depAirportId, depRouteId, trackId, arrRouteId, arrAirportId, value}].
    Logs and skips groups where any part cannot be resolved.
    """
    result = []
    for group in slot_groups:
        gid   = group.get("id", "")
        value = int(group.get("value", 0))
        if value <= 0:
            continue
        parts = _split_slot_id(gid)
        if not parts:
            print(f"[slot-planner] WARNING: malformed slot group id '{gid}' — skipped", file=sys.stderr)
            continue
        dep, dep_route, track, arr_route, arr = parts
        dep_airport_id = airport_id_by_ident.get(dep)
        dep_route_id   = rs_id_by_ident.get(dep_route)
        track_id       = rs_id_by_ident.get(track)
        arr_route_id   = rs_id_by_ident.get(arr_route)
        arr_airport_id = airport_id_by_ident.get(arr)
        if not all([dep_airport_id, dep_route_id, track_id, arr_route_id, arr_airport_id]):
            missing = []
            if not dep_airport_id: missing.append(f"dep airport '{dep}'")
            if not dep_route_id:   missing.append(f"depRoute '{dep_route}'")
            if not track_id:       missing.append(f"track '{track}'")
            if not arr_route_id:   missing.append(f"arrRoute '{arr_route}'")
            if not arr_airport_id: missing.append(f"arr airport '{arr}'")
            print(
                f"[slot-planner] WARNING: could not resolve {', '.join(missing)} "
                f"for slot group '{gid}' ({value} slots) — skipped",
                file=sys.stderr,
            )
            continue
        result.append({
            "depAirportId": dep_airport_id,
            "depRouteId":   dep_route_id,
            "trackId":      track_id,
            "arrRouteId":   arr_route_id,
            "arrAirportId": arr_airport_id,
            "value":        value,
        })
    return result


def _id_groups_to_ident_groups(slot_groups: list, airport_ident_by_id: dict, rs_ident_by_id: dict) -> list:
    """
    Convert ID-based slot groups [{depAirportId, depRouteId, trackId, arrRouteId, arrAirportId, value}]
    to identifier-based [{id: "dep|depRoute|track|arrRoute|arr", value}].
    Logs and skips groups where any ID cannot be resolved to a current identifier
    (e.g. a route or airport was deleted).
    """
    result = []
    for group in slot_groups:
        value = int(group.get("value", 0))
        if value <= 0:
            continue
        dep   = airport_ident_by_id.get(group.get("depAirportId"))
        dr    = rs_ident_by_id.get(group.get("depRouteId"))
        track = rs_ident_by_id.get(group.get("trackId"))
        ar    = rs_ident_by_id.get(group.get("arrRouteId"))
        arr   = airport_ident_by_id.get(group.get("arrAirportId"))
        if not all([dep, dr, track, ar, arr]):
            missing = []
            if not dep:   missing.append(f"depAirportId={group.get('depAirportId')}")
            if not dr:    missing.append(f"depRouteId={group.get('depRouteId')}")
            if not track: missing.append(f"trackId={group.get('trackId')}")
            if not ar:    missing.append(f"arrRouteId={group.get('arrRouteId')}")
            if not arr:   missing.append(f"arrAirportId={group.get('arrAirportId')}")
            print(
                f"[slot-planner] WARNING: could not resolve {', '.join(missing)} "
                f"({value} slots) — route or airport may have been deleted",
                file=sys.stderr,
            )
            continue
        result.append({
            "id":           f"{dep}|{dr}|{track}|{ar}|{arr}",
            "value":        value,
            "depAirportId": group.get("depAirportId"),
            "depRouteId":   group.get("depRouteId"),
            "trackId":      group.get("trackId"),
            "arrRouteId":   group.get("arrRouteId"),
            "arrAirportId": group.get("arrAirportId"),
        })
    return result


def _generate_slots_from_groups(slot_groups: list) -> list:
    """Generate slot records from ID-based slot groups for submission to the API."""
    result = []
    for group in slot_groups:
        count = int(group.get("value", 0))
        if count <= 0:
            continue
        dep_airport_id = group.get("depAirportId")
        dep_route_id   = group.get("depRouteId")
        track_id       = group.get("trackId")
        arr_route_id   = group.get("arrRouteId")
        arr_airport_id = group.get("arrAirportId")
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
    # Build airport identifier lookup by DB id (no waypoint preload needed)
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

    # Build a classification cache keyed by route segment DB id
    # (uses the fully-populated route_segments list, not the stub data on slots)
    rs_class_by_id = {}
    for rs in (route_segments or []):
        if rs.get("id"):
            rs_class_by_id[rs["id"]] = (_classify(rs), (rs.get("identifier") or "").strip())

    counts: dict = {}

    for slot in (slots or []):
        # Use the direct airport ID fields — no nested waypoint preload required
        dep_icao = airport_icao_by_id.get(slot.get("departureAirportId"))
        arr_icao = airport_icao_by_id.get(slot.get("arrivalAirportId"))
        if not dep_icao or not arr_icao:
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
                dep_route_id = ident
            elif kind == "track" and track_id is None:
                track_id = ident
            elif kind == "arr" and arr_route_id is None:
                arr_route_id = ident

        if not all([dep_route_id, track_id, arr_route_id]):
            continue

        group_id = f"{dep_icao}|{dep_route_id}|{track_id}|{arr_route_id}|{arr_icao}"
        counts[group_id] = counts.get(group_id, 0) + 1

    return [{"id": gid, "value": v} for gid, v in sorted(counts.items())]


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
