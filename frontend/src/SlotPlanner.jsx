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
  const [setupData, setSetupData] = useState({ deps:[], depRoutesByDep:{}, tracks:[], arrRoutes:[], arrs:[], tracksByDepRoute:{}, arrRoutesByTrack:{}, arrByArrRoute:{}, dbIds:{airports:{},routeSegments:{}}, departureHours:3, departureTimeWindowHours:3, defaultCaps:{deps:{},depRoutes:{},tracks:{},arrRoutes:{},arrs:{}}, tagMap:{}, sectorMap:{}, tagLimits:[], sectorLimits:[], tagToRoutes:{}, sectorToRoutes:{}, disabledRoutes:[], routeList:[] });
  const [simVersion,       setSimVersion]       = useState(null);
  const [plannerRevisions, setPlannerRevisions] = useState(0);
  const [selectedEntity, setSelectedEntity] = useState(null);
  const [depTimes,    setDepTimes]    = useState({});
  const [arrTimes,    setArrTimes]    = useState({});
  const [newRoute,    setNewRoute]    = useState({ dep:'', depRoute:'', track:'', arrRoute:'', arr:'', value:0 });
  const [searchTerm,    setSearchTerm]    = useState('');
  const [gridVisibility, setGridVisibility] = useState('loaded');
  const [simParams,   setSimParams]   = useState({ ...DEFAULT_SIM_PARAMS });
  const [showModal,   setShowModal]   = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pendingMode, setPendingMode] = useState(null);
  const [toasts,      setToasts]      = useState([]);
  const [isStaff,     setIsStaff]     = useState(false);
  const [isRouteStaff, setIsRouteStaff] = useState(false);
  const [limitViolations, setLimitViolations] = useState([]);
  const [showLimitModal,  setShowLimitModal]  = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [airportWindowShifts, setAirportWindowShifts] = useState(new Map()); // Map of "DEP|ARR" -> { startShift, endShift }
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
  const loadAll = useCallback(() => {
    setLoading(true);
    Promise.all([
      API.loadSetup().then(r => r.ok ? r.json() : Promise.reject(`Setup failed (${r.status})`)),
      API.loadSlots().then(r  => r.ok ? r.json() : Promise.reject(`Slots failed (${r.status})`)),
      API.loadWindowShifts().then(r => r.ok ? r.json() : []),
    ])
    .then(([setup, raw, rawWindowShifts]) => {
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
        disabledRoutes:   setup.disabledRoutes||[],
        routeList:        setup.routeList||[],
        departureTimeWindowHours: setup.departureTimeWindowHours ?? setup.departureHours ?? 3,
      });
      setIsStaff(setup.isStaff ?? false);
      setIsRouteStaff(setup.isRouteStaff ?? false);
      if (setup.eventId)  eventIdRef.current = setup.eventId;
      setSimParams(p => ({ ...p, ...(setup.calcParams || {}) }));
      if (setup.depTimes) setDepTimes(setup.depTimes);
      if (setup.arrTimes) setArrTimes(setup.arrTimes);
      const slotGroups = Array.isArray(raw) ? raw : (raw.slotGroups ?? []);
      setData(parseSlotGroups(slotGroups, setup.defaultCaps ?? {}));
      if (!Array.isArray(raw)) {
        if (raw.routesRevision   != null) setSimVersion(raw.routesRevision);
        if (raw.plannerRevisions != null) setPlannerRevisions(raw.plannerRevisions);
      }
      // Load window shifts: convert [{departureAirportId, arrivalAirportId, startShiftHours, endShiftHours, ...}] to Map of "DEP|ARR" -> { startShift, endShift }
      const newShifts = new Map();
      if (Array.isArray(rawWindowShifts) && rawWindowShifts.length > 0) {
        const dbIds = setup.dbIds || { airports: {} };
        const identById = Object.fromEntries(
          Object.entries(dbIds.airports).map(([ident, id]) => [id, ident])
        );
        for (const s of rawWindowShifts) {
          const depId = s.departureAirportId ?? s.departureAirport?.id;
          const arrId = s.arrivalAirportId ?? s.arrivalAirport?.id;
          const di = identById[depId], ai = identById[arrId];
          if (di && ai) {
            newShifts.set(`${di}|${ai}`, { startShift: s.startShiftHours ?? 0, endShift: s.endShiftHours ?? 0 });
          }
        }
      }
      setAirportWindowShifts(newShifts);
    })
    .catch(err => addToast(String(err), 'error'))
    .finally(() => setLoading(false));
  }, [addToast]);

  useEffect(() => { loadAll(); }, []);

  useEffect(() => {
    const onKeyDown = e => { if (e.key === 'Escape') { setSelectedEntity(null); setShowLimitModal(false); } };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const { deps, depRoutes, tracks, arrRoutes, arrs, connections } = data;

  // ── Save ──────────────────────────────────────────────────────────────────
  const latestData      = useRef(data);
  latestData.current = data;

  const buildPayload = useCallback((extras = {}) => {
    return {
      slotGroups: latestData.current.connections.map(c => ({
        id:    `${c.dep}|${c.depRoute}|${c.track}|${c.arrRoute}|${c.arr}`,
        value: c.value,
        ...(c.depAirportId != null ? {
          depAirportId: c.depAirportId,
          depRouteId:   c.depRouteId,
          trackId:      c.trackId,
          arrRouteId:   c.arrRouteId,
          arrAirportId: c.arrAirportId,
        } : {}),
      })),
      ...extras,
    };
  }, []);

  const handleSave = () => {
    setSaving(true);
    API.save(buildPayload())
      .then(r => r.ok ? null : Promise.reject(`Save failed (${r.status})`))
      .then(() => setIsDirty(false))
      .catch(err => addToast(String(err), 'error'))
      .finally(() => setSaving(false));
  };

  const saveShiftsTimer = useRef(null);
  const updatePairShift = useCallback((key, shift) => {
    setAirportWindowShifts(prev => {
      const next = new Map(prev);
      if (!shift || (shift.startShift === 0 && shift.endShift === 0)) {
        next.delete(key);
      } else {
        next.set(key, shift);
      }
      // Debounced save
      if (saveShiftsTimer.current) clearTimeout(saveShiftsTimer.current);
      saveShiftsTimer.current = setTimeout(() => {
        const dbIds = setupData.dbIds || { airports: {} };
        const payload = [...next]
          .map(([k, s]) => {
            const [dep, arr] = k.split('|');
            return {
              departureAirportId: dbIds.airports[dep],
              arrivalAirportId: dbIds.airports[arr],
              startShiftHours: s.startShift,
              endShiftHours: s.endShift,
            };
          })
          .filter(e => e.departureAirportId != null && e.arrivalAirportId != null);
        API.saveWindowShifts(payload).catch(err => addToast(String(err), 'error'));
      }, 500);
      return next;
    });
  }, [setupData.dbIds, addToast]);

  // ── Tag / sector limit warnings ───────────────────────────────────────────
  const warnTimer = useRef(null);
  useEffect(() => {
    if (warnTimer.current) clearTimeout(warnTimer.current);
    warnTimer.current = setTimeout(() => {
      const { tagMap, sectorMap, tagLimits, sectorLimits, departureHours } = setupData;
      const tagUsage = {};
      const sectorUsage = {};
      connections.forEach(c => {
        [c.depRoute, c.track, c.arrRoute].forEach(seg => {
          (tagMap[seg] || []).forEach(tag => { tagUsage[tag] = (tagUsage[tag] || 0) + c.value; });
          (sectorMap[seg] || []).forEach(s => { sectorUsage[s.identifier] = (sectorUsage[s.identifier] || 0) + c.value; });
        });
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

  // ── Per-airport departure time window start ───────────────────────────────
  const handleDepTimeChange = useCallback((icao, val) => {
    setDepTimes(p => ({ ...p, [icao]: val }));
    if (!isStaff) return;
    const dbId = setupData.dbIds.airports[icao];
    if (!dbId) return;
    apiFetch(`/airports/${dbId}/departure-time/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ departureTimeWindowStart: val }),
    }).catch(() => addToast(`Failed to save departure time for ${icao}`, 'error'));
  }, [isStaff, setupData.dbIds, addToast]);

  // ── Search filter ─────────────────────────────────────────────────────────
  const term = searchTerm.trim().toLowerCase();
  const filteredConns = term ? connections.filter(c=>[c.dep,c.depRoute,c.track,c.arrRoute,c.arr].some(v=>v.toLowerCase().includes(term))) : connections;
  let vDeps      = deps.filter(d      => !term || filteredConns.some(c=>c.dep===d.id));
  let vDepRoutes = depRoutes.filter(r  => !term || filteredConns.some(c=>c.depRoute===r.id));
  let vTracks    = tracks.filter(t    => !term || filteredConns.some(c=>c.track===t.id));
  let vArrRoutes = arrRoutes.filter(r  => !term || filteredConns.some(c=>c.arrRoute===r.id));
  let vArrs      = arrs.filter(a      => !term || filteredConns.some(c=>c.arr===a.id));

  // ── Visibility filter ─────────────────────────────────────────────────────
  if (gridVisibility === 'loaded') {
    // "With traffic": only rows that have connections — this is the default
    // (no extra filter needed; parseSlotGroups already only creates entries for routes in connections)
  } else if (gridVisibility === 'overloaded') {
    vDeps      = vDeps.filter(d      => d.cap != null && d.value  > d.cap);
    vDepRoutes = vDepRoutes.filter(r  => r.cap != null && r.value  > r.cap);
    vTracks    = vTracks.filter(t    => t.cap != null && t.slots  > t.cap);
    vArrRoutes = vArrRoutes.filter(r  => r.cap != null && r.value  > r.cap);
    vArrs      = vArrs.filter(a      => a.cap != null && a.value  > a.cap);
  } else if (gridVisibility === 'active' || gridVisibility === 'all') {
    // "Enabled" or "All": add 0-traffic entries for every enabled route from setupData
    const existingDRIds  = new Set(vDepRoutes.map(r => r.id));
    const existingTrIds  = new Set(vTracks.map(t   => t.id));
    const existingARIds  = new Set(vArrRoutes.map(r => r.id));
    const existingDepIds = new Set(vDeps.map(d      => d.id));
    const existingArrIds = new Set(vArrs.map(a      => a.id));
    const match = (id) => !term || id.toLowerCase().includes(term);
    // For dep routes: only include routes from airports that match, or routes whose own identifier matches.
    // Using all airports' routes with just an identifier check would include routes from unrelated airports.
    const matchingDepAirports = new Set(setupData.deps.filter(dep => match(dep)));
    const allDRIds = [...new Set([
      ...Object.entries(setupData.depRoutesByDep).flatMap(([dep, ids]) => matchingDepAirports.has(dep) ? ids : []),
      ...Object.values(setupData.depRoutesByDep).flat().filter(id => match(id)),
    ])];
    const arrAirportList = [...new Set(Object.values(setupData.arrByArrRoute))];
    const matchingArrAirports = new Set(arrAirportList.filter(a => match(a)));
    const arrRoutesByArrAirport = {};
    Object.entries(setupData.arrByArrRoute).forEach(([rId, arr]) => { (arrRoutesByArrAirport[arr] = arrRoutesByArrAirport[arr] || []).push(rId); });
    const allARIds = [...new Set([
      ...Object.entries(arrRoutesByArrAirport).flatMap(([arr]) => matchingArrAirports.has(arr) ? (arrRoutesByArrAirport[arr] || []) : []),
      ...setupData.arrRoutes.filter(id => match(id)),
    ])];
    vDepRoutes = [...vDepRoutes, ...allDRIds.filter(id => !existingDRIds.has(id)).map(id => ({ id, value: 0, cap: setupData.defaultCaps.depRoutes?.[id] ?? null }))];
    vTracks    = [...vTracks,    ...setupData.tracks.filter(id => !existingTrIds.has(id) && match(id)).map(id => ({ id, col: '#2A3B90', slots: 0, cap: setupData.defaultCaps.tracks?.[id] ?? null }))];
    vArrRoutes = [...vArrRoutes, ...allARIds.filter(id => !existingARIds.has(id)).map(id => ({ id, value: 0, cap: setupData.defaultCaps.arrRoutes?.[id] ?? null }))];
    vDeps      = [...vDeps,      ...setupData.deps.filter(id => !existingDepIds.has(id) && match(id)).map(id => ({ id, value: 0, cap: setupData.defaultCaps.deps?.[id] ?? null }))];
    vArrs      = [...vArrs,      ...arrAirportList.filter(id => !existingArrIds.has(id) && match(id)).map(id => ({ id, value: 0, cap: setupData.defaultCaps.arrs?.[id] ?? null }))];
    if (gridVisibility === 'all') {
      // Also add disabled routes — rebuild sets after enabled-empties were appended
      const afterDRIds  = new Set(vDepRoutes.map(r => r.id));
      const afterTrIds  = new Set(vTracks.map(t   => t.id));
      const afterARIds  = new Set(vArrRoutes.map(r => r.id));
      const mk = (r) => ({ id: r.identifier, value: 0, cap: null, slots: 0, disabled: true });
      const dis = (type, existing) => setupData.routeList
        .filter(r => !r.enabled && r.type === type && match(r.identifier) && !existing.has(r.identifier))
        .map(mk);
      vDepRoutes = [...vDepRoutes, ...dis('dep',   afterDRIds)];
      vTracks    = [...vTracks,    ...dis('track', afterTrIds)];
      vArrRoutes = [...vArrRoutes, ...dis('arr',   afterARIds)];
    }
  }

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
  const lookupConn  = (dep, depRoute, track, arrRoute, arr) =>
    connections.find(c => c.dep===dep && c.depRoute===depRoute && c.track===track && c.arrRoute===arrRoute && c.arr===arr) || null;
  const fillNewRouteValue = (nr) => {
    const { dep, depRoute, track, arrRoute, arr } = nr;
    if (!dep || !depRoute || !track || !arrRoute || !arr) return nr;
    const existing = lookupConn(dep, depRoute, track, arrRoute, arr);
    return existing ? { ...nr, value: existing.value } : nr;
  };

  const getSelConns = () => {
    if (!selectedEntity) return [];
    switch (selectedEntity.type) {
      case 'dep':      return connections.filter(c => c.dep === selectedEntity.id);
      case 'depRoute': return connections.filter(c => c.depRoute === selectedEntity.id);
      case 'track':    return connections.filter(c => c.track === selectedEntity.id);
      case 'arrRoute': return connections.filter(c => c.arrRoute === selectedEntity.id);
      case 'arr':      return connections.filter(c => c.arr === selectedEntity.id);
    }
  };
  const selConnsAll = getSelConns();
  const selConns    = selConnsAll.filter(c => filteredConns.includes(c));
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
      const dbIds = setupData.dbIds || {};
      const idUpdates = {};
      if (field === 'dep')      idUpdates.depAirportId = dbIds.airports?.[val]      ?? null;
      if (field === 'depRoute') idUpdates.depRouteId   = dbIds.routeSegments?.[val] ?? null;
      if (field === 'track')    idUpdates.trackId      = dbIds.routeSegments?.[val] ?? null;
      if (field === 'arrRoute') idUpdates.arrRouteId   = dbIds.routeSegments?.[val] ?? null;
      if (field === 'arr')      idUpdates.arrAirportId = dbIds.airports?.[val]      ?? null;
      const newConns = prev.connections.map(c => c === conn ? { ...c, [field]: val, ...idUpdates } : c);
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
    hasEdits.current = true;
    setIsDirty(true);
    const dc = setupData.defaultCaps || {};
    setData(prev => {
      const dbIds = setupData.dbIds || {};
      const existingIdx = prev.connections.findIndex(c=>c.dep===dep&&c.depRoute===depRoute&&c.track===track&&c.arrRoute===arrRoute&&c.arr===arr);
      let newConns;
      if (existingIdx >= 0) {
        newConns = prev.connections.map((c,i) => i === existingIdx ? { ...c, value, depAirportId: dbIds.airports?.[dep]??c.depAirportId, depRouteId: dbIds.routeSegments?.[depRoute]??c.depRouteId, trackId: dbIds.routeSegments?.[track]??c.trackId, arrRouteId: dbIds.routeSegments?.[arrRoute]??c.arrRouteId, arrAirportId: dbIds.airports?.[arr]??c.arrAirportId } : c);
      } else {
        newConns = [...prev.connections,{
          dep, depRoute, track, arrRoute, arr, value,
          depAirportId:  dbIds.airports?.[dep]         ?? null,
          depRouteId:    dbIds.routeSegments?.[depRoute] ?? null,
          trackId:       dbIds.routeSegments?.[track]    ?? null,
          arrRouteId:    dbIds.routeSegments?.[arrRoute] ?? null,
          arrAirportId:  dbIds.airports?.[arr]           ?? null,
        }];
      }
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
      .finally(() => { isSubmitting.current = false; if (mode === 'simulate') stopSimPoll(); loadAll(); });
  };

  // ── Layout effects ────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    if (!gridRef.current) return;
    const update = () => { const cr=gridRef.current.getBoundingClientRect(); const rects=Array.from(gridRef.current.querySelectorAll('.col')).map(c=>{const r=c.getBoundingClientRect();return{left:r.left-cr.left,right:r.right-cr.left};}); setColPositions({rects,totalWidth:cr.width}); };
    update(); window.addEventListener('resize',update); return ()=>window.removeEventListener('resize',update);
  }, [data, searchTerm, activeTab, gridVisibility]);
  useLayoutEffect(()=>{ if(editRef.current) setBraceHeight(editRef.current.offsetHeight); }, [selConns.length,selectedEntity]);

  // ── D3 Sankey ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!svgRef.current||!gridRef.current) return;
    const cr=gridRef.current.getBoundingClientRect();
    const rects=Array.from(gridRef.current.querySelectorAll('.col')).map(c=>{const r=c.getBoundingClientRect();return{left:r.left-cr.left,right:r.right-cr.left};});
    const totalWidth=cr.width;
    if(rects.length<5) return;
    const cols=Array.from(gridRef.current.querySelectorAll('.col'));
    const cellCenters=col=>Array.from(col?.querySelectorAll('.planner__cell')??[]).map(el=>{const r=el.getBoundingClientRect();return r.top-cr.top+r.height/2;});
    const depCenterYs=cellCenters(cols[0]);
    const trackCells=Array.from(gridRef.current.querySelectorAll('.planner__cell--track'));
    const trackCenterYs=trackCells.map(el=>{const r=el.getBoundingClientRect();return r.top-cr.top+r.height/2;});
    const arrCenterYs=cellCenters(cols[4]);
    const svgH=Math.max(totalH,cr.height);
    const svg=d3.select(svgRef.current); svg.selectAll('*').remove(); svg.attr('width',totalWidth).attr('height',svgH);
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
      const hi=!selectedEntity||(selectedEntity.type==='dep'&&selectedEntity.id===conn.dep)||(selectedEntity.type==='depRoute'&&selectedEntity.id===conn.depRoute)||(selectedEntity.type==='track'&&selectedEntity.id===conn.track)||(selectedEntity.type==='arrRoute'&&selectedEntity.id===conn.arrRoute)||(selectedEntity.type==='arr'&&selectedEntity.id===conn.arr); const ds=depRoutes.find(r=>r.id===conn.depRoute)?.selected; const as=arrRoutes.find(r=>r.id===conn.arrRoute)?.selected;
      const alpha=hi?(ds&&as?0.65:0.08):0.03; const bw=thick(conn.value);
      const dcy=depCenterYs[di]??itemY(di,vDeps.length);
      const tcy=trackCenterYs[ti]??itemY(ti,oTr.length);
      const acy=arrCenterYs[ai]??itemY(ai,oArrs.length);
      band(rects[0].right,dcy,rects[1].left,itemY(dri,oDR.length),trk.col,alpha,bw);
      band(rects[1].right,itemY(dri,oDR.length),rects[2].left,tcy,trk.col,alpha,bw);
      band(rects[2].right,tcy,rects[3].left,itemY(ari,oAR.length),trk.col,alpha,bw);
      band(rects[3].right,itemY(ari,oAR.length),rects[4].left,acy,trk.col,alpha,bw);
    });
  }, [data, colPositions, selectedEntity, searchTerm, gridVisibility]); // colPositions kept so resize triggers redraw

  const liveSlots = {}; connections.forEach(c=>{liveSlots[c.track]=(liveSlots[c.track]||0)+c.value;});
  const liveRouteSlots = {};
  connections.forEach(c => {
    liveRouteSlots[c.depRoute] = (liveRouteSlots[c.depRoute] || 0) + c.value;
    liveRouteSlots[c.track]    = (liveRouteSlots[c.track]    || 0) + c.value;
    liveRouteSlots[c.arrRoute] = (liveRouteSlots[c.arrRoute] || 0) + c.value;
  });
  const disabledInUse = setupData.disabledRoutes.length > 0
    ? [...new Set(connections.flatMap(c => [c.depRoute, c.track, c.arrRoute]).filter(r => setupData.disabledRoutes.includes(r)))]
    : [];
  const liveTagUsage = {};
  const liveSectorUsage = {};
  connections.forEach(c => {
    [c.depRoute, c.track, c.arrRoute].forEach(seg => {
      (setupData.tagMap[seg] || []).forEach(tag => { liveTagUsage[tag] = (liveTagUsage[tag] || 0) + c.value; });
      (setupData.sectorMap[seg] || []).forEach(s => { liveSectorUsage[s.identifier] = (liveSectorUsage[s.identifier] || 0) + c.value; });
    });
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
        <div className="modal-overlay" onClick={e=>{e.stopPropagation();setShowLimitModal(false);}}>
          <div className="modal-box modal-box--limit-warning" onClick={e=>e.stopPropagation()}>
            <div className="modal-header modal-header--danger">
              <span className="modal-title">⚠ Throughput Limits Exceeded</span>
              <button className="modal-close" onClick={()=>setShowLimitModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p className="limit-warning__intro">The following limits are exceeded by the current route plan.</p>
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
              {disabledInUse.length > 0 && (
                <div className="limit-warning__disabled-note">
                  <strong>Disabled routes in use:</strong> the following routes are disabled but still appear in your plan and may contribute to violations: {disabledInUse.join(', ')}
                </div>
              )}
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
          <span className="planner__meta-label">Rev <strong className="planner__rev-value">{revStr}</strong></span>
          {simStatus === 'running'       && <span className="planner__sim-status planner__sim-status--running">Running simulator…</span>}
          {simStatus === 'sim_responded' && <span className="planner__sim-status planner__sim-status--saving">Saving slot times…</span>}
          {simStatus === 'saved'         && <span className="planner__sim-status planner__sim-status--done">Finalizing…</span>}
          {!isStaff && <span className="planner__readonly-badge">Read-only</span>}
          {limitViolations.length > 0 && (
            <button className="planner__limit-alert" onClick={e=>{e.stopPropagation();setShowLimitModal(true);}}>
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
          {isStaff && connections.length > 0 && (
            <button className="planner__btn planner__btn--destructive" onClick={() => {
              if (window.confirm('Clear all slots? This cannot be undone.')) {
                hasEdits.current = true;
                setIsDirty(true);
                setData(prev => recomputeAggregates(prev, []));
              }
            }}>Clear All Slots</button>
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

      {activeTab === 'throughputLimits' && <ThroughputLimitsPage isStaff={isRouteStaff} addToast={addToast} tagUsage={liveTagUsage} sectorUsage={liveSectorUsage} departureHours={setupData.departureHours} tagToRoutes={setupData.tagToRoutes} sectorToRoutes={setupData.sectorToRoutes} routeSlots={liveRouteSlots} routeList={setupData.routeList}/>}

      {activeTab === 'cityPairTotals' && <CityPairTotalsPage data={data} setupData={setupData} airportWindowShifts={airportWindowShifts} updatePairShift={isStaff ? updatePairShift : null} departureTimeWindowHours={setupData.departureTimeWindowHours ?? setupData.departureHours ?? 3}/>}

      {/* Control bar */}
      {activeTab === 'planner' && <div className="planner__control-bar" onClick={e=>e.stopPropagation()}>
        {selectedEntity && <div className="planner__editing-label"><span className="planner__editing-dot"/>Editing: <strong>{selectedEntity.type}: {selectedEntity.id}</strong></div>}

        <div className="planner__instructions">
          Click a cell to edit its connections. Use the dropdowns below to add or adjust connections. Caps can be set when an entity is selected.
        </div>

        <div className="search-container">
          <div className="search-input-wrap">
            <input type="text" placeholder="Search by dep, route, track, or arrival…" value={searchTerm} onChange={e=>setSearchTerm(e.target.value)} className="search-input"/>
            {searchTerm && <button className="search-clear" onClick={()=>setSearchTerm('')}>✕</button>}
          </div>
          <select className="planner__visibility-filter" value={gridVisibility} onChange={e=>setGridVisibility(e.target.value)}>
            <option value="all">All (incl. disabled)</option>
            <option value="active">Enabled</option>
            <option value="loaded">With traffic (default)</option>
            <option value="overloaded">Over capacity</option>
          </select>
        </div>
        <div className="planner__control-add">
          <select disabled={!isStaff} value={newRoute.dep} onChange={e=>setNewRoute(r=>fillNewRouteValue({...r,dep:e.target.value,depRoute:'',track:'',arrRoute:'',arr:'',value:0}))}>
            <option value="">Departure</option>{ddDeps.map(d=><option key={d} value={d}>{d}</option>)}
          </select>
          <select disabled={!isStaff} value={newRoute.depRoute} onChange={e=>setNewRoute(r=>fillNewRouteValue({...r,depRoute:e.target.value,track:'',arrRoute:'',arr:'',value:0}))}>
            <option value="">Dep Route</option>{ddDepRoutes(newRoute.dep).map(r=><option key={r} value={r}>{r}</option>)}
          </select>
          <select disabled={!isStaff} value={newRoute.track} onChange={e=>setNewRoute(r=>fillNewRouteValue({...r,track:e.target.value,arrRoute:'',arr:'',value:0}))}>
            <option value="">Track</option>{ddTracks(newRoute.depRoute).map(t=><option key={t} value={t}>{t}</option>)}
          </select>
          <select disabled={!isStaff} value={newRoute.arrRoute} onChange={e=>{const ar=e.target.value;setNewRoute(r=>fillNewRouteValue({...r,arrRoute:ar,arr:autoArr(ar)||'',value:0}));}}>
            <option value="">Arr Route</option>{ddArrRoutes(newRoute.track).map(r=><option key={r} value={r}>{r}</option>)}
          </select>
          <select disabled={!isStaff || !!autoArr(newRoute.arrRoute)} value={newRoute.arr} onChange={e=>setNewRoute(r=>fillNewRouteValue({...r,arr:e.target.value}))}>
            <option value="">{autoArr(newRoute.arrRoute) ? autoArr(newRoute.arrRoute) : 'Arrival'}</option>
            {!autoArr(newRoute.arrRoute) && [...new Set([...setupData.arrs,...arrs.map(a=>a.id)])].sort().map(a=><option key={a} value={a}>{a}</option>)}
          </select>
          <input disabled={!isStaff} className="planner__ctrl-num" type="number" min={0} value={newRoute.value} onChange={e=>setNewRoute(r=>({...r,value:parseInt(e.target.value)||0}))}/>
          <button disabled={!isStaff} className="planner__btn" onClick={addConnection}>Adjust</button>
        </div>

        {selectedEntity && selConns.length > 0 && (
          <div className="planner__brace-section">
            <div className="planner__brace-col" style={{width:BRACE_COL_W,minHeight:braceHeight}}>
              <div className="planner__brace-svg-wrap"><CurlyBrace height={braceHeight}/></div>
            </div>
            <div className="planner__control-edit" ref={editRef}>
              {selConns.map(c => (
                <div key={`${c.depRoute}-${c.track}-${c.arrRoute}-${c.arr}`} className="planner__control-row">
                  <span className="planner__conn-label" style={{background:trackCol(c.track)}}>{connLabel(c)}</span>
                  <select disabled={!isStaff} value={c.depRoute} onChange={e=>editConn(c,'depRoute',e.target.value)}>
                    {ddDepRoutes(c.dep).map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <select disabled={!isStaff} value={c.track} onChange={e=>editConn(c,'track',e.target.value)}>{ddTracks(c.depRoute).map(t=><option key={t} value={t}>{t}</option>)}</select>
                  <select disabled={!isStaff} value={c.arrRoute} onChange={e=>{const ar=e.target.value;const a=autoArr(ar);hasEdits.current=true;setIsDirty(true);setData(prev=>{const dbIds=setupData.dbIds||{};const newConns=prev.connections.map(x=>x===c?{...x,arrRoute:ar,arrRouteId:dbIds.routeSegments?.[ar]??null,...(a?{arr:a,arrAirportId:dbIds.airports?.[a]??null}:{})}:x);return recomputeAggregates(prev,newConns);});}}>{ddArrRoutes(c.track).map(r=><option key={r} value={r}>{r}</option>)}</select>
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

        {selectedEntity && (
          <div className="planner__cap-editor" onClick={e=>e.stopPropagation()}>
            <span className="planner__cap-editor-title">
              Caps — {selectedEntity.type === 'dep' ? `Departure: ${selectedEntity.id}` : selectedEntity.type === 'arr' ? `Arrival: ${selectedEntity.id}` : `${selectedEntity.type}: ${selectedEntity.id}`} · airports: total slots · routes/tracks: per hour ×{setupData.departureHours}h = total
            </span>
            <div className="planner__cap-grid">
              {selectedEntity?.type === 'dep' && deps.filter(d=>d.id===selectedEntity.id).map(d=>(
                <React.Fragment key={d.id}>
                  <span className="planner__cap-key">Dep: {d.id} <em style={{fontWeight:400,color:'var(--text-muted)'}}>slots</em></span>
                  <input className="planner__cap-input" type="number" min={0} value={d.cap??''} placeholder="∞"
                    disabled={!isStaff} onChange={e=>setCap('deps',d.id,e.target.value)}/>
                </React.Fragment>
              ))}
              {selectedEntity?.type === 'arr' && arrs.filter(a=>a.id===selectedEntity.id).map(a=>(
                <React.Fragment key={a.id}>
                  <span className="planner__cap-key">Arr: {a.id} <em style={{fontWeight:400,color:'var(--text-muted)'}}>slots</em></span>
                  <input className="planner__cap-input" type="number" min={0} value={a.cap??''} placeholder="∞"
                    disabled={!isStaff} onChange={e=>setCap('arrs',a.id,e.target.value)}/>
                </React.Fragment>
              ))}
              {selectedEntity?.type === 'track' && tracks.filter(t=>t.id===selectedEntity.id).map(t=>(
                <React.Fragment key={t.id}>
                  <span className="planner__cap-key" style={{color:t.col}}>Track: {t.id} <em style={{fontWeight:400,color:'var(--text-muted)'}}>/hr{t.cap!=null?` · ${t.cap} total`:''}</em></span>
                  <input className="planner__cap-input" type="number" min={0} value={t.cap!=null?Math.round(t.cap/setupData.departureHours):''} placeholder="∞"
                    disabled={!isStaff} onChange={e=>setCap('tracks',t.id,e.target.value)}/>
                </React.Fragment>
              ))}
              {selectedEntity?.type === 'depRoute' && depRoutes.filter(r=>r.id===selectedEntity.id).map(r=>(
                <React.Fragment key={r.id}>
                  <span className="planner__cap-key">DepRoute: {r.id} <em style={{fontWeight:400,color:'var(--text-muted)'}}>/hr{r.cap!=null?` · ${r.cap} total`:''}</em></span>
                  <input className="planner__cap-input" type="number" min={0} value={r.cap!=null?Math.round(r.cap/setupData.departureHours):''} placeholder="∞"
                    disabled={!isStaff} onChange={e=>setCap('depRoutes',r.id,e.target.value)}/>
                </React.Fragment>
              ))}
              {selectedEntity?.type === 'arrRoute' && arrRoutes.filter(r=>r.id===selectedEntity.id).map(r=>(
                <React.Fragment key={r.id}>
                  <span className="planner__cap-key">ArrRoute: {r.id} <em style={{fontWeight:400,color:'var(--text-muted)'}}>/hr{r.cap!=null?` · ${r.cap} total`:''}</em></span>
                  <input className="planner__cap-input" type="number" min={0} value={r.cap!=null?Math.round(r.cap/setupData.departureHours):''} placeholder="∞"
                    disabled={!isStaff} onChange={e=>setCap('arrRoutes',r.id,e.target.value)}/>
                </React.Fragment>
              ))}
              {[...new Set(selConnsAll.map(c=>c.dep))].sort().filter(dId=>selectedEntity?.type!=='dep'||dId!==selectedEntity.id).map(dId=>{
                const d=deps.find(x=>x.id===dId); if(!d) return null;
                return (
                  <React.Fragment key={d.id}>
                    <span className="planner__cap-key">Dep: {d.id} <em style={{fontWeight:400,color:'var(--text-muted)'}}>slots</em></span>
                    <input className="planner__cap-input" type="number" min={0} value={d.cap??''} placeholder="∞"
                      disabled={!isStaff} onChange={e=>setCap('deps',d.id,e.target.value)}/>
                  </React.Fragment>
                );
              })}
              {[...new Set(selConnsAll.map(c=>c.depRoute))].sort().filter(rId=>selectedEntity?.type!=='depRoute'||rId!==selectedEntity.id).map(rId=>{
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
              {[...new Set(selConnsAll.map(c=>c.track))].sort().filter(tId=>selectedEntity?.type!=='track'||tId!==selectedEntity.id).map(tId=>{
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
              {[...new Set(selConnsAll.map(c=>c.arrRoute))].sort().filter(rId=>selectedEntity?.type!=='arrRoute'||rId!==selectedEntity.id).map(rId=>{
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
              {selectedEntity?.type !== 'arr' && [...new Set(selConnsAll.map(c=>c.arr))].sort().map(aId=>{
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
          {vDeps.map(dep => { const isSel=selectedEntity?.type==='dep'&&selectedEntity?.id===dep.id; const dData=deps.find(d=>d.id===dep.id); return (
            <div key={dep.id} className={`planner__cell planner__cell--dep${isSel?' planner__cell--selected':''}${!isSel&&selectedEntity?' planner__cell--dimmed':''}`} style={{minHeight:maxRows*ROW_H/vDeps.length}} onClick={e=>{e.stopPropagation();setSelectedEntity(isSel?null:{type:'dep',id:dep.id});}}>
              <div className="planner__cell-dep-info">
                <span className="planner__cell-name">{dep.id}</span>
                <TimeSpinner value={depTimes[dep.id] || ''} onChange={v => handleDepTimeChange(dep.id, v)} style={!isStaff?{pointerEvents:'none',opacity:.5}:{fontSize:'0.75rem'}}/>
              </div>
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
          {oDR.map(route => { const isSel=selectedEntity?.type==='depRoute'&&selectedEntity?.id===route.id; const rc=selConnsAll.filter(c=>c.depRoute===route.id); const opacity=!selectedEntity?1:(isSel?1:0.35); return (
            <div key={route.id} className={`planner__route-row${route.disabled?' planner__route-row--disabled':''}${isSel?' planner__cell--selected':''}`} style={{height:maxRows*ROW_H/oDR.length,opacity}} onClick={e=>{e.stopPropagation();setSelectedEntity(isSel?null:{type:'depRoute',id:route.id});}}>
              <span className="planner__route-name">{route.id}{route.disabled&&<span className="planner__route-disabled-badge"> disabled</span>}</span>
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
          {oTr.map(track => { const isSel=selectedEntity?.type==='track'&&selectedEntity?.id===track.id; const tc=selConnsAll.filter(c=>c.track===track.id); const active=!selectedEntity||isSel||tc.length>0; return (
            <div key={track.id} className={`planner__cell planner__cell--track${track.disabled?' planner__cell--disabled':''}${isSel?' planner__cell--selected':''}`} style={{minHeight:maxRows*ROW_H/oTr.length,opacity:active?1:0.15}} onClick={e=>{e.stopPropagation();setSelectedEntity(isSel?null:{type:'track',id:track.id});}}>
              <div className="planner__track-main">
                <span style={{fontWeight:700,fontSize:26,color:track.disabled?'var(--text-muted)':track.col,lineHeight:1}}>{track.id}{track.disabled&&<span className="planner__route-disabled-badge"> disabled</span>}</span>
                <QuantityLabel used={liveSlots[track.id]||0} cap={track.cap} size="lg"/>
              </div>
              {isSel&&tc.length>0&&(
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
          {oAR.map(route => { const isSel=selectedEntity?.type==='arrRoute'&&selectedEntity?.id===route.id; const rc=selConnsAll.filter(c=>c.arrRoute===route.id); const active=!selectedEntity||isSel||rc.length>0; return (
            <div key={route.id} className={`planner__route-row${route.disabled?' planner__route-row--disabled':''}${isSel?' planner__cell--selected':''}`} style={{height:maxRows*ROW_H/oAR.length,opacity:active?1:0.15}} onClick={e=>{e.stopPropagation();setSelectedEntity(isSel?null:{type:'arrRoute',id:route.id});}}>
              <span className="planner__route-name">{route.id}{route.disabled&&<span className="planner__route-disabled-badge"> disabled</span>}</span>
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
          {oArrs.map(arr => { const isSel=selectedEntity?.type==='arr'&&selectedEntity?.id===arr.id; const ac=selConnsAll.filter(c=>c.arr===arr.id); const active=!selectedEntity||isSel||ac.length>0; const aData=arrs.find(a=>a.id===arr.id); return (
            <div key={arr.id} className={`planner__cell planner__cell--right${isSel?' planner__cell--selected':''}`} style={{minHeight:maxRows*ROW_H/oArrs.length,opacity:active?1:0.15}} onClick={e=>{e.stopPropagation();setSelectedEntity(isSel?null:{type:'arr',id:arr.id});}}>
              <QuantityLabel used={aData?.value??0} cap={aData?.cap} size="lg"/>
              {isSel&&ac.map(c=><span key={`${c.track}-${c.depRoute}`} className="planner__conn-label" style={{background:trackCol(c.track)}}>{connLabel(c)}</span>)}
              <div className="planner__cell-arr-info">
                <span className="planner__cell-name">{arr.id}</span>
                {arrTimes[arr.id] && <TimeSpinner value={arrTimes[arr.id]} onChange={()=>{}} style={{pointerEvents:'none',opacity:.7,fontSize:'0.75rem'}}/>}
              </div>
            </div>
          );})}
        </div>

      </div>}
    </div>
  );
}
