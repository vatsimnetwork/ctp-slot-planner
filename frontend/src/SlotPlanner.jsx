import { useEffect, useRef, useState, useLayoutEffect, useCallback } from "react";
import * as d3 from "d3";
import "./SlotPlanner.css";

const ROW_H       = 52;
const GRID_PAD    = 20;
const HEADER_H    = 47 + GRID_PAD;
const TRACK_COLS  = ['#2783C5', '#29B473', '#2A3B90', '#E8543E', '#9B59B6', '#F39C12'];
const BRACE_W     = 18;   
const TIME_W      = 76;   
const BRACE_GAP   = 6;    
const BRACE_COL_W = TIME_W + BRACE_GAP + BRACE_W;

const API = {

  loadSlots: () =>
    fetch('http://127.0.0.1:5000/slotgroups'),

  submit: (payload) =>
    fetch('/api/slot-groups/submit/', {
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
};

function parseSlotGroups(slotGroups) {
  const deps = {}, depRoutes = {}, tracks = {}, arrRoutes = {}, arrs = {};
  const connections = [];
  let tcIdx = 0;

  slotGroups.forEach(({ id, value }) => {
    const p = id.split('-');
    if (p.length !== 5) return;
    const [dep, depRoute, track, arrRoute, arr] = p;

    if (!deps[dep])           deps[dep]           = { id: dep, value: 0 };
    if (!depRoutes[depRoute]) depRoutes[depRoute]  = { id: depRoute, value: 0, selected: true };
    if (!tracks[track])       tracks[track]        = { id: track, col: TRACK_COLS[tcIdx++ % TRACK_COLS.length], slots: 0 };
    if (!arrRoutes[arrRoute]) arrRoutes[arrRoute]  = { id: arrRoute, value: 0, selected: true };
    if (!arrs[arr])           arrs[arr]            = { id: arr };

    deps[dep].value           += value;
    depRoutes[depRoute].value += value;
    tracks[track].slots       += value;
    arrRoutes[arrRoute].value += value;
    connections.push({ dep, depRoute, track, arrRoute, arr, value });
  });

  return {
    deps: Object.values(deps), depRoutes: Object.values(depRoutes),
    tracks: Object.values(tracks), arrRoutes: Object.values(arrRoutes),
    arrs: Object.values(arrs), connections,
  };
}

const isValidTime = (v) => /^([01][0-9]|2[0-3])[0-5][0-9]z?$/i.test((v || '').trim());
const normalizeTime = (v) => {
  const t = (v || '').trim().toLowerCase().replace('z', '');
  return t + 'z';
};

function TimeInput({ value, onChange, style, className }) {
  const [local, setLocal]   = useState(value ?? '');
  const [invalid, setInvalid] = useState(false);

  useEffect(() => { setLocal(value ?? ''); }, [value]);

  const commit = () => {
    if (isValidTime(local)) {
      setInvalid(false);
      onChange(normalizeTime(local));
    } else {
      setInvalid(true);
    }
  };

  return (
    <input
      type="text"
      value={local}
      placeholder="HHMMz"
      className={`planner__time-input${invalid ? ' planner__time-input--invalid' : ''}${className ? ' ' + className : ''}`}
      style={style}
      onChange={e => { setLocal(e.target.value); setInvalid(false); }}
      onBlur={commit}
      onKeyDown={e => e.key === 'Enter' && commit()}
    />
  );
}

function CurlyBrace({ height }) {
  if (height < 6) return <div style={{ width: BRACE_W }} />;
  const W   = BRACE_W;
  const mid = height / 2;
  const c   = Math.min(height * 0.11, 13); 
  const sp  = W * 0.48;                    

  const d = [
    `M ${W} 0`,
    `C ${sp} 0, ${sp} ${c}, ${sp} ${c}`,
    `L ${sp} ${mid - c}`,
    `C ${sp} ${mid - c * 0.35}, 0 ${mid - c * 0.15}, 0 ${mid}`,
    `C 0 ${mid + c * 0.15}, ${sp} ${mid + c * 0.35}, ${sp} ${mid + c}`,
    `L ${sp} ${height - c}`,
    `C ${sp} ${height - c}, ${sp} ${height}, ${W} ${height}`,
  ].join(' ');

  return (
    <svg width={W} height={height} style={{ display: 'block', flexShrink: 0 }}>
      <path d={d} fill="none" stroke="var(--border)" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function SlotPlanner() {
  const [theme, setTheme] = useState(() =>
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  );

  const [data, setData]       = useState({ deps: [], depRoutes: [], tracks: [], arrRoutes: [], arrs: [], connections: [] });
  const [loading, setLoading] = useState(false);

  const [simVersion,       setSimVersion]       = useState(null);
  const [plannerRevisions, setPlannerRevisions] = useState(0);

  const [selectedDep,  setSelectedDep]  = useState(null);
  const [startTime,    setStartTime]    = useState('1800z');
  const [depTimes,     setDepTimes]     = useState({}); 
  const [hoveredRoute, setHoveredRoute] = useState(null);
  const [newRoute,     setNewRoute]     = useState({ dep: '', depRoute: '', track: '', arrRoute: '', arr: '', value: 0 });

  const [toasts, setToasts] = useState([]);

  const svgRef  = useRef(null);
  const gridRef = useRef(null);
  const editRef = useRef(null);
  const [colPositions, setColPositions] = useState(null);
  const [braceHeight,  setBraceHeight]  = useState(0);

  const addToast = useCallback((message, type = 'error') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
  }, []);

  const dismissToast = (id) => setToasts(prev => prev.filter(t => t.id !== id));

  useEffect(() => {
    setLoading(true);
    API.loadSlots()
      .then(r   => r.ok ? r.json() : Promise.reject('Failed to load slot data'))
      .then(raw => {
        setData(parseSlotGroups(raw.slotGroups || []));
        setSimVersion(raw.routesRevision ?? null);
        setPlannerRevisions(raw.plannerRevisions ?? 0);
        if (raw.startTime && isValidTime(raw.startTime))
          setStartTime(normalizeTime(raw.startTime));
      })
      .catch(err => addToast(String(err), 'error'))
      .finally(()  => setLoading(false));
  }, []);

  useEffect(() => {
    if (selectedDep) setNewRoute(prev => ({ ...prev, dep: selectedDep }));
  }, [selectedDep]);

  const { deps, depRoutes, tracks, arrRoutes, arrs, connections } = data;

  const maxRows            = Math.max(deps.length, depRoutes.length, tracks.length, arrRoutes.length, arrs.length, 1);
  const totalContentHeight = maxRows * ROW_H;
  const totalHeight        = HEADER_H + totalContentHeight;

  const itemY = (i, count) => {
    const rh = totalContentHeight / count;
    return HEADER_H + rh * i + rh / 2;
  };

  const [searchTerm, setSearchTerm] = useState("");
  
  const filteredConnections = connections.filter(c =>
    c.dep.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.depRoute.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.track.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.arrRoute.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.arr.toLowerCase().includes(searchTerm.toLowerCase())
  );


  const getDepTime = (depId) => depTimes[depId] ?? startTime;
  const handleDepTimeChange = (depId, t) => {
    if (!isValidTime(t)) { addToast('Invalid time — use HHMMz (e.g. 1801z)', 'warning'); return; }
    setDepTimes(prev => ({ ...prev, [depId]: normalizeTime(t) }));
  };

  const selectedDepConns = selectedDep
    ? filteredConnections.filter(c => c.dep === selectedDep)
      : filteredConnections;

  const connLabel = (conn) => {
    const idx = selectedDepConns.findIndex(c =>
      c.depRoute === conn.depRoute && c.track    === conn.track &&
      c.arrRoute === conn.arrRoute && c.arr      === conn.arr
    );
    return idx >= 0 ? String.fromCharCode(65 + idx) : '';
  };

  const trackCol = (trackId) => tracks.find(t => t.id === trackId)?.col || '#2A3B90';

  const updateDepRoute = (id, delta) => setData(prev => ({
    ...prev,
    depRoutes: prev.depRoutes.map(r => r.id === id ? { ...r, value: Math.max(0, r.value + delta) } : r),
  }));

  const updateArrRoute = (id, delta) => setData(prev => ({
    ...prev,
    arrRoutes: prev.arrRoutes.map(r => r.id === id ? { ...r, value: Math.max(0, r.value + delta) } : r),
  }));

  const removeConnection = (conn) => {
    setData(prev => ({
      ...prev,
      connections: prev.connections.filter(c => !(
        c.dep === conn.dep && c.depRoute === conn.depRoute &&
        c.track === conn.track && c.arrRoute === conn.arrRoute && c.arr === conn.arr
      )),
    }));
  };

  const addConnection = () => {
    const { dep, depRoute, track, arrRoute, arr, value } = newRoute;
    if (!dep || !depRoute || !track || !arrRoute || !arr) {
      addToast('Fill in all five fields before adding a connection', 'warning');
      return;
    }
    if (data.connections.some(c =>
      c.dep === dep && c.depRoute === depRoute &&
      c.track === track && c.arrRoute === arrRoute && c.arr === arr
    )) {
      addToast('This exact connection already exists', 'warning');
      return;
    }
    setData(prev => ({
      ...prev,
      connections: [...prev.connections, { dep, depRoute, track, arrRoute, arr, value }],
    }));
    setNewRoute(prev => ({ ...prev, depRoute: '', track: '', arrRoute: '', arr: '', value: 0 }));
  };

  const editConn = (conn, field, val) => {
    setData(prev => ({
      ...prev,
      connections: prev.connections.map(c => c === conn ? { ...c, [field]: val } : c),
    }));
  };

  const submitToBackend = (mode) => {
    const nextRev = plannerRevisions + 1;
    const payload = {
      mode, startTime,
      plannerRevisions: nextRev,
      slotGroups: connections.map(c => ({
        id:    `${c.dep}-${c.depRoute}-${c.track}-${c.arrRoute}-${c.arr}`,
        value: c.value,
      })),
    };
    API.submit(payload)
      .then(r      => r.ok ? r.json() : Promise.reject(`${mode} request failed`))
      .then(result => {
        setPlannerRevisions(nextRev);
        if (result?.slotGroups) setData(parseSlotGroups(result.slotGroups));
        addToast(
          `${mode === 'calculate' ? 'Calculation' : 'Simulation'} complete — rev ${simVersion}.${nextRev}`,
          'success'
        );
      })
      .catch(err => addToast(String(err), 'error'));
  };

  useLayoutEffect(() => {
    if (!gridRef.current) return;
    const update = () => {
      const cr   = gridRef.current.getBoundingClientRect();
      const cols = gridRef.current.querySelectorAll('.col');
      const rects = Array.from(cols).map(c => {
        const r = c.getBoundingClientRect();
        return { left: r.left - cr.left, right: r.right - cr.left };
      });
      setColPositions({ rects, totalWidth: cr.width });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [data]);

  useLayoutEffect(() => {
    if (editRef.current) setBraceHeight(editRef.current.offsetHeight);
  }, [selectedDepConns.length, selectedDep]);

  useEffect(() => {
    if (!svgRef.current || !colPositions) return;
    const { rects, totalWidth } = colPositions;
    if (rects.length < 5) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('width', totalWidth).attr('height', totalHeight);

    const band = (x1, y1, x2, y2, col, alpha, bw) => {
      const mx = (x1 + x2) / 2;
      const d  = Math.abs(y1 - y2) < 1
        ? `M ${x1} ${y1-bw/2} L ${x2} ${y2-bw/2} L ${x2} ${y2+bw/2} L ${x1} ${y1+bw/2} Z`
        : `M ${x1} ${y1-bw/2} C ${mx} ${y1-bw/2},${mx} ${y2-bw/2},${x2} ${y2-bw/2}
           L ${x2} ${y2+bw/2} C ${mx} ${y2+bw/2},${mx} ${y1+bw/2},${x1} ${y1+bw/2} Z`;
      svg.append('path').attr('d', d).attr('fill', col).attr('opacity', alpha);
    };

    connections.forEach(conn => {
      const di  = deps.findIndex(d => d.id === conn.dep);
      const dri = depRoutes.findIndex(r => r.id === conn.depRoute);
      const ti  = tracks.findIndex(t => t.id === conn.track);
      const ari = arrRoutes.findIndex(r => r.id === conn.arrRoute);
      const ai  = arrs.findIndex(a => a.id === conn.arr);
      const trk = tracks[ti];
      if (!trk) return;

      const highlighted = !selectedDep || selectedDep === conn.dep;
      const alpha = highlighted
        ? (depRoutes[dri]?.selected && arrRoutes[ari]?.selected ? 0.65 : 0.08)
        : 0.03;
      const bw = Math.max(2, (conn.value / 40) * 12);

      band(rects[0].right, itemY(di,  deps.length),      rects[1].left, itemY(dri, depRoutes.length), trk.col, alpha, bw);
      band(rects[1].right, itemY(dri, depRoutes.length), rects[2].left, itemY(ti,  tracks.length),    trk.col, alpha, bw);
      band(rects[2].right, itemY(ti,  tracks.length),    rects[3].left, itemY(ari, arrRoutes.length), trk.col, alpha, bw);
      band(rects[3].right, itemY(ari, arrRoutes.length), rects[4].left, itemY(ai,  arrs.length),      trk.col, alpha, bw);
    });
  }, [data, colPositions, selectedDep]);

  const Popover = ({ id, type, value }) => {
    const change = d => type === 'dep' ? updateDepRoute(id, d) : updateArrRoute(id, d);
    return (
      <div className="planner__popover" onClick={e => e.stopPropagation()}>
        <button className="planner__slot-btn" onClick={() => change(-10)}>-10</button>
        <button className="planner__slot-btn" onClick={() => change(-1)}>-1</button>
        <input type="number" className="planner__slot-input"
          style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
          value={value}
          onChange={e => {
            const v = parseInt(e.target.value);
            if (!isNaN(v)) setData(prev => ({
              ...prev,
              [type === 'dep' ? 'depRoutes' : 'arrRoutes']: prev[type === 'dep' ? 'depRoutes' : 'arrRoutes']
                .map(r => r.id === id ? { ...r, value: Math.max(0, v) } : r),
            }));
          }} />
        <button className="planner__slot-btn" onClick={() => change(1)}>+1</button>
        <button className="planner__slot-btn" onClick={() => change(10)}>+10</button>
      </div>
    );
  };

  const liveTrackSlots = {};
  connections.forEach(c => { liveTrackSlots[c.track] = (liveTrackSlots[c.track] || 0) + c.value; });

  const revStr = simVersion !== null ? `${simVersion}.${plannerRevisions}` : '—';

  return (
    <div className="planner" data-theme={theme} onClick={() => setSelectedDep(null)}>

      {loading && <div className="planner__loading">Loading…</div>}

      <div className="planner__toasts">
        {toasts.map(t => (
          <div key={t.id} className={`planner__toast planner__toast--${t.type}`}>
            <span className="planner__toast-msg">{t.message}</span>
            <button className="planner__toast-close" onClick={() => dismissToast(t.id)}>✕</button>
          </div>
        ))}
      </div>

      <div className="planner__topbar">
        <h2 className="planner__title">CTP Slot Planner</h2>
        <div className="planner__topbar-right">
          <div className="planner__start-time">
            <span className="planner__meta-label">Start Time</span>
            <TimeInput value={startTime} onChange={setStartTime} />
          </div>
          <span className="planner__meta-label">
            Rev <strong className="planner__rev-value">{revStr}</strong>
          </span>
          <button className="planner__btn"                onClick={() => submitToBackend('calculate')}>Calculate Slots</button>
          <button className="planner__btn planner__btn--sim" onClick={() => submitToBackend('simulate')}>Simulate Slots</button>
          <button
            className="planner__btn planner__btn--theme"
            title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
            onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
          >
            {theme === 'light' ? '☾' : '☀'}
          </button>
        </div>
      </div>

      <div className="planner__control-bar" onClick={e => e.stopPropagation()}>

        {selectedDep && (
          <div className="planner__editing-label">
            <span className="planner__editing-dot" />
            Editing: <strong>{selectedDep}</strong>
          </div>
        )}

        <div className="search-container">
          <input
            type="text"
            placeholder="Search slots..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search-input"
          />
        </div>

        <div className="planner__control-add">
          <select value={newRoute.dep}
            onChange={e => setNewRoute(r => ({ ...r, dep: e.target.value }))}>
            <option value="">Departure</option>
            {deps.map(d => <option key={d.id} value={d.id}>{d.id}</option>)}
          </select>
          <select value={newRoute.depRoute}
            onChange={e => setNewRoute(r => ({ ...r, depRoute: e.target.value }))}>
            <option value="">Dep Route</option>
            {depRoutes.map(r => <option key={r.id} value={r.id}>{r.id}</option>)}
          </select>
          <select value={newRoute.track}
            onChange={e => setNewRoute(r => ({ ...r, track: e.target.value }))}>
            <option value="">Track</option>
            {tracks.map(t => <option key={t.id} value={t.id}>{t.id}</option>)}
          </select>
          <select value={newRoute.arrRoute}
            onChange={e => setNewRoute(r => ({ ...r, arrRoute: e.target.value }))}>
            <option value="">Arr Route</option>
            {arrRoutes.map(r => <option key={r.id} value={r.id}>{r.id}</option>)}
          </select>
          <select value={newRoute.arr}
            onChange={e => setNewRoute(r => ({ ...r, arr: e.target.value }))}>
            <option value="">Arrival</option>
            {arrs.map(a => <option key={a.id} value={a.id}>{a.id}</option>)}
          </select>
          <input className="planner__ctrl-num" type="number" min={0}
            value={newRoute.value}
            onChange={e => setNewRoute(r => ({ ...r, value: parseInt(e.target.value) || 0 }))} />
          <button className="planner__btn" onClick={addConnection}>Add</button>
        </div>

        {selectedDep && selectedDepConns.length > 0 && (
          <div className="planner__brace-section">

            <div className="planner__brace-col" style={{ width: BRACE_COL_W, minHeight: braceHeight }}>
              <TimeInput
                value={getDepTime(selectedDep)}
                onChange={(t) => handleDepTimeChange(selectedDep, t)}
                className="planner__brace-time"
                style={{ top: Math.max(0, braceHeight / 2 - 14) }}
              />
              <div className="planner__brace-svg-wrap">
                <CurlyBrace height={braceHeight} />
              </div>
            </div>

            {/* Edit rows */}
            <div className="planner__control-edit" ref={editRef}>
              {selectedDepConns.map((c, idx) => {
                const label = String.fromCharCode(65 + idx);
                const col   = trackCol(c.track);
                return (
                  <div key={`${c.depRoute}-${c.track}-${c.arrRoute}-${c.arr}`}
                    className="planner__control-row">
                    <span className="planner__conn-label" style={{ background: col }}>{label}</span>
                    <select value={c.depRoute}  onChange={e => editConn(c, 'depRoute',  e.target.value)}>
                      {depRoutes.map(r => <option key={r.id} value={r.id}>{r.id}</option>)}
                    </select>
                    <select value={c.track}     onChange={e => editConn(c, 'track',     e.target.value)}>
                      {tracks.map(t => <option key={t.id} value={t.id}>{t.id}</option>)}
                    </select>
                    <select value={c.arrRoute}  onChange={e => editConn(c, 'arrRoute',  e.target.value)}>
                      {arrRoutes.map(r => <option key={r.id} value={r.id}>{r.id}</option>)}
                    </select>
                    <select value={c.arr}       onChange={e => editConn(c, 'arr',       e.target.value)}>
                      {arrs.map(a => <option key={a.id} value={a.id}>{a.id}</option>)}
                    </select>
                    <input className="planner__ctrl-num" type="number" value={c.value}
                      onChange={e => editConn(c, 'value', parseInt(e.target.value) || 0)} />
                    <button className="planner__slot-btn planner__slot-btn--remove"
                      onClick={() => removeConnection(c)}>✕</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── Sankey grid ── */}
      <div className="planner__grid" ref={gridRef} onClick={e => e.stopPropagation()}>
        <svg ref={svgRef} className="planner__svg" />

        {/* Departure */}
        <div className="col planner__col">
          <div className="planner__header">Departure</div>
          {deps.map(dep => {
            const isSel   = selectedDep === dep.id;
            const depConns = isSel ? selectedDepConns : [];
            return (
              <div key={dep.id}
                className={`planner__cell planner__cell--dep${isSel ? ' planner__cell--selected' : ''}${!isSel && selectedDep ? ' planner__cell--dimmed' : ''}`}
                style={{ height: totalContentHeight / deps.length }}
                onClick={e => { e.stopPropagation(); setSelectedDep(isSel ? null : dep.id); }}>
                <span className="planner__cell-name">{dep.id}</span>
                {isSel && depConns.length > 0 && (
                  <div className="planner__label-cluster">
                    {depConns.map((c, idx) => (
                      <span key={idx} className="planner__conn-label"
                        style={{ background: trackCol(c.track) }}>
                        {String.fromCharCode(65 + idx)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Dep Routes */}
        <div className="col planner__col planner__col--route">
          <div className="planner__header planner__header--center">Route</div>
          {depRoutes.map((route, ri) => {
            const rk         = `dep-${ri}`;
            const isHov      = hoveredRoute === rk;
            const routeConns = selectedDepConns.filter(c => c.depRoute === route.id);
            const isConn     = selectedDep && routeConns.length > 0;
            const opacity    = !selectedDep ? 1 : isConn ? 1 : 0.35;
            return (
              <div key={route.id} className="planner__route-row"
                style={{ height: totalContentHeight / depRoutes.length, opacity }}>
                <span className="planner__route-name">{route.id}</span>
                <div className="planner__route-right">
                  {routeConns.map(c => (
                    <span key={`${c.track}-${c.arrRoute}`}
                      className="planner__conn-label planner__conn-label--rm"
                      style={{ background: trackCol(c.track) }}
                      title={`Connection ${connLabel(c)} — click to remove`}
                      onClick={e => { e.stopPropagation(); removeConnection(c); }}>
                      {connLabel(c)}
                    </span>
                  ))}
                  <span className="planner__route-cap"
                    onMouseEnter={() => setHoveredRoute(rk)}
                    onMouseLeave={() => setHoveredRoute(null)}>
                    {route.value}
                    {isHov && <Popover id={route.id} type="dep" value={route.value} />}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Track */}
        <div className="col planner__col">
          <div className="planner__header planner__header--center">Track</div>
          {tracks.map(track => {
            const tc      = selectedDepConns.filter(c => c.track === track.id);
            const isActive = !selectedDep || connections.some(c => c.dep === selectedDep && c.track === track.id);
            return (
              <div key={track.id} className="planner__cell planner__cell--track"
                style={{ height: totalContentHeight / tracks.length, opacity: isActive ? 1 : 0.15 }}>
                <span style={{ fontWeight: 700, fontSize: 26, color: track.col, lineHeight: 1 }}>{track.id}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: track.col }}>{liveTrackSlots[track.id] || 0}</span>
                {selectedDep && tc.length > 0 && (
                  <div className="planner__label-cluster">
                    {tc.map(c => (
                      <span key={`${c.depRoute}-${c.arrRoute}`}
                        className="planner__conn-label" style={{ background: track.col }}>
                        {connLabel(c)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Arr Routes */}
        <div className="col planner__col planner__col--route">
          <div className="planner__header planner__header--center">Route</div>
          {arrRoutes.map((route, ri) => {
            const rk         = `arr-${ri}`;
            const isHov      = hoveredRoute === rk;
            const routeConns = selectedDepConns.filter(c => c.arrRoute === route.id);
            const isActive   = !selectedDep || connections.some(c => c.dep === selectedDep && c.arrRoute === route.id);
            return (
              <div key={route.id} className="planner__route-row"
                style={{ height: totalContentHeight / arrRoutes.length, opacity: isActive ? 1 : 0.15 }}>
                <span className="planner__route-name">{route.id}</span>
                <div className="planner__route-right">
                  {routeConns.map(c => (
                    <span key={`${c.track}-${c.depRoute}`}
                      className="planner__conn-label planner__conn-label--rm"
                      style={{ background: trackCol(c.track) }}
                      title={`Connection ${connLabel(c)} — click to remove`}
                      onClick={e => { e.stopPropagation(); removeConnection(c); }}>
                      {connLabel(c)}
                    </span>
                  ))}
                  <span className="planner__route-cap"
                    onMouseEnter={() => setHoveredRoute(rk)}
                    onMouseLeave={() => setHoveredRoute(null)}>
                    {route.value}
                    {isHov && <Popover id={route.id} type="arr" value={route.value} />}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Arrival */}
        <div className="col planner__col">
          <div className="planner__header planner__header--right">Arrival</div>
          {arrs.map(arr => {
            const ac      = selectedDepConns.filter(c => c.arr === arr.id);
            const isActive = !selectedDep || connections.some(c => c.dep === selectedDep && c.arr === arr.id);
            return (
              <div key={arr.id} className="planner__cell planner__cell--right"
                style={{ height: totalContentHeight / arrs.length, opacity: isActive ? 1 : 0.15 }}>
                {selectedDep && ac.map(c => (
                  <span key={`${c.track}-${c.depRoute}`}
                    className="planner__conn-label" style={{ background: trackCol(c.track) }}>
                    {connLabel(c)}
                  </span>
                ))}
                <span className="planner__cell-name">{arr.id}</span>
              </div>
            );
          })}
        </div>

      </div>
    </div>
  );
}