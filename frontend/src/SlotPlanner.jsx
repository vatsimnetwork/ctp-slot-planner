import { useEffect, useRef, useState, useLayoutEffect, useCallback } from "react";
import * as d3 from "d3";
import "./SlotPlanner.css";

// ─── Layout constants ─────────────────────────────────────────────────────────
const ROW_H       = 52;
const HEADER_H    = 47 + 20;
const TRACK_COLS  = ['#2783C5', '#29B473', '#2A3B90', '#E8543E', '#9B59B6', '#F39C12'];
const BRACE_W     = 18;
const TIME_W      = 108;
const BRACE_GAP   = 8;
const BRACE_COL_W = TIME_W + BRACE_GAP + BRACE_W;

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
async function apiFetch(url, options = {}) {
  const res = await fetch(url, { ...options, credentials: 'include' });
  if (res.status === 401) { window.location.href = '/login/'; throw new Error('Unauthorized'); }
  return res;
}
const API = {
  loadSetup: () => apiFetch('/setup/'),
  loadSlots: () => apiFetch('/slotgroups/'),
  save:      (p) => apiFetch('/slotgroups/save/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }),
  submit:    (p) => apiFetch('/slotgroups/submit/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }),
};

// ─── ID parser (splits on first 4 hyphens only) ───────────────────────────────
function splitSlotId(id) {
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
  const [setupData, setSetupData] = useState({ deps:[], depRoutesByDep:{}, tracks:[], arrRoutes:[], arrs:[] });
  const [simVersion,       setSimVersion]       = useState(null);
  const [plannerRevisions, setPlannerRevisions] = useState(0);
  const [selectedDep, setSelectedDep] = useState(null);
  const [startTime,   setStartTime]   = useState('1800z');
  const [depTimes,    setDepTimes]    = useState({});
  const [newRoute,    setNewRoute]    = useState({ dep:'', depRoute:'', track:'', arrRoute:'', arr:'', value:0 });
  const [searchTerm,  setSearchTerm]  = useState('');
  const [simParams,   setSimParams]   = useState({ ...DEFAULT_SIM_PARAMS });
  const [showModal,   setShowModal]   = useState(false);
  const [pendingMode, setPendingMode] = useState(null);
  const [toasts,      setToasts]      = useState([]);
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
      setSetupData({ deps: setup.deps||[], depRoutesByDep: setup.depRoutesByDep||{}, tracks: setup.tracks||[], arrRoutes: setup.arrRoutes||[], arrs: setup.arrs||[] });
      const slotGroups = Array.isArray(raw) ? raw : (raw.slotGroups ?? []);
      const caps       = (Array.isArray(raw) ? {} : raw.caps) ?? {};
      setData(parseSlotGroups(slotGroups, caps));
      if (!Array.isArray(raw)) {
        if (raw.routesRevision   != null) setSimVersion(raw.routesRevision);
        if (raw.plannerRevisions != null) setPlannerRevisions(raw.plannerRevisions);
        if (raw.startTime)                setStartTime(raw.startTime);
        if (raw.depTimes)                 setDepTimes(raw.depTimes);
      }
    })
    .catch(err => addToast(String(err), 'error'))
    .finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (selectedDep) setNewRoute(p => ({...p, dep:selectedDep, depRoute:''})); }, [selectedDep]);

  const { deps, depRoutes, tracks, arrRoutes, arrs, connections } = data;

  // ── Auto-save (debounced 800 ms) ─────────────────────────────────────────
  const latestData      = useRef(data);
  const latestStartTime = useRef(startTime);
  const latestDepTimes  = useRef(depTimes);
  latestData.current      = data;
  latestStartTime.current = startTime;
  latestDepTimes.current  = depTimes;

  const buildPayload = useCallback((extras = {}) => ({
    startTime:  latestStartTime.current,
    depTimes:   { ...latestDepTimes.current },
    caps:       snapshotCaps(latestData.current),
    slotGroups: latestData.current.connections.map(c => ({
      id:    `${c.dep}-${c.depRoute}-${c.track}-${c.arrRoute}-${c.arr}`,
      value: c.value,
    })),
    ...extras,
  }), []);

  useEffect(() => {
    if (loading) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      setSaving(true);
      API.save(buildPayload())
        .then(r => r.ok ? null : Promise.reject(`Auto-save failed (${r.status})`))
        .catch(err => addToast(String(err), 'error'))
        .finally(() => setSaving(false));
    }, 800);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [data, startTime, depTimes, loading]);

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

  // ── Dropdowns ─────────────────────────────────────────────────────────────
    
  const ddDeps = [...new Set([
    ...setupData.deps,
    ...deps.map(d => d.id),
  ])].sort();

  const ddDepRoutes = [...new Set([
    ...Object.values(setupData.depRoutesByDep).flat(),
    ...depRoutes.map(r => r.id),
    ...connections.map(c => c.depRoute),
  ])].sort();

  const ddTracks = [...new Set([
    ...setupData.tracks,
    ...tracks.map(t => t.id),
    ...connections.map(c => c.track),
  ])].sort();

  const ddArrRoutes = [...new Set([
    ...setupData.arrRoutes,
    ...arrRoutes.map(r => r.id),
    ...connections.map(c => c.arrRoute),
  ])].sort();

  const ddArrs = [...new Set([
    ...setupData.arrs,
    ...arrs.map(a => a.id),
    ...connections.map(c => c.arr),
  ])].sort();

  const getDepTime = (id) => depTimes[id] ?? startTime;

  const selConnsAll = selectedDep ? connections.filter(c=>c.dep===selectedDep) : [];
  const selConns    = selectedDep ? filteredConns.filter(c=>c.dep===selectedDep) : [];
  const connLabel   = (conn) => { const i=selConnsAll.findIndex(c=>c.depRoute===conn.depRoute&&c.track===conn.track&&c.arrRoute===conn.arrRoute&&c.arr===conn.arr); return i>=0?String.fromCharCode(65+i):''; };
  const trackCol    = (id)   => tracks.find(t=>t.id===id)?.col||'#2A3B90';

  const setCap = (listKey, id, val) => setData(prev => ({ ...prev, [listKey]: prev[listKey].map(item => item.id === id ? { ...item, cap: val === '' ? null : Number(val) } : item) }));

  const recomputeAggregates = (prev, newConns) => {
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

  const addConnection = () => {
    const { dep, depRoute, track, arrRoute, arr, value } = newRoute;
    if (!dep||!depRoute||!track||!arrRoute||!arr) { addToast('Fill in all five fields','warning'); return; }
    if (data.connections.some(c=>c.dep===dep&&c.depRoute===depRoute&&c.track===track&&c.arrRoute===arrRoute&&c.arr===arr)) { addToast('Connection already exists','warning'); return; }
    setData(prev => {
      const newConns = [...prev.connections,{dep,depRoute,track,arrRoute,arr,value}];
      const ensureDep = prev.deps.some(d=>d.id===dep)?prev.deps:[...prev.deps,{id:dep,value:0,cap:null}];
      const ensureDR  = prev.depRoutes.some(r=>r.id===depRoute)?prev.depRoutes:[...prev.depRoutes,{id:depRoute,value:0,cap:null,selected:true}];
      const ensureTr  = prev.tracks.some(t=>t.id===track)?prev.tracks:[...prev.tracks,{id:track,col:TRACK_COLS[prev.tracks.length%TRACK_COLS.length],slots:0,cap:null}];
      const ensureAR  = prev.arrRoutes.some(r=>r.id===arrRoute)?prev.arrRoutes:[...prev.arrRoutes,{id:arrRoute,value:0,cap:null,selected:true}];
      const ensureArr = prev.arrs.some(a=>a.id===arr)?prev.arrs:[...prev.arrs,{id:arr,value:0,cap:null}];
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
  const selDRIds  = [...new Set(selConnsAll.map(c=>c.depRoute))];
  const selTrIds  = [...new Set(selConnsAll.map(c=>c.track))];
  const selARIds  = [...new Set(selConnsAll.map(c=>c.arrRoute))];
  const selAIds   = [...new Set(selConnsAll.map(c=>c.arr))];

  return (
    <div className="planner" data-theme={theme} onClick={()=>setSelectedDep(null)}>
      {loading && <div className="planner__loading">Loading…</div>}
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
            <span className="planner__meta-label">Start Time</span>
            <TimeSpinner value={startTime} onChange={t=>setStartTime(t)}/>
          </div>
          <span className="planner__meta-label">Rev <strong className="planner__rev-value">{revStr}</strong></span>
          {saving && <span className="planner__saving-indicator">Saving…</span>}
          <button disabled className="planner__btn" onClick={()=>{setPendingMode('calculate');setShowModal(true);}}>Calculate Slots</button>
          <button disabled className="planner__btn planner__btn--sim" onClick={()=>{setPendingMode('simulate');setShowModal(true);}}>Simulate Slots</button>
          <a href="/logout/" className="planner__btn planner__btn--logout">Logout</a>
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
          <select value={newRoute.dep} onChange={e=>setNewRoute(r=>({...r,dep:e.target.value,depRoute:''}))}>
            <option value="">Departure</option>{ddDeps.map(d=><option key={d} value={d}>{d}</option>)}
          </select>
          <select value={newRoute.depRoute} onChange={e=>setNewRoute(r=>({...r,depRoute:e.target.value}))}>
            <option value="">Dep Route</option>{ddDepRoutes.map(r=><option key={r} value={r}>{r}</option>)}
          </select>
          <select value={newRoute.track} onChange={e=>setNewRoute(r=>({...r,track:e.target.value}))}>
            <option value="">Track</option>{ddTracks.map(t=><option key={t} value={t}>{t}</option>)}
          </select>
          <select value={newRoute.arrRoute} onChange={e=>setNewRoute(r=>({...r,arrRoute:e.target.value}))}>
            <option value="">Arr Route</option>{ddArrRoutes.map(r=><option key={r} value={r}>{r}</option>)}
          </select>
          <select value={newRoute.arr} onChange={e=>setNewRoute(r=>({...r,arr:e.target.value}))}>
            <option value="">Arrival</option>{ddArrs.map(a=><option key={a} value={a}>{a}</option>)}
          </select>
          <input className="planner__ctrl-num" type="number" min={0} value={newRoute.value} onChange={e=>setNewRoute(r=>({...r,value:parseInt(e.target.value)||0}))}/>
          <button className="planner__btn" onClick={addConnection}>Add</button>
        </div>

        {selectedDep && selConns.length > 0 && (
          <div className="planner__brace-section">
            <div className="planner__brace-col" style={{width:BRACE_COL_W,minHeight:braceHeight}}>
              <TimeSpinner value={getDepTime(selectedDep)} onChange={t=>setDepTimes(p=>({...p,[selectedDep]:t}))} className="planner__brace-time" style={{top:Math.max(0,braceHeight/2-28)}}/>
              <div className="planner__brace-svg-wrap"><CurlyBrace height={braceHeight}/></div>
            </div>
            <div className="planner__control-edit" ref={editRef}>
              {selConns.map(c => (
                <div key={`${c.depRoute}-${c.track}-${c.arrRoute}-${c.arr}`} className="planner__control-row">
                  <span className="planner__conn-label" style={{background:trackCol(c.track)}}>{connLabel(c)}</span>
                  <select value={c.depRoute} onChange={e=>editConn(c,'depRoute',e.target.value)}>
                    {ddDepRoutes.map(r => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>                  <select value={c.track}    onChange={e=>editConn(c,'track',e.target.value)}>{ddTracks.map(t=><option key={t} value={t}>{t}</option>)}</select>
                  <select value={c.arrRoute} onChange={e=>editConn(c,'arrRoute',e.target.value)}>{ddArrRoutes.map(r=><option key={r} value={r}>{r}</option>)}</select>
                  <select value={c.arr}      onChange={e=>editConn(c,'arr',e.target.value)}>{ddArrs.map(a=><option key={a} value={a}>{a}</option>)}</select>
                  <input className="planner__ctrl-num" type="number" value={c.value} onChange={e=>editConn(c,'value',parseInt(e.target.value)||0)}/>
                  <button className="planner__slot-btn planner__slot-btn--remove" onClick={()=>removeConnection(c)}>✕</button>
                </div>
              ))}
              <div className="planner__cap-editor">
                <span className="planner__cap-editor-title">Capacity caps</span>
                <div className="planner__cap-grid">
                  <span className="planner__cap-key">Dep {selectedDep}</span>
                  <input className="planner__cap-input" type="number" min={0} placeholder="—" value={deps.find(d=>d.id===selectedDep)?.cap??''} onChange={e=>setCap('deps',selectedDep,e.target.value)}/>
                  {selDRIds.map(id=><><span key={`l-${id}`} className="planner__cap-key">{id}</span><input key={`i-${id}`} className="planner__cap-input" type="number" min={0} placeholder="—" value={depRoutes.find(r=>r.id===id)?.cap??''} onChange={e=>setCap('depRoutes',id,e.target.value)}/></>)}
                  {selTrIds.map(id=><><span key={`l-${id}`} className="planner__cap-key">Track {id}</span><input key={`i-${id}`} className="planner__cap-input" type="number" min={0} placeholder="—" value={tracks.find(t=>t.id===id)?.cap??''} onChange={e=>setCap('tracks',id,e.target.value)}/></>)}
                  {selARIds.map(id=><><span key={`l-${id}`} className="planner__cap-key">{id}</span><input key={`i-${id}`} className="planner__cap-input" type="number" min={0} placeholder="—" value={arrRoutes.find(r=>r.id===id)?.cap??''} onChange={e=>setCap('arrRoutes',id,e.target.value)}/></>)}
                  {selAIds.map(id=><><span key={`l-${id}`} className="planner__cap-key">Arr {id}</span><input key={`i-${id}`} className="planner__cap-input" type="number" min={0} placeholder="—" value={arrs.find(a=>a.id===id)?.cap??''} onChange={e=>setCap('arrs',id,e.target.value)}/></>)}
                </div>
              </div>
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
              <div className="planner__cell-dep-info"><span className="planner__cell-name">{dep.id}</span><span className="planner__dep-time-label">{getDepTime(dep.id)}</span></div>
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
                {rc.map(c=><span key={`${c.track}-${c.arrRoute}`} className="planner__conn-label planner__conn-label--rm" style={{background:trackCol(c.track)}} onClick={e=>{e.stopPropagation();removeConnection(c);}}>{connLabel(c)}</span>)}
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
                {rc.map(c=><span key={`${c.track}-${c.depRoute}`} className="planner__conn-label planner__conn-label--rm" style={{background:trackCol(c.track)}} onClick={e=>{e.stopPropagation();removeConnection(c);}}>{connLabel(c)}</span>)}
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