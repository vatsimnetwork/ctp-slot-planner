import os
import json
import functools
import requests
from flask import Flask, request, jsonify, session, redirect
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()

import ctp_api

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-secret-change-me-in-production")

CORS(app, supports_credentials=True, resources={r"/*": {"origins": "*"}})

DEBUG = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
AUTH_BYPASS = os.environ.get("AUTH_BYPASS", "false").lower() == "true"


# ─── Auth helpers ─────────────────────────────────────────────────────────────

def require_login(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        if AUTH_BYPASS:
            return fn(*args, **kwargs)
        if "user" not in session:
            return jsonify({"error": "Not authenticated"}), 401
        return fn(*args, **kwargs)
    return wrapper


def _ext_error(e: requests.HTTPError):
    status = e.response.status_code if e.response is not None else 502
    try:
        body = e.response.json()
    except Exception:
        body = {"message": str(e)}
    return jsonify({"error": "External API error", "upstream": body}), status


# ─── Auth routes ──────────────────────────────────────────────────────────────

@app.get("/login/")
def login():
    return redirect(
        "https://auth.vatsim.net/oauth/authorize"
        f"?client_id={os.environ.get('VATSIM_CLIENT_ID','')}"
        "&redirect_uri=https://planning.ctp.vatsim.net/auth/callback"
        "&response_type=code"
        "&scope=full_name"
    )


@app.get("/auth/callback/")
def auth_callback():
    code = request.args.get("code")
    if not code:
        return jsonify({"error": "Missing code"}), 400
    try:
        res = requests.post("https://auth.vatsim.net/oauth/token", data={
            "grant_type":    "authorization_code",
            "client_id":     os.environ.get("VATSIM_CLIENT_ID", ""),
            "client_secret": os.environ.get("VATSIM_CLIENT_SECRET", ""),
            "redirect_uri":  "https://planning.ctp.vatsim.net/auth/callback",
            "code":          code,
        }, timeout=15)
        res.raise_for_status()
        token = res.json().get("access_token")
        user = requests.get(
            "https://auth.vatsim.net/api/user",
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        ).json()
        session["user"] = user
    except Exception as e:
        return jsonify({"error": f"Auth failed: {e}"}), 500
    return redirect("/")


@app.get("/logout/")
def logout():
    session.clear()
    return redirect("/")


# ─── /setup/ ──────────────────────────────────────────────────────────────────

@app.get("/setup/")
@require_login
def setup():
    try:
        route_segments = ctp_api.get_route_segments()
        airports = ctp_api.get_airports()
    except requests.HTTPError as e:
        return _ext_error(e)
    except requests.ConnectionError:
        return jsonify({"error": "Cannot reach the CTP API"}), 502
    except Exception as e:
        return jsonify({"error": f"Setup failed: {e}"}), 500

    try:
        derived = ctp_api.derive_setup(route_segments, airports)
    except Exception as e:
        return jsonify({"error": f"Failed to parse API data: {e}"}), 500

    try:
        latest = ctp_api.get_latest_slot_revision()
        if latest:
            sg = _parse_commentary(latest.get("slotGenerationOutputCommentary", ""))
            if sg and sg.get("slotGroups"):
                saved_tracks = {
                    _split_slot_id(item["id"])[2]
                    for item in sg["slotGroups"]
                    if item.get("id") and _split_slot_id(item["id"])
                }
                derived["tracks"] = sorted(set(derived["tracks"]) | saved_tracks)
    except Exception:
        pass

    try:
        rev = ctp_api.get_latest_route_revision()
        routes_revision = rev["number"] if rev else None
    except Exception:
        routes_revision = None

    return jsonify({**derived, "routesRevision": routes_revision})


# ─── /slotgroups/ ─────────────────────────────────────────────────────────────

@app.get("/slotgroups/")
@require_login
def get_slotgroups():
    try:
        latest = ctp_api.get_latest_slot_revision()
        rev = ctp_api.get_latest_route_revision()
    except requests.HTTPError as e:
        return _ext_error(e)
    except requests.ConnectionError:
        return jsonify({"error": "Cannot reach the CTP API"}), 502

    routes_revision = rev["number"] if rev else None
    planner_revisions = latest.get("number", 0) if latest else 0

    slot_groups, caps, dep_times, start_time = [], {}, {}, "1800z"

    if latest:
        draft = _parse_commentary(latest.get("slotGenerationOutputCommentary", ""))
        if draft:
            slot_groups = draft.get("slotGroups", [])
            caps        = draft.get("caps", {})
            dep_times   = draft.get("depTimes", {})
            if draft.get("startTime"):
                start_time = draft["startTime"]

    return jsonify({
        "slotGroups":       slot_groups,
        "routesRevision":   routes_revision,
        "plannerRevisions": planner_revisions,
        "startTime":        start_time,
        "depTimes":         dep_times,
        "caps":             caps,
    })


# ─── /slotgroups/save/ ────────────────────────────────────────────────────────

@app.post("/slotgroups/save/")
@require_login
def save_slotgroups():
    body = request.get_json(force=True)

    commentary = json.dumps({
        "slotGroups": body.get("slotGroups", []),
        "caps":       body.get("caps", {}),
        "depTimes":   body.get("depTimes", {}),
        "startTime":  body.get("startTime", "1800z"),
        "draft":      True,
    })

    try:
        latest = ctp_api.get_latest_slot_revision()
        if latest:
            ctp_api.update_slot_revision(latest["id"], {
                "slotGenerationOutputCommentary": commentary,
            })
        else:
            ctp_api.create_slot_revision(metadata={
                "eventId":                        ctp_api.event_id(),
                "slotGenerationOutputCommentary": commentary,
            })
    except requests.HTTPError as e:
        return _ext_error(e)
    except requests.ConnectionError:
        return jsonify({"error": "Cannot reach the CTP API"}), 502

    return jsonify({"ok": True})


# ─── /slotgroups/submit/ ──────────────────────────────────────────────────────

@app.post("/slotgroups/submit/")
@require_login
def submit_slotgroups():
    body = request.get_json(force=True)
    mode = body.get("mode", "calculate")

    sim_params = body.get("simulatorParams", {})
    field_map = {
        "RecalculateMaximumAirportSlots":                        "recalculateMaximumAirportSlots",
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
        api_k: sim_params[fe_k]
        for fe_k, api_k in field_map.items()
        if fe_k in sim_params
    }

    try:
        if event_update:
            ctp_api.update_event(ctp_api.event_id(), event_update)

        if mode == "simulate":
            result = ctp_api.simulate_slots()
        else:
            result = ctp_api.calculate_slots()

        commentary = json.dumps({
            "slotGroups": result.get("slotGroups", body.get("slotGroups", [])),
            "caps":       body.get("caps", {}),
            "depTimes":   body.get("depTimes", {}),
            "startTime":  body.get("startTime", "1800z"),
            "draft":      False,
            "mode":       mode,
        })
        ctp_api.create_slot_revision(metadata={
            "eventId":                        ctp_api.event_id(),
            "slotGenerationOutputCommentary": commentary,
        })

    except requests.HTTPError as e:
        return _ext_error(e)
    except requests.ConnectionError:
        return jsonify({"error": "Cannot reach the CTP API"}), 502

    
    return jsonify({
        "slotGroups":       result.get("slotGroups", []),
        "caps":             result.get("caps", body.get("caps", {})),
        "plannerRevisions": body.get("plannerRevisions", 0),
        "mode":             mode,
    })


# ─── Health check ─────────────────────────────────────────────────────────────

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
    parts, s = [], id_str
    for _ in range(4):
        idx = s.find('-')
        if idx < 0:
            return None
        parts.append(s[:idx])
        s = s[idx + 1:]
    parts.append(s)
    return parts


def _parse_commentary(raw: str):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


# ─── Run ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=5000,
        debug=DEBUG,
    )