import * as d3 from 'd3';
import { TRACK_COLS } from './constants.js';

export function splitSlotId(id) {
  const parts = id.split('|');
  if (parts.length !== 5) { console.warn('[SlotPlanner] Bad ID:', id); return null; }
  return parts;
}

export function parseSlotGroups(slotGroups, caps = {}) {
  const deps = {}, depRoutes = {}, tracks = {}, arrRoutes = {}, arrs = {};
  const connections = [];
  let tcIdx = 0;
  const C = {
    deps:      caps.deps      || {},
    depRoutes: caps.depRoutes || {},
    tracks:    caps.tracks    || {},
    arrRoutes: caps.arrRoutes || {},
    arrs:      caps.arrs      || {},
  };

  (slotGroups || []).forEach(({ id, value, depAirportId, depRouteId, trackId, arrRouteId, arrAirportId }) => {
    const p = splitSlotId(id); if (!p) return;
    const [dep, depRoute, track, arrRoute, arr] = p;
    if (!deps[dep])           deps[dep]           = { id: dep,      value: 0, cap: C.deps[dep]           ?? null };
    if (!depRoutes[depRoute]) depRoutes[depRoute]  = { id: depRoute, value: 0, cap: C.depRoutes[depRoute] ?? null, selected: true };
    if (!tracks[track])       tracks[track]        = { id: track,    col: TRACK_COLS[tcIdx++ % TRACK_COLS.length], slots: 0, cap: C.tracks[track] ?? null };
    if (!arrRoutes[arrRoute]) arrRoutes[arrRoute]  = { id: arrRoute, value: 0, cap: C.arrRoutes[arrRoute] ?? null, selected: true };
    if (!arrs[arr])           arrs[arr]            = { id: arr,      value: 0, cap: C.arrs[arr]           ?? null };
    deps[dep].value += value; depRoutes[depRoute].value += value; tracks[track].slots += value;
    arrRoutes[arrRoute].value += value; arrs[arr].value += value;
    connections.push({ dep, depRoute, track, arrRoute, arr, value, depAirportId, depRouteId, trackId, arrRouteId, arrAirportId });
  });

  return {
    deps:      Object.values(deps),
    depRoutes: Object.values(depRoutes),
    tracks:    Object.values(tracks),
    arrRoutes: Object.values(arrRoutes),
    arrs:      Object.values(arrs),
    connections,
  };
}

export function snapshotCaps(data) {
  return {
    deps:      Object.fromEntries(data.deps.map(d      => [d.id, d.cap])),
    depRoutes: Object.fromEntries(data.depRoutes.map(r => [r.id, r.cap])),
    tracks:    Object.fromEntries(data.tracks.map(t    => [t.id, t.cap])),
    arrRoutes: Object.fromEntries(data.arrRoutes.map(r => [r.id, r.cap])),
    arrs:      Object.fromEntries(data.arrs.map(a      => [a.id, a.cap])),
  };
}

export function parseTime(v) {
  const s = (v || '').trim().toLowerCase().replace('z', '');
  return {
    h: Math.min(23, Math.max(0, parseInt(s.slice(0, 2), 10) || 0)),
    m: Math.min(59, Math.max(0, parseInt(s.slice(2, 4), 10) || 0)),
  };
}

export function formatTime({ h, m }) {
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '00')}z`;
}

export function barycentricOrder(items, conns, key, prevKey, prevOrder) {
  return items.map(item => {
    const linked = conns.filter(c => c[key] === item.id);
    const bary   = linked.length ? d3.mean(linked.map(c => prevOrder.get(c[prevKey]))) : Infinity;
    return { item, bary };
  }).sort((a, b) => a.bary - b.bary).map(d => d.item);
}
