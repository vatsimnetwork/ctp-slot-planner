import React, { useEffect, useRef, useState, useLayoutEffect, useCallback } from "react";
import * as d3 from "d3";
import "./SlotPlanner.css";

// ─── Layout constants ─────────────────────────────────────────────────────────
const ROW_H       = 52;
const HEADER_H    = 47 + 20;
const TRACK_COLS  = ['#2783C5', '#29B473', '#2A3B90', '#E8543E', '#9B59B6', '#F39C12'];
const BRACE_W     = 18;
const TIME_W      = 0;
const BRACE_GAP   = 0;
const BRACE_COL_W = BRACE_W + 16;

// ─── Default simulator parameters ────────────────────────────────────────────
const DEFAULT_SIM_PARAMS = {
  RecalculateMaximumAirportSlots:                    true,
  IntendedSlotGenerationMode:                        'MaximizeSlots',
  DepartureTimeWindowOffsetSynchronizationLongitude: -30,
  SimulationAnalysisResolutionInMinutes:             2,
  ShouldSimulationUseActualWeatherForecastData:      false,
  IntendedDepartureTimeWindowOffsetsCalculationMode: 'EarliestRoutes',
  DepartureTimeWindowOffsetSynchronizationTimeOfDay: '1600z',
  CalculateThroughputDataOnlyForManuallyProvidedSectors: true,
  IntendedWaypointThroughputCalculationMode:         'FirstWaypointsOfNATRouteSegmentsOnly',
  ThresholdToCheckIfAirplaneIsCountedAtWaypointInNm: 5,
  CalculationFallbackGroundSpeed:                    300,
  HighSimulationAccuracy:                            false,
};

// ─── API helpers ──────────────────────────────────────────────────────────────
const BASE = import.meta.env.BASE_URL;
async function apiFetch(url, options = {}) {
  const res = await fetch(BASE + url.replace(/^\//, ''), { ...options, credentials: 'include' });
  if (res.status === 401) { window.location.href = BASE + 'login/?return_to=' + encodeURIComponent(window.location.pathname + window.location.search); throw new Error('Unauthorized'); }
  return res;
}
const API = {
  loadSetup: () => apiFetch('/setup/'),
  loadSlots: () => apiFetch('/slotgroups/'),
  save:      (p) => apiFetch('/slotgroups/save/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }),
  submit:    (p) => apiFetch('/slotgroups/submit/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }),
  syncTime:  (v) => apiFetch('/synctime/', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: v }) }),
};

// ─── ID parser ────────────────────────────────────────────────────────────────
// New IDs use '|' as separator to avoid ambiguity with route segment identifiers
// that contain hyphens.  Legacy IDs (stored before this change) still use the
// first-4-hyphen split for backward compatibility.
function splitSlotId(id) {
  if (id.includes('|')) {
    const parts = id.split('|');
    if (parts.length !== 5) { console.warn('[SlotPlanner] Bad ID:', id); return null; }
    return parts;
  }
  // Legacy: split on the first 4 hyphens
  const parts = []; let str = id;
  for (let i = 0; i < 4; i++) {
    const idx = str.indexOf('-');
    if (idx < 0) { console.warn('[SlotPlanner] Bad ID:', id); return null; }
    parts.push(str.slice(0, idx)); str = str.slice(idx + 1);
  }
  parts.push(str); return parts;
}

// ─── Parse slot groups into display data ─────────────────────────────────────
function parseSlotGroups(slotGroups, caps = {}) {
  const deps = {}, depRoutes = {}, tracks = {}, arrRoutes = {}, arrs = {};
  const connections = [];
  let tcIdx = 0;
  const C = { deps: caps.deps||{}, depRoutes: caps.depRoutes||{}, tracks: caps.tracks||{}, arrRoutes: caps.arrRoutes||{}, arrs: caps.arrs||{} };

  (slotGroups || []).forEach(({ id, value }) => {
    const p = splitSlotId(id); if (!p) return;
    const [dep, depRoute, track, arrRoute, arr] = p;
    if (!deps[dep])           deps[dep]           = { id: dep,      value: 0, cap: C.deps[dep]           ?? null };
    if (!depRoutes[depRoute]) depRoutes[depRoute]  = { id: depRoute, value: 0, cap: C.depRoutes[depRoute] ?? null, selected: true };
    if (!tracks[track])       tracks[track]        = { id: track,    col: TRACK_COLS[tcIdx++ % TRACK_COLS.length], slots: 0, cap: C.tracks[track] ?? null };
    if (!arrRoutes[arrRoute]) arrRoutes[arrRoute]  = { id: arrRoute, value: 0, cap: C.arrRoutes[arrRoute] ?? null, selected: true };
    if (!arrs[arr])           arrs[arr]            = { id: arr,      value: 0, cap: C.arrs[arr]           ?? null };
    deps[dep].value += value; depRoutes[depRoute].value += value; tracks[track].slots += value;
    arrRoutes[arrRoute].value += value; arrs[arr].value += value;
    connections.push({ dep, depRoute, track, arrRoute, arr, value });
  });
  return { deps: Object.values(deps), depRoutes: Object.values(depRoutes), tracks: Object.values(tracks), arrRoutes: Object.values(arrRoutes), arrs: Object.values(arrs), connections };
}

function snapshotCaps(data) {
  return {
    deps:      Object.fromEntries(data.deps.map(d      => [d.id, d.cap])),
    depRoutes: Object.fromEntries(data.depRoutes.map(r => [r.id, r.cap])),
    tracks:    Object.fromEntries(data.tracks.map(t    => [t.id, t.cap])),
    arrRoutes: Object.fromEntries(data.arrRoutes.map(r => [r.id, r.cap])),
    arrs:      Object.fromEntries(data.arrs.map(a      => [a.id, a.cap])),
  };
}

// ─── Time helpers ─────────────────────────────────────────────────────────────
function parseTime(v) {
  const s = (v||'').trim().toLowerCase().replace('z','');
  return { h: Math.min(23,Math.max(0,parseInt(s.slice(0,2),10)||0)), m: Math.min(59,Math.max(0,parseInt(s.slice(2,4),10)||0)) };
}
function formatTime({ h, m }) { return `${String(h).padStart(2,'0')}${String(m).padStart(2,'00')}z`; }

function barycentricOrder(items, conns, key, prevKey, prevOrder) {
  return items.map(item => {
    const linked = conns.filter(c => c[key] === item.id);
    const bary   = linked.length ? d3.mean(linked.map(c => prevOrder.get(c[prevKey]))) : Infinity;
    return { item, bary };
  }).sort((a,b) => a.bary - b.bary).map(d => d.item);
}

// ─── QuantityLabel ────────────────────────────────────────────────────────────
function QuantityLabel({ used, cap, size = 'md' }) {
  return (
    <span className={`qty-label qty-label--${size}${cap != null && used > cap ? ' qty-label--over' : ''}`}>
      {used}{cap != null ? <span className="qty-sep">/{cap}</span> : null}
    </span>
  );
}

// ─── TimeSpinner ──────────────────────────────────────────────────────────────
function TimeSpinner({ value, onChange, style, className }) {
  const { h, m } = parseTime(value);
  const setH = (d) => onChange(formatTime({ h: ((h+d)%24+24)%24, m }));
  const setM = (d) => { let nm=m+d,nh=h; if(nm>=60){nm-=60;nh=(nh+1)%24} if(nm<0){nm+=60;nh=((nh-1)%24+24)%24} onChange(formatTime({h:nh,m:nm})); };
  const Arr = ({onClick,dir}) => <button className="planner__time-arrow" type="button" tabIndex={-1} onClick={e=>{e.stopPropagation();onClick();}}>{dir==='up'?'▲':'▼'}</button>;
  return (
    <div className={`planner__time-spinner${className?' '+className:''}`} style={style} onClick={e=>e.stopPropagation()}>
      <div className="planner__time-col"><Arr onClick={()=>setH(1)} dir="up"/><span className="planner__time-seg">{String(h).padStart(2,'0')}</span><Arr onClick={()=>setH(-1)} dir="down"/></div>
      <span className="planner__time-sep">:</span>
      <div className="planner__time-col"><Arr onClick={()=>setM(1)} dir="up"/><span className="planner__time-seg">{String(m).padStart(2,'0')}</span><Arr onClick={()=>setM(-1)} dir="down"/></div>
      <span className="planner__time-z">z</span>
    </div>
  );
}

// ─── CurlyBrace ───────────────────────────────────────────────────────────────
function CurlyBrace({ height }) {
  if (height < 6) return <div style={{ width: BRACE_W }} />;
  const W=BRACE_W, mid=height/2, c=Math.min(height*0.11,13), sp=W*0.48;
  const d=[`M ${W} 0`,`C ${sp} 0,${sp} ${c},${sp} ${c}`,`L ${sp} ${mid-c}`,`C ${sp} ${mid-c*0.35},0 ${mid-c*0.15},0 ${mid}`,`C 0 ${mid+c*0.15},${sp} ${mid+c*0.35},${sp} ${mid+c}`,`L ${sp} ${height-c}`,`C ${sp} ${height-c},${sp} ${height},${W} ${height}`].join(' ');
  return <svg width={W} height={height} style={{display:'block',flexShrink:0}}><path d={d} fill="none" stroke="var(--border)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

// ─── SimParamsModal ───────────────────────────────────────────────────────────
function SimParamsModal({ mode, params, onParamsChange, onConfirm, onClose }) {
  const set = (k,v) => onParamsChange({...params,[k]:v});
  const label = mode === 'calculate' ? 'Calculate Slots' : 'Simulate Slots';
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e=>e.stopPropagation()}>
        <div className="modal-header"><span className="modal-title">{label} — Parameters</span><button className="modal-close" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="modal-section-title">Slot Generation</div>
          <label className="modal-row"><span className="modal-label">Slot Generation Mode</span>
            <select className="modal-select" value={params.IntendedSlotGenerationMode} onChange={e=>set('IntendedSlotGenerationMode',e.target.value)}>
              <option value="MaximizeSlots">Maximize Slots</option><option value="Random">Random</option>
            </select></label>
          <label className="modal-row modal-row--check"><input type="checkbox" checked={params.RecalculateMaximumAirportSlots} onChange={e=>set('RecalculateMaximumAirportSlots',e.target.checked)}/><span className="modal-label">Recalculate Maximum Airport Slots</span></label>
          <div className="modal-section-title">Simulation</div>
          <label className="modal-row"><span className="modal-label">Analysis Resolution (minutes)</span><input className="modal-input" type="number" min={1} max={60} value={params.SimulationAnalysisResolutionInMinutes} onChange={e=>set('SimulationAnalysisResolutionInMinutes',parseInt(e.target.value)||2)}/></label>
          <label className="modal-row modal-row--check"><input type="checkbox" checked={params.ShouldSimulationUseActualWeatherForecastData} onChange={e=>set('ShouldSimulationUseActualWeatherForecastData',e.target.checked)}/><span className="modal-label">Use Actual Weather Forecast Data</span></label>
          <label className="modal-row modal-row--check"><input type="checkbox" checked={params.HighSimulationAccuracy} onChange={e=>set('HighSimulationAccuracy',e.target.checked)}/><span className="modal-label">High Simulation Accuracy (ellipsoid earth model)</span></label>
          <label className="modal-row"><span className="modal-label">Calculation Fallback Ground Speed (kt)</span><input className="modal-input" type="number" min={100} max={600} value={params.CalculationFallbackGroundSpeed} onChange={e=>set('CalculationFallbackGroundSpeed',parseFloat(e.target.value)||300)}/></label>
          <div className="modal-section-title">Departure Time Windows</div>
          <label className="modal-row"><span className="modal-label">Offset Calculation Mode</span>
            <select className="modal-select" value={params.IntendedDepartureTimeWindowOffsetsCalculationMode} onChange={e=>set('IntendedDepartureTimeWindowOffsetsCalculationMode',e.target.value)}>
              <option value="None">None</option><option value="EarliestRoutes">Earliest Routes</option><option value="LatestRoutes">Latest Routes</option><option value="RouteAverage">Route Average</option>
            </select></label>
          <label className="modal-row"><span className="modal-label">Synchronisation Longitude (°)</span><input className="modal-input" type="number" step={0.5} min={-180} max={180} value={params.DepartureTimeWindowOffsetSynchronizationLongitude} onChange={e=>set('DepartureTimeWindowOffsetSynchronizationLongitude',parseFloat(e.target.value)||-30)}/></label>
          <div className="modal-row"><span className="modal-label">Synchronisation Time (UTC)</span><TimeSpinner value={params.DepartureTimeWindowOffsetSynchronizationTimeOfDay} onChange={v=>set('DepartureTimeWindowOffsetSynchronizationTimeOfDay',v)}/></div>
          <div className="modal-section-title">Throughput</div>
          <label className="modal-row"><span className="modal-label">Waypoint Throughput Calculation</span>
            <select className="modal-select" value={params.IntendedWaypointThroughputCalculationMode} onChange={e=>set('IntendedWaypointThroughputCalculationMode',e.target.value)}>
              <option value="None">None</option><option value="FirstWaypointsOfNATRouteSegmentsOnly">First Waypoints of NAT Route Segments Only</option><option value="AllWaypoints">All Waypoints</option>
            </select></label>
          <label className="modal-row"><span className="modal-label">Waypoint Count Threshold (NM)</span><input className="modal-input" type="number" step={0.5} min={0} value={params.ThresholdToCheckIfAirplaneIsCountedAtWaypointInNm} onChange={e=>set('ThresholdToCheckIfAirplaneIsCountedAtWaypointInNm',parseFloat(e.target.value)||5)}/></label>
          <label className="modal-row modal-row--check"><input type="checkbox" checked={params.CalculateThroughputDataOnlyForManuallyProvidedSectors} onChange={e=>set('CalculateThroughputDataOnlyForManuallyProvidedSectors',e.target.checked)}/><span className="modal-label">Throughput for Manually Provided Sectors Only</span></label>
        </div>
        <div className="modal-footer">
          <button className="planner__btn" onClick={onConfirm}>Run {label}</button>
          <button className="planner__btn" style={{background:'var(--text-muted)'}} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────
export default function SlotPlanner() {
  const [theme, setTheme] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const [data, setData]   = useState({ deps:[], depRoutes:[], tracks:[], arrRoutes:[], arrs:[], connections:[] });
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [setupData, setSetupData] = useState({ deps:[], depRoutesByDep:{}, tracks:[], arrRoutes:[], arrs:[], tracksByDepRoute:{}, arrRoutesByTrack:{}, arrByArrRoute:{}, dbIds:{airports:{},routeSegments:{}}, departureHours:3, defaultCaps:{deps:{},depRoutes:{},tracks:{},arrRoutes:{},arrs:{}} });
  const [simVersion,       setSimVersion]       = useState(null);
  const [plannerRevisions, setPlannerRevisions] = useState(0);
  const [selectedDep, setSelectedDep] = useState(null);
  const [syncTime,    setSyncTime]    = useState('1600z');
  const syncTimer = useRef(null);
  const [newRoute,    setNewRoute]    = useState({ dep:'', depRoute:'', track:'', arrRoute:'', arr:'', value:0 });
  const [searchTerm,  setSearchTerm]  = useState('');
  const [simParams,   setSimParams]   = useState({ ...DEFAULT_SIM_PARAMS });
  const [showModal,   setShowModal]   = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pendingMode, setPendingMode] = useState(null);
  const [toasts,      setToasts]      = useState([]);
  const [isStaff,     setIsStaff]     = useState(false);
  const svgRef  = useRef(null);
  const gridRef = useRef(null);
  const editRef = useRef(null);
  const [colPositions, setColPositions] = useState(null);
  const [braceHeight,  setBraceHeight]  = useState(0);
  const saveTimer = useRef(null);

  
  const hasEdits = useRef(false);

  const addToast = useCallback((msg, type='error') => {
    const id = Date.now()+Math.random();
    setToasts(p => [...p,{id,message:msg,type}]);
    setTimeout(() => setToasts(p => p.filter(t=>t.id!==id)), 5000);
  }, []);
  const dismissToast = (id) => setToasts(p => p.filter(t=>t.id!==id));

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    Promise.all([
      API.loadSetup().then(r => r.ok ? r.json() : Promise.reject(`Setup failed (${r.status})`)),
      API.loadSlots().then(r  => r.ok ? r.json() : Promise.reject(`Slots failed (${r.status})`)),
    ])
    .then(([setup, raw]) => {
      setSetupData({
        deps:             setup.deps||[],
        depRoutesByDep:   setup.depRoutesByDep||{},
        tracks:           setup.tracks||[],
        arrRoutes:        setup.arrRoutes||[],
        arrs:             setup.arrs||[],
        tracksByDepRoute: setup.tracksByDepRoute||{},
        arrRoutesByTrack: setup.arrRoutesByTrack||{},
        arrByArrRoute:    setup.arrByArrRoute||{},
        dbIds:            setup.dbIds||{airports:{},routeSegments:{}},
        departureHours:   setup.departureHours||3,
        defaultCaps:      setup.defaultCaps||{deps:{},depRoutes:{},tracks:{},arrRoutes:{},arrs:{}},
      });
      setIsStaff(setup.isStaff ?? false);
      if (setup.syncTime) setSyncTime(setup.syncTime);
      setSimParams(p => ({ ...p, DepartureTimeWindowOffsetSynchronizationTimeOfDay: setup.syncTime || p.DepartureTimeWindowOffsetSynchronizationTimeOfDay }));
      const slotGroups = Array.isArray(raw) ? raw : (raw.slotGroups ?? []);
      setData(parseSlotGroups(slotGroups, setup.defaultCaps ?? {}));
      if (!Array.isArray(raw)) {
        if (raw.routesRevision   != null) setSimVersion(raw.routesRevision);
        if (raw.plannerRevisions != null) setPlannerRevisions(raw.plannerRevisions);
      }
    })
    .catch(err => addToast(String(err), 'error'))
    .finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (selectedDep) setNewRoute(p => ({...p, dep:selectedDep, depRoute:''})); }, [selectedDep]);

  const { deps, depRoutes, tracks, arrRoutes, arrs, connections } = data;

  // ── Auto-save (debounced 800 ms) ─────────────────────────────────────────
  const latestData      = useRef(data);
  latestData.current = data;

  const buildPayload = useCallback((extras = {}) => ({
    slotGroups: latestData.current.connections.map(c => ({
      id:    `${c.dep}|${c.depRoute}|${c.track}|${c.arrRoute}|${c.arr}`,
      value: c.value,
    })),
    ...extras,
  }), []);

  useEffect(() => {
    if (loading || !isStaff) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      setSaving(true);
      API.save(buildPayload())
        .then(r => r.ok ? null : Promise.reject(`Auto-save failed (${r.status})`))
        .catch(err => addToast(String(err), 'error'))
        .finally(() => setSaving(false));
    }, 800);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [data, loading]);

  // ── Sync time (debounced, PATCH to event) ────────────────────────────────
  const handleSyncTimeChange = useCallback((val) => {
    setSyncTime(val);
    setSimParams(p => ({ ...p, DepartureTimeWindowOffsetSynchronizationTimeOfDay: val }));
    if (!isStaff) return;
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      API.syncTime(val).catch(() => addToast('Failed to save synchronization time', 'error'));
    }, 800);
  }, [isStaff, addToast]);

  // ── Search filter ─────────────────────────────────────────────────────────
  const term = searchTerm.trim().toLowerCase();
  const filteredConns = term ? connections.filter(c=>[c.dep,c.depRoute,c.track,c.arrRoute,c.arr].some(v=>v.toLowerCase().includes(term))) : connections;
  const vDeps      = deps.filter(d      => !term || filteredConns.some(c=>c.dep===d.id));
  const vDepRoutes = depRoutes.filter(r  => !term || filteredConns.some(c=>c.depRoute===r.id));
  const vTracks    = tracks.filter(t    => !term || filteredConns.some(c=>c.track===t.id));
  const vArrRoutes = arrRoutes.filter(r  => !term || filteredConns.some(c=>c.arrRoute===r.id));
  const vArrs      = arrs.filter(a      => !term || filteredConns.some(c=>c.arr===a.id));

  const depOrd     = new Map(vDeps.map((d,i)=>[d.id,i]));
  const oDR        = barycentricOrder(vDepRoutes, filteredConns,'depRoute','dep',depOrd);
  const drOrd      = new Map(oDR.map((d,i)=>[d.id,i]));
  const oTr        = barycentricOrder(vTracks,    filteredConns,'track','depRoute',drOrd);
  const trOrd      = new Map(oTr.map((d,i)=>[d.id,i]));
  const oAR        = barycentricOrder(vArrRoutes, filteredConns,'arrRoute','track',trOrd);
  const arOrd      = new Map(oAR.map((d,i)=>[d.id,i]));
  const oArrs      = barycentricOrder(vArrs,      filteredConns,'arr','arrRoute',arOrd);

  const maxRows = Math.max(vDeps.length,oDR.length,oTr.length,oAR.length,oArrs.length,1);
  const totalH  = HEADER_H + maxRows*ROW_H;
  const itemY   = (i,n) => { const rh=maxRows*ROW_H/n; return HEADER_H+rh*i+rh/2; };

  // ── Dropdowns (cascading, topology-aware) ────────────────────────────────
  const ddDeps = [...new Set([
    ...setupData.deps,
    ...deps.map(d => d.id),
  ])].sort();

  const ddDepRoutes = (dep) => [...new Set([
    ...(setupData.depRoutesByDep[dep] || []),
    ...connections.filter(c => c.dep === dep).map(c => c.depRoute),
  ])].sort();

  const ddTracks = (depRoute) => [...new Set([
    ...(setupData.tracksByDepRoute[depRoute] || []),
    ...connections.filter(c => c.depRoute === depRoute).map(c => c.track),
  ])].sort();

  const ddArrRoutes = (track) => [...new Set([
    ...(setupData.arrRoutesByTrack[track] || []),
    ...connections.filter(c => c.track === track).map(c => c.arrRoute),
  ])].sort();

  // Arrival is auto-derived from arrRoute; fall back to manual list when unknown
  const autoArr = (arrRoute) => setupData.arrByArrRoute[arrRoute] || null;

  const selConnsAll = selectedDep ? connections.filter(c=>c.dep===selectedDep) : [];
  const selConns    = selectedDep ? filteredConns.filter(c=>c.dep===selectedDep) : [];
  const connLabel   = (conn) => { const i=selConnsAll.findIndex(c=>c.depRoute===conn.depRoute&&c.track===conn.track&&c.arrRoute===conn.arrRoute&&c.arr===conn.arr); return i>=0?String.fromCharCode(65+i):''; };
  const trackCol    = (id)   => tracks.find(t=>t.id===id)?.col||'#2A3B90';

  const recomputeAggregates= (prev, newConns) => {
    const da={}, dra={}, ta={}, ara={}, aa={};
    newConns.forEach(c => {
      da[c.dep]=(da[c.dep]||0)+c.value; dra[c.depRoute]=(dra[c.depRoute]||0)+c.value;
      ta[c.track]=(ta[c.track]||0)+c.value; ara[c.arrRoute]=(ara[c.arrRoute]||0)+c.value;
      aa[c.arr]=(aa[c.arr]||0)+c.value;
    });
    return {
      deps:      prev.deps.map(d      => ({ ...d, value: da[d.id]   || 0 })),
      depRoutes: prev.depRoutes.map(r  => ({ ...r, value: dra[r.id] || 0 })),
      tracks:    prev.tracks.map(t    => ({ ...t, slots: ta[t.id]   || 0 })),
      arrRoutes: prev.arrRoutes.map(r  => ({ ...r, value: ara[r.id] || 0 })),
      arrs:      prev.arrs.map(a      => ({ ...a, value: aa[a.id]   || 0 })),
      connections: newConns,
    };
  };

  const removeConnection = (conn) => {
    hasEdits.current = true;
    setData(prev => {
      const newConns = prev.connections.filter(c => !(
        c.dep===conn.dep && c.depRoute===conn.depRoute &&
        c.track===conn.track && c.arrRoute===conn.arrRoute && c.arr===conn.arr
      ));
      return recomputeAggregates(prev, newConns);
    });
  };

  const editConn = (conn, field, val) => {
    hasEdits.current = true;
    setData(prev => {
      const newConns = prev.connections.map(c => c === conn ? { ...c, [field]: val } : c);
      return recomputeAggregates(prev, newConns);
    });
  };

  const setCap = useCallback((listKey, id, rawVal) => {
    const val = rawVal === '' || rawVal == null ? null : parseInt(rawVal, 10);
    // For airports the stored value IS the cap (maximumSlots).
    // For non-airports the user enters per-hour; display cap = floor(perHour × hours).
    const isAirport = listKey === 'deps' || listKey === 'arrs';
    const displayCap = (isNaN(val) || val == null) ? null
      : isAirport ? val
      : Math.floor(val * setupData.departureHours);
    setData(prev => ({
      ...prev,
      [listKey]: prev[listKey].map(item => item.id === id ? { ...item, cap: displayCap } : item),
    }));
    const numericVal = (isNaN(val) || val == null) ? 0 : val;
    const entityType = isAirport ? 'airport' : 'routeSegment';
    const dbId       = isAirport ? setupData.dbIds.airports[id] : setupData.dbIds.routeSegments[id];
    if (!dbId) return;
    apiFetch('/caps/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: entityType, id: dbId, value: numericVal }),
    }).catch(() => addToast(`Failed to save cap for ${id}`, 'error'));
  }, [setupData.dbIds, setupData.departureHours, addToast]);

  const addConnection = () => {
    const { dep, depRoute, track, arrRoute, arr, value } = newRoute;
    if (!dep||!depRoute||!track||!arrRoute||!arr) { addToast('Fill in all five fields','warning'); return; }
    if (data.connections.some(c=>c.dep===dep&&c.depRoute===depRoute&&c.track===track&&c.arrRoute===arrRoute&&c.arr===arr)) { addToast('Connection already exists','warning'); return; }
    const dc = setupData.defaultCaps || {};
    setData(prev => {
      const newConns = [...prev.connections,{dep,depRoute,track,arrRoute,arr,value}];
      const ensureDep = prev.deps.some(d=>d.id===dep)?prev.deps:[...prev.deps,{id:dep,value:0,cap:dc.deps?.[dep]??null}];
      const ensureDR  = prev.depRoutes.some(r=>r.id===depRoute)?prev.depRoutes:[...prev.depRoutes,{id:depRoute,value:0,cap:dc.depRoutes?.[depRoute]??null,selected:true}];
      const ensureTr  = prev.tracks.some(t=>t.id===track)?prev.tracks:[...prev.tracks,{id:track,col:TRACK_COLS[prev.tracks.length%TRACK_COLS.length],slots:0,cap:dc.tracks?.[track]??null}];
      const ensureAR  = prev.arrRoutes.some(r=>r.id===arrRoute)?prev.arrRoutes:[...prev.arrRoutes,{id:arrRoute,value:0,cap:dc.arrRoutes?.[arrRoute]??null,selected:true}];
      const ensureArr = prev.arrs.some(a=>a.id===arr)?prev.arrs:[...prev.arrs,{id:arr,value:0,cap:dc.arrs?.[arr]??null}];
      const da={},dra={},ta={},ara={},aa={};
      newConns.forEach(c=>{da[c.dep]=(da[c.dep]||0)+c.value;dra[c.depRoute]=(dra[c.depRoute]||0)+c.value;ta[c.track]=(ta[c.track]||0)+c.value;ara[c.arrRoute]=(ara[c.arrRoute]||0)+c.value;aa[c.arr]=(aa[c.arr]||0)+c.value;});
      return { deps:ensureDep.map(d=>({...d,value:da[d.id]||0})), depRoutes:ensureDR.map(r=>({...r,value:dra[r.id]||0})), tracks:ensureTr.map(t=>({...t,slots:ta[t.id]||0})), arrRoutes:ensureAR.map(r=>({...r,value:ara[r.id]||0})), arrs:ensureArr.map(a=>({...a,value:aa[a.id]||0})), connections:newConns };
    });
    setNewRoute(p=>({...p,depRoute:'',track:'',arrRoute:'',arr:'',value:0}));
  };

  // ── Submit ────────────────────────────────────────────────────────────────
  const confirmSubmit = () => {
    setShowModal(false);
    const mode = pendingMode;
    const nextRev = hasEdits.current ? plannerRevisions + 1 : plannerRevisions;
    API.submit(buildPayload({mode, plannerRevisions: nextRev, simulatorParams: simParams}))
      .then(r=>r.ok?r.json():Promise.reject(new Error(`${mode} failed (${r.status})`)))
      .then(res=>{
        setPlannerRevisions(nextRev);
        hasEdits.current = false;
        if (res?.slotGroups) setData(parseSlotGroups(res.slotGroups,res.caps??{}));
        if (res?.warning) addToast(res.warning,'warning');
        if (res?.commentary) addToast(res.commentary,'info');
        addToast(`${mode==='calculate'?'Calculation':'Simulation'} complete — rev ${simVersion}.${nextRev}`,'success');
      })
      .catch(err=>addToast(err.message,'error'));
  };

  // ── Layout effects ────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    if (!gridRef.current) return;
    const update = () => { const cr=gridRef.current.getBoundingClientRect(); const rects=Array.from(gridRef.current.querySelectorAll('.col')).map(c=>{const r=c.getBoundingClientRect();return{left:r.left-cr.left,right:r.right-cr.left};}); setColPositions({rects,totalWidth:cr.width}); };
    update(); window.addEventListener('resize',update); return ()=>window.removeEventListener('resize',update);
  }, [data, searchTerm]);
  useLayoutEffect(()=>{ if(editRef.current) setBraceHeight(editRef.current.offsetHeight); }, [selConns.length,selectedDep]);

  // ── D3 Sankey ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!svgRef.current||!colPositions) return;
    const {rects,totalWidth}=colPositions; if(rects.length<5) return;
    const svg=d3.select(svgRef.current); svg.selectAll('*').remove(); svg.attr('width',totalWidth).attr('height',totalH);
    const band=(x1,y1,x2,y2,col,alpha,bw)=>{
      const mx=(x1+x2)/2;
      const d=Math.abs(y1-y2)<1?`M ${x1} ${y1-bw/2} L ${x2} ${y2-bw/2} L ${x2} ${y2+bw/2} L ${x1} ${y1+bw/2} Z`:`M ${x1} ${y1-bw/2} C ${mx} ${y1-bw/2},${mx} ${y2-bw/2},${x2} ${y2-bw/2} L ${x2} ${y2+bw/2} C ${mx} ${y2+bw/2},${mx} ${y1+bw/2},${x1} ${y1+bw/2} Z`;
      svg.append('path').attr('d',d).attr('fill',col).attr('opacity',alpha);
    };
    const minV=d3.min(filteredConns,c=>c.value)??0, maxV=d3.max(filteredConns,c=>c.value)??1;
    const thick=d3.scaleSqrt().domain([minV,maxV]).range([4,22]).clamp(true);
    filteredConns.forEach(conn=>{
      const di=vDeps.findIndex(d=>d.id===conn.dep); const dri=oDR.findIndex(r=>r.id===conn.depRoute); const ti=oTr.findIndex(t=>t.id===conn.track); const ari=oAR.findIndex(r=>r.id===conn.arrRoute); const ai=oArrs.findIndex(a=>a.id===conn.arr);
      if(di<0||dri<0||ti<0||ari<0||ai<0) return; const trk=oTr[ti]; if(!trk) return;
      const hi=!selectedDep||selectedDep===conn.dep; const ds=depRoutes.find(r=>r.id===conn.depRoute)?.selected; const as=arrRoutes.find(r=>r.id===conn.arrRoute)?.selected;
      const alpha=hi?(ds&&as?0.65:0.08):0.03; const bw=thick(conn.value);
      band(rects[0].right,itemY(di,vDeps.length),rects[1].left,itemY(dri,oDR.length),trk.col,alpha,bw);
      band(rects[1].right,itemY(dri,oDR.length),rects[2].left,itemY(ti,oTr.length),trk.col,alpha,bw);
      band(rects[2].right,itemY(ti,oTr.length),rects[3].left,itemY(ari,oAR.length),trk.col,alpha,bw);
      band(rects[3].right,itemY(ari,oAR.length),rects[4].left,itemY(ai,oArrs.length),trk.col,alpha,bw);
    });
  }, [data, colPositions, selectedDep, searchTerm]);

  const liveSlots = {}; connections.forEach(c=>{liveSlots[c.track]=(liveSlots[c.track]||0)+c.value;});
  const revStr    = simVersion!==null?`${simVersion}.${plannerRevisions}`:'—';

  return (
    <div className="planner" data-theme={theme} onClick={()=>setSelectedDep(null)}>
      {loading && <div className="planner__loading">Loading…</div>}
      {showConfirm && (
        <div className="modal-overlay" onClick={()=>setShowConfirm(false)}>
          <div className="modal-box" style={{maxWidth:480}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Calculate Slots — Confirm</span>
              <button className="modal-close" onClick={()=>setShowConfirm(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{margin:0,lineHeight:1.55,color:'var(--text-secondary)'}}>
                This will <strong style={{color:'var(--text)'}}>replace all current slot assignments</strong> with
                a new proposal from the simulator. Any manual adjustments in the current
                draft will be lost. This action cannot be undone.
              </p>
            </div>
            <div className="modal-footer">
              <button className="planner__btn planner__btn--logout" onClick={()=>setShowConfirm(false)}>Cancel</button>
              <button className="planner__btn planner__btn--destructive" onClick={()=>{setShowConfirm(false);setShowModal(true);}}>
                Continue to Parameters →
              </button>
            </div>
          </div>
        </div>
      )}
      {showModal && <SimParamsModal mode={pendingMode} params={simParams} onParamsChange={setSimParams} onConfirm={confirmSubmit} onClose={()=>setShowModal(false)}/>}

      <div className="planner__toasts">
        {toasts.map(t=>(
          <div key={t.id} className={`planner__toast planner__toast--${t.type}`}>
            <span className="planner__toast-msg">{t.message}</span>
            <button className="planner__toast-close" onClick={()=>dismissToast(t.id)}>✕</button>
          </div>
        ))}
      </div>

      {/* Top bar */}
      <div className="planner__topbar">
        <a href="/" className="planner__title">CTP Slot Planner</a>
        <div className="planner__topbar-right">
          <div className="planner__start-time">
            <span
              className="planner__meta-label"
              title="The time the simulator calculates all aircraft to be at −30° longitude. Departure and arrival times are calculated relative to this synchronization point."
              style={{cursor:'help',borderBottom:'1px dotted var(--text-muted)'}}
            >Sync Time</span>
            <TimeSpinner value={syncTime} onChange={handleSyncTimeChange} style={!isStaff?{pointerEvents:'none',opacity:.5}:{}}/>
          </div>
          <span className="planner__meta-label">Rev <strong className="planner__rev-value">{revStr}</strong></span>
          {saving && <span className="planner__saving-indicator">Saving…</span>}
          {!isStaff && <span className="planner__readonly-badge">Read-only</span>}
          <button disabled={!isStaff} className="planner__btn" onClick={()=>{setPendingMode('calculate');setShowConfirm(true);}}>Calculate Slots</button>
          <button disabled={!isStaff} className="planner__btn planner__btn--sim" onClick={()=>{setPendingMode('simulate');setShowModal(true);}}>Simulate Slots</button>
          <a href={`${import.meta.env.BASE_URL}logout/`} className="planner__btn planner__btn--logout">Logout</a>
          <button className="planner__btn planner__btn--theme" onClick={()=>setTheme(t=>t==='light'?'dark':'light')}>
            <svg className="planner__theme-icon planner__theme-icon--sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07l1.77-1.77M17.3 6.7l1.77-1.77"/></svg>
            <svg className="planner__theme-icon planner__theme-icon--moon" viewBox="0 0 24 24"><path d="M20.35 14.14A9 9 0 1 1 9.86 3.65 7 7 0 0 0 20.35 14.14z"/></svg>
          </button>
        </div>
      </div>

      {/* Control bar */}
      <div className="planner__control-bar" onClick={e=>e.stopPropagation()}>
        {selectedDep && <div className="planner__editing-label"><span className="planner__editing-dot"/>Editing: <strong>{selectedDep}</strong></div>}

        <div className="planner__instructions">
          Click a departure to edit its connections. Use the dropdowns below to add new connections. Hover quantity labels to adjust values. Caps can be set when a departure is selected.
        </div>

        <div className="search-container">
          <input type="text" placeholder="Search by dep, route, track, or arrival…" value={searchTerm} onChange={e=>setSearchTerm(e.target.value)} className="search-input"/>
          {searchTerm && <button className="search-clear" onClick={()=>setSearchTerm('')}>✕</button>}
        </div>
        <div className="planner__control-add">
          <select disabled={!isStaff} value={newRoute.dep} onChange={e=>setNewRoute(r=>({...r,dep:e.target.value,depRoute:'',track:'',arrRoute:'',arr:''}))}>
            <option value="">Departure</option>{ddDeps.map(d=><option key={d} value={d}>{d}</option>)}
          </select>
          <select disabled={!isStaff} value={newRoute.depRoute} onChange={e=>setNewRoute(r=>({...r,depRoute:e.target.value,track:'',arrRoute:'',arr:''}))}>
            <option value="">Dep Route</option>{ddDepRoutes(newRoute.dep).map(r=><option key={r} value={r}>{r}</option>)}
          </select>
          <select disabled={!isStaff} value={newRoute.track} onChange={e=>setNewRoute(r=>({...r,track:e.target.value,arrRoute:'',arr:''}))}>
            <option value="">Track</option>{ddTracks(newRoute.depRoute).map(t=><option key={t} value={t}>{t}</option>)}
          </select>
          <select disabled={!isStaff} value={newRoute.arrRoute} onChange={e=>{const ar=e.target.value;setNewRoute(r=>({...r,arrRoute:ar,arr:autoArr(ar)||''}));}}>
            <option value="">Arr Route</option>{ddArrRoutes(newRoute.track).map(r=><option key={r} value={r}>{r}</option>)}
          </select>
          <select disabled={!isStaff || !!autoArr(newRoute.arrRoute)} value={newRoute.arr} onChange={e=>setNewRoute(r=>({...r,arr:e.target.value}))}>
            <option value="">{autoArr(newRoute.arrRoute) ? autoArr(newRoute.arrRoute) : 'Arrival'}</option>
            {!autoArr(newRoute.arrRoute) && [...new Set([...setupData.arrs,...arrs.map(a=>a.id)])].sort().map(a=><option key={a} value={a}>{a}</option>)}
          </select>
          <input disabled={!isStaff} className="planner__ctrl-num" type="number" min={0} value={newRoute.value} onChange={e=>setNewRoute(r=>({...r,value:parseInt(e.target.value)||0}))}/>
          <button disabled={!isStaff} className="planner__btn" onClick={addConnection}>Add</button>
        </div>

        {selectedDep && selConns.length > 0 && (
          <div className="planner__brace-section">
            <div className="planner__brace-col" style={{width:BRACE_COL_W,minHeight:braceHeight}}>
              <div className="planner__brace-svg-wrap"><CurlyBrace height={braceHeight}/></div>
            </div>
            <div className="planner__control-edit" ref={editRef}>
              {selConns.map(c => (
                <div key={`${c.depRoute}-${c.track}-${c.arrRoute}-${c.arr}`} className="planner__control-row">                  <span className="planner__conn-label" style={{background:trackCol(c.track)}}>{connLabel(c)}</span>
                  <select disabled={!isStaff} value={c.depRoute} onChange={e=>editConn(c,'depRoute',e.target.value)}>
                    {ddDepRoutes(selectedDep).map(r => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                  <select disabled={!isStaff} value={c.track} onChange={e=>editConn(c,'track',e.target.value)}>{ddTracks(c.depRoute).map(t=><option key={t} value={t}>{t}</option>)}</select>
                  <select disabled={!isStaff} value={c.arrRoute} onChange={e=>{const ar=e.target.value;editConn(c,'arrRoute',ar);const a=autoArr(ar);if(a)setData(prev=>{const newConns=prev.connections.map(x=>x===c?{...x,arrRoute:ar,arr:a}:x);return recomputeAggregates(prev,newConns);});}}>{ddArrRoutes(c.track).map(r=><option key={r} value={r}>{r}</option>)}</select>
                  <select disabled={!isStaff || !!autoArr(c.arrRoute)} value={c.arr} onChange={e=>editConn(c,'arr',e.target.value)}>
                    <option value={c.arr}>{c.arr}</option>
                    {!autoArr(c.arrRoute) && [...new Set([...setupData.arrs,...arrs.map(a=>a.id)])].sort().filter(a=>a!==c.arr).map(a=><option key={a} value={a}>{a}</option>)}
                  </select>
                  <input disabled={!isStaff} className="planner__ctrl-num" type="number" value={c.value} onChange={e=>editConn(c,'value',parseInt(e.target.value)||0)}/>
                  <button disabled={!isStaff} className="planner__slot-btn planner__slot-btn--remove" onClick={()=>removeConnection(c)}>✕</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {selectedDep && (
          <div className="planner__cap-editor" onClick={e=>e.stopPropagation()}>
            <span className="planner__cap-editor-title">
              Caps — airports: total slots · routes/tracks: per hour ×{setupData.departureHours}h = total
            </span>
            <div className="planner__cap-grid">
              {deps.filter(d=>d.id===selectedDep).map(d=>(
                <React.Fragment key={d.id}>
                  <span className="planner__cap-key">Dep: {d.id} <em style={{fontWeight:400,color:'var(--text-muted)'}}>slots</em></span>
                  <input className="planner__cap-input" type="number" min={0} value={d.cap??''} placeholder="∞"
                    disabled={!isStaff} onChange={e=>setCap('deps',d.id,e.target.value)}/>
                </React.Fragment>
              ))}
              {[...new Set(selConnsAll.map(c=>c.depRoute))].sort().map(rId=>{
                const r=depRoutes.find(x=>x.id===rId); if(!r) return null;
                const perHr = r.cap!=null ? Math.round(r.cap/setupData.departureHours) : '';
                return (
                  <React.Fragment key={r.id}>
                    <span className="planner__cap-key">Route: {r.id} <em style={{fontWeight:400,color:'var(--text-muted)'}}>
                      /hr{r.cap!=null?` · ${r.cap} total`:''}
                    </em></span>
                    <input className="planner__cap-input" type="number" min={0} value={perHr} placeholder="∞"
                      disabled={!isStaff} onChange={e=>setCap('depRoutes',r.id,e.target.value)}/>
                  </React.Fragment>
                );
              })}
              {[...new Set(selConnsAll.map(c=>c.track))].sort().map(tId=>{
                const t=tracks.find(x=>x.id===tId); if(!t) return null;
                const perHr = t.cap!=null ? Math.round(t.cap/setupData.departureHours) : '';
                return (
                  <React.Fragment key={t.id}>
                    <span className="planner__cap-key" style={{color:t.col}}>Track: {t.id} <em style={{fontWeight:400,color:'var(--text-muted)'}}>
                      /hr{t.cap!=null?` · ${t.cap} total`:''}
                    </em></span>
                    <input className="planner__cap-input" type="number" min={0} value={perHr} placeholder="∞"
                      disabled={!isStaff} onChange={e=>setCap('tracks',t.id,e.target.value)}/>
                  </React.Fragment>
                );
              })}
              {[...new Set(selConnsAll.map(c=>c.arrRoute))].sort().map(rId=>{
                const r=arrRoutes.find(x=>x.id===rId); if(!r) return null;
                const perHr = r.cap!=null ? Math.round(r.cap/setupData.departureHours) : '';
                return (
                  <React.Fragment key={r.id}>
                    <span className="planner__cap-key">ArrRte: {r.id} <em style={{fontWeight:400,color:'var(--text-muted)'}}>
                      /hr{r.cap!=null?` · ${r.cap} total`:''}
                    </em></span>
                    <input className="planner__cap-input" type="number" min={0} value={perHr} placeholder="∞"
                      disabled={!isStaff} onChange={e=>setCap('arrRoutes',r.id,e.target.value)}/>
                  </React.Fragment>
                );
              })}
              {[...new Set(selConnsAll.map(c=>c.arr))].sort().map(aId=>{
                const a=arrs.find(x=>x.id===aId); if(!a) return null;
                return (
                  <React.Fragment key={a.id}>
                    <span className="planner__cap-key">Arr: {a.id} <em style={{fontWeight:400,color:'var(--text-muted)'}}>slots</em></span>
                    <input className="planner__cap-input" type="number" min={0} value={a.cap??''} placeholder="∞"
                      disabled={!isStaff} onChange={e=>setCap('arrs',a.id,e.target.value)}/>
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Sankey grid */}
      <div className="planner__grid" ref={gridRef}>
        <svg ref={svgRef} className="planner__svg"/>

        {/* Departure */}
        <div className="col planner__col">
          <div className="planner__header">Departure</div>
          {vDeps.map(dep => { const isSel=selectedDep===dep.id; const dData=deps.find(d=>d.id===dep.id); return (
            <div key={dep.id} className={`planner__cell planner__cell--dep${isSel?' planner__cell--selected':''}${!isSel&&selectedDep?' planner__cell--dimmed':''}`} style={{height:maxRows*ROW_H/vDeps.length}} onClick={e=>{e.stopPropagation();setSelectedDep(isSel?null:dep.id);}}>
              <div className="planner__cell-dep-info"><span className="planner__cell-name">{dep.id}</span></div>
              <div className="planner__cell-dep-right">
                <QuantityLabel used={dData?.value??0} cap={dData?.cap} size="lg"/>
                {isSel && selConnsAll.length>0 && <div className="planner__label-cluster">{selConnsAll.map((c,i)=><span key={i} className="planner__conn-label" style={{background:trackCol(c.track)}}>{String.fromCharCode(65+i)}</span>)}</div>}
              </div>
            </div>
          );})}
        </div>

        {/* Dep Routes */}
        <div className="col planner__col planner__col--route">
          <div className="planner__header planner__header--center">Route</div>
          {oDR.map(route => { const rc=selectedDep?selConnsAll.filter(c=>c.depRoute===route.id):[]; const opacity=!selectedDep?1:(rc.length>0?1:0.35); return (
            <div key={route.id} className="planner__route-row" style={{height:maxRows*ROW_H/oDR.length,opacity}} onClick={e=>e.stopPropagation()}>
              <span className="planner__route-name">{route.id}</span>
              <div className="planner__route-right">
                {rc.map(c=><span key={`${c.track}-${c.arrRoute}`} className={`planner__conn-label${isStaff?' planner__conn-label--rm':''}`} style={{background:trackCol(c.track)}} onClick={e=>{if(!isStaff)return;e.stopPropagation();removeConnection(c);}}>{connLabel(c)}</span>)}
                <QuantityLabel used={route.value} cap={route.cap} size="md"/>
              </div>
            </div>
          );})}
        </div>

        {/* Track */}
        <div className="col planner__col">
          <div className="planner__header planner__header--center">Track</div>
          {oTr.map(track => { const tc=selectedDep?selConnsAll.filter(c=>c.track===track.id):[]; const active=!selectedDep||filteredConns.some(c=>c.dep===selectedDep&&c.track===track.id); return (
            <div key={track.id} className="planner__cell planner__cell--track" style={{height:maxRows*ROW_H/oTr.length,opacity:active?1:0.15}} onClick={e=>e.stopPropagation()}>
              <div className="planner__track-main">
                <span style={{fontWeight:700,fontSize:26,color:track.col,lineHeight:1}}>{track.id}</span>
                <QuantityLabel used={liveSlots[track.id]||0} cap={track.cap} size="lg"/>
              </div>
              {selectedDep&&tc.length>0&&(
                <div className="planner__label-cluster planner__label-cluster--compact">
                  {tc.map(c=><span key={`${c.depRoute}-${c.arrRoute}`} className="planner__conn-label" style={{background:track.col}}>{connLabel(c)}</span>)}
                </div>
              )}
            </div>
          );})}
        </div>

        {/* Arr Routes */}
        <div className="col planner__col planner__col--route">
          <div className="planner__header planner__header--center">Route</div>
          {oAR.map(route => { const rc=selectedDep?selConnsAll.filter(c=>c.arrRoute===route.id):[]; const active=!selectedDep||filteredConns.some(c=>c.dep===selectedDep&&c.arrRoute===route.id); return (
            <div key={route.id} className="planner__route-row" style={{height:maxRows*ROW_H/oAR.length,opacity:active?1:0.15}} onClick={e=>e.stopPropagation()}>
              <span className="planner__route-name">{route.id}</span>
              <div className="planner__route-right">
                {rc.map(c=><span key={`${c.track}-${c.depRoute}`} className={`planner__conn-label${isStaff?' planner__conn-label--rm':''}`} style={{background:trackCol(c.track)}} onClick={e=>{if(!isStaff)return;e.stopPropagation();removeConnection(c);}}>{connLabel(c)}</span>)}
                <QuantityLabel used={route.value} cap={route.cap} size="md"/>
              </div>
            </div>
          );})}
        </div>

        {/* Arrival */}
        <div className="col planner__col">
          <div className="planner__header planner__header--right">Arrival</div>
          {oArrs.map(arr => { const ac=selectedDep?selConnsAll.filter(c=>c.arr===arr.id):[]; const active=!selectedDep||filteredConns.some(c=>c.dep===selectedDep&&c.arr===arr.id); const aData=arrs.find(a=>a.id===arr.id); return (
            <div key={arr.id} className="planner__cell planner__cell--right" style={{height:maxRows*ROW_H/oArrs.length,opacity:active?1:0.15}} onClick={e=>e.stopPropagation()}>
              <QuantityLabel used={aData?.value??0} cap={aData?.cap} size="lg"/>
              {selectedDep&&ac.map(c=><span key={`${c.track}-${c.depRoute}`} className="planner__conn-label" style={{background:trackCol(c.track)}}>{connLabel(c)}</span>)}
              <div className="planner__cell-arr-info"><span className="planner__cell-name">{arr.id}</span></div>
            </div>
          );})}
        </div>

      </div>
    </div>
  );
}