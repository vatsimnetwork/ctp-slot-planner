import React, { useEffect, useRef, useState, useLayoutEffect, useCallback, useMemo } from "react";
import * as d3 from "d3";
import "./SlotPlanner.css";

import { ROW_H, HEADER_H, TRACK_COLS, BRACE_W, BRACE_COL_W, DEFAULT_SIM_PARAMS } from "./constants.js";
import { apiFetch, API } from "./api.js";
import { parseSlotGroups, barycentricOrder } from "./utils.js";
import QuantityLabel    from "./components/QuantityLabel.jsx";
import TimeSpinner      from "./components/TimeSpinner.jsx";
import CurlyBrace       from "./components/CurlyBrace.jsx";
import SimParamsModal   from "./components/SimParamsModal.jsx";
import ThroughputLimitsPage from "./pages/ThroughputLimitsPage.jsx";
import CityPairTotalsPage   from "./pages/CityPairTotalsPage.jsx";

// ─── Main ────────────────────────────────────────────────────────────────────
export default function SlotPlanner() {
  const [theme, setTheme] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const [data, setData]   = useState({ deps:[], depRoutes:[], tracks:[], arrRoutes:[], arrs:[], connections:[] });
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [simStatus, setSimStatus] = useState(null); // null | 'running' | 'sim_responded' | 'saved'
  const [activeTab, setActiveTab] = useState('planner');
  const [setupData, setSetupData] = useState({ deps:[], depRoutesByDep:{}, tracks:[], arrRoutes:[], arrs:[], tracksByDepRoute:{}, arrRoutesByTrack:{}, arrByArrRoute:{}, dbIds:{airports:{},routeSegments:{}}, departureHours:3, defaultCaps:{deps:{},depRoutes:{},tracks:{},arrRoutes:{},arrs:{}}, tagMap:{}, sectorMap:{}, tagLimits:[], sectorLimits:[], tagToRoutes:{}, sectorToRoutes:{} });
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
  const [limitViolations, setLimitViolations] = useState([]);
  const [showLimitModal,  setShowLimitModal]  = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const svgRef  = useRef(null);
  const gridRef = useRef(null);
  const editRef = useRef(null);
  const [colPositions, setColPositions] = useState(null);
  const [braceHeight,  setBraceHeight]  = useState(0);
  const isSubmitting = useRef(false);
  const eventIdRef = useRef(null);
  const simPollRef = useRef(null);

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
        tagMap:           setup.tagMap||{},
        sectorMap:        setup.sectorMap||{},
        tagLimits:        setup.tagLimits||[],
        sectorLimits:     setup.sectorLimits||[],
        tagToRoutes:      setup.tagToRoutes||{},
        sectorToRoutes:   setup.sectorToRoutes||{},
      });
      setIsStaff(setup.isStaff ?? false);
      if (setup.syncTime) setSyncTime(setup.syncTime);
      if (setup.eventId)  eventIdRef.current = setup.eventId;
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

  // ── Save ──────────────────────────────────────────────────────────────────
  const latestData      = useRef(data);
  latestData.current = data;

  const buildPayload = useCallback((extras = {}) => ({
    slotGroups: latestData.current.connections.map(c => ({
      id:    `${c.dep}|${c.depRoute}|${c.track}|${c.arrRoute}|${c.arr}`,
      value: c.value,
    })),
    ...extras,
  }), []);

  const handleSave = () => {
    setSaving(true);
    API.save(buildPayload())
      .then(r => r.ok ? null : Promise.reject(`Save failed (${r.status})`))
      .then(() => setIsDirty(false))
      .catch(err => addToast(String(err), 'error'))
      .finally(() => setSaving(false));
  };

  // ── Tag / sector limit warnings ───────────────────────────────────────────
  const warnTimer = useRef(null);
  useEffect(() => {
    if (warnTimer.current) clearTimeout(warnTimer.current);
    warnTimer.current = setTimeout(() => {
      const { tagMap, sectorMap, tagLimits, sectorLimits, departureHours } = setupData;
      const tagUsage = {};
      const sectorUsage = {};
      connections.forEach(c => {
        (tagMap[c.track] || []).forEach(tag => { tagUsage[tag] = (tagUsage[tag] || 0) + c.value; });
        (sectorMap[c.track] || []).forEach(s => { sectorUsage[s.identifier] = (sectorUsage[s.identifier] || 0) + c.value; });
      });
      const violations = [];
      tagLimits.forEach(tl => {
        if (!tl.maximumAircraftPerHour || tl.maximumAircraftPerHour >= 65535) return;
        const limit = Math.floor(tl.maximumAircraftPerHour * departureHours);
        const used = tagUsage[tl.tag] || 0;
        if (used > limit) violations.push({ kind: 'Tag', name: tl.tag, used, limit });
      });
      sectorLimits.forEach(s => {
        const acph = s.maximumAircraftPerHour ?? s.maximumSlots;
        if (!acph || acph >= 65535) return;
        const limit = Math.floor(acph * departureHours);
        const used = sectorUsage[s.identifier] || 0;
        if (used > limit) violations.push({ kind: 'Sector', name: s.identifier, used, limit });
      });
      // Check caps on airports, route segments and tracks stored in data
      deps.forEach(d      => { if (d.cap != null && d.value  > d.cap) violations.push({ kind: 'Dep Airport',  name: d.id, used: d.value,  limit: d.cap }); });
      arrs.forEach(a      => { if (a.cap != null && a.value  > a.cap) violations.push({ kind: 'Arr Airport',  name: a.id, used: a.value,  limit: a.cap }); });
      depRoutes.forEach(r => { if (r.cap != null && r.value  > r.cap) violations.push({ kind: 'Dep Route',    name: r.id, used: r.value,  limit: r.cap }); });
      arrRoutes.forEach(r => { if (r.cap != null && r.value  > r.cap) violations.push({ kind: 'Arr Route',    name: r.id, used: r.value,  limit: r.cap }); });
      tracks.forEach(t    => { if (t.cap != null && t.slots  > t.cap) violations.push({ kind: 'Track',        name: t.id, used: t.slots,  limit: t.cap }); });
      const prev = limitViolations;
      setLimitViolations(violations);
    }, 600);
    return () => { if (warnTimer.current) clearTimeout(warnTimer.current); };
  }, [data]);

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

  const depOrd = new Map(vDeps.map((d,i)=>[d.id,i]));
  const oDR    = barycentricOrder(vDepRoutes, filteredConns,'depRoute','dep',depOrd);
  const drOrd  = new Map(oDR.map((d,i)=>[d.id,i]));
  const oTr    = barycentricOrder(vTracks,    filteredConns,'track','depRoute',drOrd);
  const trOrd  = new Map(oTr.map((d,i)=>[d.id,i]));
  const oAR    = barycentricOrder(vArrRoutes, filteredConns,'arrRoute','track',trOrd);
  const arOrd  = new Map(oAR.map((d,i)=>[d.id,i]));
  const oArrs  = barycentricOrder(vArrs,      filteredConns,'arr','arrRoute',arOrd);

  const maxRows = Math.max(vDeps.length,oDR.length,oTr.length,oAR.length,oArrs.length,1);
  const totalH  = HEADER_H + maxRows*ROW_H;
  const itemY   = (i,n) => { const rh=maxRows*ROW_H/n; return HEADER_H+rh*i+rh/2; };

  // ── Dropdowns (cascading, topology-aware) ────────────────────────────────
  const ddDeps = [...new Set([...setupData.deps, ...deps.map(d => d.id)])].sort();
  const ddDepRoutes = (dep) => [...new Set([...(setupData.depRoutesByDep[dep] || []), ...connections.filter(c => c.dep === dep).map(c => c.depRoute)])].sort();
  const ddTracks    = (depRoute) => [...new Set([...(setupData.tracksByDepRoute[depRoute] || []), ...connections.filter(c => c.depRoute === depRoute).map(c => c.track)])].sort();
  const ddArrRoutes = (track) => [...new Set([...(setupData.arrRoutesByTrack[track] || []), ...connections.filter(c => c.track === track).map(c => c.arrRoute)])].sort();
  const autoArr     = (arrRoute) => setupData.arrByArrRoute[arrRoute] || null;

  const selConnsAll = selectedDep ? connections.filter(c=>c.dep===selectedDep) : [];
  const selConns    = selectedDep ? filteredConns.filter(c=>c.dep===selectedDep) : [];
  const connLabel   = (conn) => { const i=selConnsAll.findIndex(c=>c.depRoute===conn.depRoute&&c.track===conn.track&&c.arrRoute===conn.arrRoute&&c.arr===conn.arr); return i>=0?String.fromCharCode(65+i):''; };
  const trackCol    = (id)   => tracks.find(t=>t.id===id)?.col||'#2A3B90';

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
    setIsDirty(true);
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
    setIsDirty(true);
    setData(prev => {
      const newConns = prev.connections.map(c => c === conn ? { ...c, [field]: val } : c);
      return recomputeAggregates(prev, newConns);
    });
  };

  const setCap = useCallback((listKey, id, rawVal) => {
    const val = rawVal === '' || rawVal == null ? null : parseInt(rawVal, 10);
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
    hasEdits.current = true;
    setIsDirty(true);
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
  const startSimPoll = () => {
    const eid = eventIdRef.current;
    if (!eid) return;
    let lastStatus = null;
    simPollRef.current = setInterval(() => {
      fetch(`/api/events/${eid}/simulate-status`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!d) return;
          const s = d.status;
          if (s === lastStatus) return;
          lastStatus = s;
          setSimStatus(s);
          if (s === 'sim_responded') addToast('Simulator responded — saving slot times…', 'info');
          if (s === 'saved') addToast('Slot times saved — draft revision created', 'info');
        })
        .catch(() => {});
    }, 1200);
  };
  const stopSimPoll = () => {
    if (simPollRef.current) { clearInterval(simPollRef.current); simPollRef.current = null; }
    setSimStatus(null);
  };

  const confirmSubmit = () => {
    setShowModal(false);
    const mode = pendingMode;
    const nextRev = hasEdits.current ? plannerRevisions + 1 : plannerRevisions;
    isSubmitting.current = true;
    setSaving(false);
    if (mode === 'simulate') { setSimStatus('running'); startSimPoll(); }
    API.submit(buildPayload({mode, plannerRevisions: nextRev, simulatorParams: simParams}))
      .then(r=>r.ok?r.json():Promise.reject(new Error(`${mode} failed (${r.status})`)))
      .then(res=>{
        setPlannerRevisions(nextRev);
        hasEdits.current = false;
        setIsDirty(false);
        if (res?.slotGroups) setData(parseSlotGroups(res.slotGroups,res.caps??{}));
        if (res?.warning) addToast(res.warning,'warning');
        if (res?.commentary) addToast(res.commentary,'info');
        addToast(`${mode==='calculate'?'Calculation':'Simulation'} complete — rev ${simVersion}.${nextRev}`,'success');
      })
      .catch(err=>addToast(err.message,'error'))
      .finally(() => { isSubmitting.current = false; if (mode === 'simulate') stopSimPoll(); });
  };

  // ── Layout effects ────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    if (!gridRef.current) return;
    const update = () => { const cr=gridRef.current.getBoundingClientRect(); const rects=Array.from(gridRef.current.querySelectorAll('.col')).map(c=>{const r=c.getBoundingClientRect();return{left:r.left-cr.left,right:r.right-cr.left};}); setColPositions({rects,totalWidth:cr.width}); };
    update(); window.addEventListener('resize',update); return ()=>window.removeEventListener('resize',update);
  }, [data, searchTerm, activeTab]);
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
  const liveTagUsage = {};
  const liveSectorUsage = {};
  connections.forEach(c => {
    (setupData.tagMap[c.track] || []).forEach(tag => { liveTagUsage[tag] = (liveTagUsage[tag] || 0) + c.value; });
    (setupData.sectorMap[c.track] || []).forEach(s => { liveSectorUsage[s.identifier] = (liveSectorUsage[s.identifier] || 0) + c.value; });
  });
  const revStr = simVersion!==null?`${simVersion}.${plannerRevisions}`:'—';

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

      {showLimitModal && (
        <div className="modal-overlay" onClick={()=>setShowLimitModal(false)}>
          <div className="modal-box modal-box--limit-warning" onClick={e=>e.stopPropagation()}>
            <div className="modal-header modal-header--danger">
              <span className="modal-title">⚠ Throughput Limits Exceeded</span>
              <button className="modal-close" onClick={()=>setShowLimitModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p className="limit-warning__intro">The following limits are exceeded by the current route plan. The simulator will be unable to allocate all requested slots.</p>
              <table className="limit-warning__table">
                <thead><tr><th>Type</th><th>Name</th><th>Used</th><th>Limit</th><th>Over by</th></tr></thead>
                <tbody>
                  {limitViolations.map((v,i) => (
                    <tr key={i} className="limit-warning__row">
                      <td>{v.kind}</td>
                      <td><strong>{v.name}</strong></td>
                      <td className="limit-warning__used">{v.used}</td>
                      <td>{v.limit}</td>
                      <td className="limit-warning__over">+{v.used - v.limit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="modal-footer">
              <button className="planner__btn planner__btn--destructive" onClick={()=>setShowLimitModal(false)}>I understand — dismiss</button>
            </div>
          </div>
        </div>
      )}

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
        <div className="planner__tabs">
          <button className={`planner__tab${activeTab === 'planner' ? ' planner__tab--active' : ''}`} onClick={() => setActiveTab('planner')}>Slot Planner</button>
          <button className={`planner__tab${activeTab === 'throughputLimits' ? ' planner__tab--active' : ''}`} onClick={() => setActiveTab('throughputLimits')}>Throughput Limits</button>
          <button className={`planner__tab${activeTab === 'cityPairTotals' ? ' planner__tab--active' : ''}`} onClick={() => setActiveTab('cityPairTotals')}>City Pair Totals</button>
        </div>
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
          {simStatus === 'running'       && <span className="planner__sim-status planner__sim-status--running">Running simulator…</span>}
          {simStatus === 'sim_responded' && <span className="planner__sim-status planner__sim-status--saving">Saving slot times…</span>}
          {simStatus === 'saved'         && <span className="planner__sim-status planner__sim-status--done">Finalizing…</span>}
          {!isStaff && <span className="planner__readonly-badge">Read-only</span>}
          {limitViolations.length > 0 && (
            <button className="planner__limit-alert" onClick={()=>setShowLimitModal(true)}>
              ⚠ {limitViolations.length} limit{limitViolations.length > 1 ? 's' : ''} exceeded
            </button>
          )}
          {isStaff && (
            <button
              className={`planner__btn${isDirty ? ' planner__btn--dirty' : ''}`}
              disabled={!isDirty || saving}
              onClick={handleSave}
            >
              {saving ? 'Saving…' : isDirty ? 'Save Draft ●' : 'Saved'}
            </button>
          )}
          <button disabled={!isStaff} className="planner__btn" onClick={()=>{setPendingMode('calculate');setShowConfirm(true);}}>Calculate Slots</button>
          <button disabled={!isStaff} className="planner__btn planner__btn--sim" onClick={()=>{setPendingMode('simulate');setShowModal(true);}}>Simulate Slots</button>
          <a href={`${import.meta.env.BASE_URL}logout/`} className="planner__btn planner__btn--logout">Logout</a>
          <button className="planner__btn planner__btn--theme" onClick={()=>setTheme(t=>t==='light'?'dark':'light')}>
            <svg className="planner__theme-icon planner__theme-icon--sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07l1.77-1.77M17.3 6.7l1.77-1.77"/></svg>
            <svg className="planner__theme-icon planner__theme-icon--moon" viewBox="0 0 24 24"><path d="M20.35 14.14A9 9 0 1 1 9.86 3.65 7 7 0 0 0 20.35 14.14z"/></svg>
          </button>
        </div>
      </div>

      {activeTab === 'throughputLimits' && <ThroughputLimitsPage isStaff={isStaff} addToast={addToast} tagUsage={liveTagUsage} sectorUsage={liveSectorUsage} departureHours={setupData.departureHours} tagToRoutes={setupData.tagToRoutes} sectorToRoutes={setupData.sectorToRoutes}/>}

      {activeTab === 'cityPairTotals' && <CityPairTotalsPage data={data} setupData={setupData}/>}

      {/* Control bar */}
      {activeTab === 'planner' && <div className="planner__control-bar" onClick={e=>e.stopPropagation()}>
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
                <div key={`${c.depRoute}-${c.track}-${c.arrRoute}-${c.arr}`} className="planner__control-row">
                  <span className="planner__conn-label" style={{background:trackCol(c.track)}}>{connLabel(c)}</span>
                  <select disabled={!isStaff} value={c.depRoute} onChange={e=>editConn(c,'depRoute',e.target.value)}>
                    {ddDepRoutes(selectedDep).map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <select disabled={!isStaff} value={c.track} onChange={e=>editConn(c,'track',e.target.value)}>{ddTracks(c.depRoute).map(t=><option key={t} value={t}>{t}</option>)}</select>
                  <select disabled={!isStaff} value={c.arrRoute} onChange={e=>{const ar=e.target.value;const a=autoArr(ar);hasEdits.current=true;setIsDirty(true);setData(prev=>{const newConns=prev.connections.map(x=>x===c?{...x,arrRoute:ar,...(a?{arr:a}:{})}:x);return recomputeAggregates(prev,newConns);});}}>{ddArrRoutes(c.track).map(r=><option key={r} value={r}>{r}</option>)}</select>
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
      </div>}

      {/* Sankey grid */}
      {activeTab === 'planner' && <div className="planner__grid" ref={gridRef}>
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

      </div>}
    </div>
  );
}
