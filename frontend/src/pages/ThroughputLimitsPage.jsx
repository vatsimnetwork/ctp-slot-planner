import React, { useEffect, useState, useMemo } from 'react';
import { API } from '../api.js';

function UsageBar({ used, limit, departureHours }) {
  const isUnlimited = limit == null || limit >= 65535;
  if (isUnlimited) {
    if (!used) return null;
    const acph = Math.round(used / departureHours);
    return <span className="tl-usage-val">{used} ({acph}/hr)</span>;
  }
  const pct    = Math.round((used / limit) * 100);
  const barPct = Math.min(100, pct);
  const over   = used > limit;
  const acph   = Math.round(used / departureHours);
  const diff   = used - limit;
  const diffStr = (diff >= 0 ? '+' : '') + diff;
  return (
    <div className="tl-usage-bar__wrap">
      <div className="tl-usage-bar" style={{ '--pct': `${barPct}%`, '--bar-color': over ? 'var(--danger)' : pct > 80 ? 'var(--warning)' : 'var(--accent)' }} />
      <span className={`tl-usage-val${over ? ' tl-usage-val--over' : ''}`}>
        {pct}% - {acph}/hr ({used}: {diffStr})
      </span>
    </div>
  );
}

function SortHeader({ label, col, sort, onSort }) {
  const active = sort.col === col;
  const indicator = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ' ↕';
  return (
    <th
      className={`tl-sort-header${active ? ' tl-sort-header--active' : ''}`}
      onClick={() => onSort(col)}
      style={{ cursor: 'pointer', userSelect: 'none' }}
    >
      {label}<span className="tl-sort-indicator">{indicator}</span>
    </th>
  );
}

function applySortTags(items, sort, tagUsage) {
  return [...items].sort((a, b) => {
    let cmp = 0;
    if (sort.col === 'name') {
      cmp = a.tag.localeCompare(b.tag);
    } else if (sort.col === 'limit') {
      const aVal = (a.maximumAircraftPerHour == null || a.maximumAircraftPerHour >= 65535) ? Infinity : a.maximumAircraftPerHour;
      const bVal = (b.maximumAircraftPerHour == null || b.maximumAircraftPerHour >= 65535) ? Infinity : b.maximumAircraftPerHour;
      cmp = aVal - bVal;
    } else if (sort.col === 'maxSlots') {
      const aAcph = a.maximumAircraftPerHour;
      const bAcph = b.maximumAircraftPerHour;
      const aVal = (aAcph == null || aAcph >= 65535) ? Infinity : aAcph;
      const bVal = (bAcph == null || bAcph >= 65535) ? Infinity : bAcph;
      cmp = aVal - bVal;
    } else if (sort.col === 'usage') {
      cmp = (tagUsage[a.tag] || 0) - (tagUsage[b.tag] || 0);
    }
    return sort.dir === 'asc' ? cmp : -cmp;
  });
}

function applySortSectors(items, sort, sectorUsage) {
  return [...items].sort((a, b) => {
    let cmp = 0;
    if (sort.col === 'name') {
      cmp = a.identifier.localeCompare(b.identifier);
    } else if (sort.col === 'limit') {
      const aVal = (a.maximumAircraftPerHour == null || a.maximumAircraftPerHour >= 65535) ? Infinity : a.maximumAircraftPerHour;
      const bVal = (b.maximumAircraftPerHour == null || b.maximumAircraftPerHour >= 65535) ? Infinity : b.maximumAircraftPerHour;
      cmp = aVal - bVal;
    } else if (sort.col === 'maxSlots') {
      const aAcph = a.maximumAircraftPerHour;
      const bAcph = b.maximumAircraftPerHour;
      const aVal = (aAcph == null || aAcph >= 65535) ? Infinity : aAcph;
      const bVal = (bAcph == null || bAcph >= 65535) ? Infinity : bAcph;
      cmp = aVal - bVal;
    } else if (sort.col === 'usage') {
      cmp = (sectorUsage[a.identifier] || 0) - (sectorUsage[b.identifier] || 0);
    }
    return sort.dir === 'asc' ? cmp : -cmp;
  });
}

export default function ThroughputLimitsPage({ isStaff, addToast, tagUsage = {}, sectorUsage = {}, departureHours = 3, tagToRoutes = {}, sectorToRoutes = {}, routeSlots = {} }) {
  const [tagLimits, setTagLimits] = useState([]);
  const [sectors,   setSectors]   = useState([]);
  const [saving,    setSaving]    = useState(false);
  const [loaded,    setLoaded]    = useState(false);
  const [tagSearch,       setTagSearch]       = useState('');
  const [sectorSearch,    setSectorSearch]    = useState('');
  const [tagGroupFilter,  setTagGroupFilter]  = useState('');
  const [secGroupFilter,  setSecGroupFilter]  = useState('');
  const [expandedTags,    setExpandedTags]    = useState(new Set());
  const [expandedSectors, setExpandedSectors] = useState(new Set());
  const [tagSort,  setTagSort]  = useState({ col: 'name', dir: 'asc' });
  const [secSort,  setSecSort]  = useState({ col: 'name', dir: 'asc' });

  useEffect(() => {
    API.loadThroughputLimits()
      .then(r => r.ok ? r.json() : Promise.reject(`Load failed (${r.status})`))
      .then(d => { setTagLimits(d.tagLimits || []); setSectors(d.sectors || []); setLoaded(true); })
      .catch(err => addToast(String(err), 'error'));
  }, []);

  const setTagLimit = (tag, value) => {
    const num = value === '' || value === null ? 65535 : Math.min(65535, Math.max(0, Number(value)));
    setTagLimits(prev => prev.map(t => t.tag === tag ? { ...t, maximumAircraftPerHour: num } : t));
  };

  const setSectorLimit = (id, value) => {
    const num = value === '' || value === null ? 65535 : Math.min(65535, Math.max(0, Number(value)));
    setSectors(prev => prev.map(s => s.id === id ? { ...s, maximumAircraftPerHour: num } : s));
  };

  const handleSave = () => {
    setSaving(true);
    API.saveThroughputLimits({
      tagLimits: tagLimits.map(t => ({ tag: t.tag, maximumAircraftPerHour: t.maximumAircraftPerHour ?? 65535 })),
      sectors:   sectors.map(s => ({ id: s.id, maximumAircraftPerHour: s.maximumAircraftPerHour ?? 65535 })),
    })
      .then(r => r.ok ? addToast('Throughput limits saved', 'success') : Promise.reject(`Save failed (${r.status})`))
      .catch(err => addToast(String(err), 'error'))
      .finally(() => setSaving(false));
  };

  const toggleTag    = tag => setExpandedTags(s    => { const n = new Set(s); n.has(tag) ? n.delete(tag) : n.add(tag); return n; });
  const toggleSector = id  => setExpandedSectors(s => { const n = new Set(s); n.has(id)  ? n.delete(id)  : n.add(id);  return n; });

  const handleTagSort = (col) => {
    setTagSort(prev => ({ col, dir: prev.col === col && prev.dir === 'asc' ? 'desc' : 'asc' }));
  };
  const handleSecSort = (col) => {
    setSecSort(prev => ({ col, dir: prev.col === col && prev.dir === 'asc' ? 'desc' : 'asc' }));
  };

  const tagGroups = useMemo(() => {
    const gs = new Set();
    Object.values(tagToRoutes).forEach(routes => routes.forEach(r => { if (r.routeSegmentGroup) gs.add(r.routeSegmentGroup); }));
    return [...gs].sort();
  }, [tagToRoutes]);

  const secGroups = useMemo(() => {
    const gs = new Set();
    Object.values(sectorToRoutes).forEach(routes => routes.forEach(r => { if (r.routeSegmentGroup) gs.add(r.routeSegmentGroup); }));
    return [...gs].sort();
  }, [sectorToRoutes]);

  if (!loaded) return <div className="planner__loading">Loading…</div>;

  const tagQ = tagSearch.trim().toLowerCase();
  const secQ = sectorSearch.trim().toLowerCase();

  const filteredTags = tagLimits.filter(t => {
    if (tagQ && !t.tag.toLowerCase().includes(tagQ)) return false;
    if (tagGroupFilter) {
      const routes = tagToRoutes[t.tag] || [];
      if (!routes.some(r => r.routeSegmentGroup === tagGroupFilter)) return false;
    }
    return true;
  });

  const filteredSectors = sectors.filter(s => {
    if (secQ && !s.identifier.toLowerCase().includes(secQ)) return false;
    if (secGroupFilter) {
      const routes = sectorToRoutes[s.identifier] || [];
      if (!routes.some(r => r.routeSegmentGroup === secGroupFilter)) return false;
    }
    return true;
  });

  const visibleTags    = applySortTags(filteredTags, tagSort, tagUsage);
  const visibleSectors = applySortSectors(filteredSectors, secSort, sectorUsage);

  const fmtLimit = (acph) => (acph == null || acph >= 65535) ? '∞' : String(acph);
  const fmtSlots = (acph) => (acph == null || acph >= 65535) ? '∞' : String(Math.floor(acph * departureHours));

  return (
    <div className="throughput-limits">
      <div className="throughput-limits__tables">

        {/* ── Tag Limits ─────────────────────────────────────────────────── */}
        <div className="throughput-limits__table-wrap">
          <h3 className="throughput-limits__heading">Tag Limits</h3>
          <div className="tl-filters">
            <div className="throughput-limits__search-wrap">
              <input className="throughput-limits__search" type="text" placeholder="Search tags…" value={tagSearch} onChange={e => setTagSearch(e.target.value)} />
              {tagSearch && <button className="throughput-limits__search-clear" onClick={() => setTagSearch('')}>✕</button>}
            </div>
            {tagGroups.length > 0 && (
              <select className="tl-group-filter" value={tagGroupFilter} onChange={e => setTagGroupFilter(e.target.value)}>
                <option value="">All groups</option>
                {tagGroups.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            )}
          </div>
          {visibleTags.length === 0
            ? <p className="throughput-limits__empty">{tagQ || tagGroupFilter ? 'No matching tags.' : 'No tags found on any route for this event.'}</p>
            : (
              <table className="throughput-limits__table">
                <thead>
                  <tr>
                    <th></th>
                    <SortHeader label="Tag"       col="name"    sort={tagSort} onSort={handleTagSort} />
                    <th>Groups</th>
                    <SortHeader label="Max / Hour" col="limit"   sort={tagSort} onSort={handleTagSort} />
                    <SortHeader label="Max Slots"  col="maxSlots" sort={tagSort} onSort={handleTagSort} />
                    <SortHeader label="Usage"      col="usage"   sort={tagSort} onSort={handleTagSort} />
                  </tr>
                </thead>
                <tbody>
                  {visibleTags.map(t => {
                    const routes   = tagToRoutes[t.tag] || [];
                    const groups   = [...new Set(routes.map(r => r.routeSegmentGroup).filter(Boolean))].join(', ') || '—';
                    const acph     = t.maximumAircraftPerHour;
                    const slotLim  = (acph == null || acph >= 65535) ? null : Math.floor(acph * departureHours);
                    const used     = tagUsage[t.tag] || 0;
                    const isOver   = slotLim != null && used > slotLim;
                    const expanded = expandedTags.has(t.tag);
                    return (
                      <React.Fragment key={t.tag}>
                        <tr className={`tl-row${isOver ? ' tl-row--over' : ''}`} onClick={() => toggleTag(t.tag)} style={{ cursor: routes.length ? 'pointer' : 'default' }}>
                          <td className="tl-expand-col">{routes.length > 0 ? (expanded ? '▾' : '▸') : ''}</td>
                          <td className="tl-name">{t.tag}</td>
                          <td className="tl-groups">{groups}</td>
                          <td onClick={e => e.stopPropagation()}>
                            <input
                              className="throughput-limits__input"
                              type="number" min={0} max={65534} disabled={!isStaff}
                              value={(acph == null || acph >= 65535) ? '' : acph}
                              placeholder="∞"
                              onChange={e => setTagLimit(t.tag, e.target.value === '' ? null : e.target.value)}
                            />
                          </td>
                          <td className="tl-slots">{fmtSlots(acph)}</td>
                          <td><UsageBar used={used} limit={slotLim} departureHours={departureHours} /></td>
                        </tr>
                        {expanded && routes.map((r, i) => (
                          <tr key={i} className="tl-subrow">
                            <td></td>
                            <td className="tl-subrow__name" colSpan={2}>{r.identifier}</td>
                            <td className="tl-subrow__group">{r.routeSegmentGroup || '—'}</td>
                            <td colSpan={2} className="tl-subrow__slots">{routeSlots[r.identifier] ?? 0} slots</td>
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            )
          }
        </div>

        {/* ── Sector Limits ──────────────────────────────────────────────── */}
        <div className="throughput-limits__table-wrap">
          <h3 className="throughput-limits__heading">Sector Limits</h3>
          <div className="tl-filters">
            <div className="throughput-limits__search-wrap">
              <input className="throughput-limits__search" type="text" placeholder="Search sectors…" value={sectorSearch} onChange={e => setSectorSearch(e.target.value)} />
              {sectorSearch && <button className="throughput-limits__search-clear" onClick={() => setSectorSearch('')}>✕</button>}
            </div>
            {secGroups.length > 0 && (
              <select className="tl-group-filter" value={secGroupFilter} onChange={e => setSecGroupFilter(e.target.value)}>
                <option value="">All groups</option>
                {secGroups.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            )}
          </div>
          {visibleSectors.length === 0
            ? <p className="throughput-limits__empty">{secQ || secGroupFilter ? 'No matching sectors.' : 'No sectors found for this event.'}</p>
            : (
              <table className="throughput-limits__table">
                <thead>
                  <tr>
                    <th></th>
                    <SortHeader label="Sector"     col="name"    sort={secSort} onSort={handleSecSort} />
                    <th>Groups</th>
                    <SortHeader label="Max / Hour" col="limit"   sort={secSort} onSort={handleSecSort} />
                    <SortHeader label="Max Slots"  col="maxSlots" sort={secSort} onSort={handleSecSort} />
                    <SortHeader label="Usage"      col="usage"   sort={secSort} onSort={handleSecSort} />
                  </tr>
                </thead>
                <tbody>
                  {visibleSectors.map(s => {
                    const routes   = sectorToRoutes[s.identifier] || [];
                    const groups   = [...new Set(routes.map(r => r.routeSegmentGroup).filter(Boolean))].join(', ') || '—';
                    const acph     = s.maximumAircraftPerHour;
                    const slotLim  = (acph == null || acph >= 65535) ? null : Math.floor(acph * departureHours);
                    const used     = sectorUsage[s.identifier] || 0;
                    const isOver   = slotLim != null && used > slotLim;
                    const expanded = expandedSectors.has(s.id);
                    return (
                      <React.Fragment key={s.id}>
                        <tr className={`tl-row${isOver ? ' tl-row--over' : ''}`} onClick={() => toggleSector(s.id)} style={{ cursor: routes.length ? 'pointer' : 'default' }}>
                          <td className="tl-expand-col">{routes.length > 0 ? (expanded ? '▾' : '▸') : ''}</td>
                          <td className="tl-name">{s.identifier}</td>
                          <td className="tl-groups">{groups}</td>
                          <td onClick={e => e.stopPropagation()}>
                            <input
                              className="throughput-limits__input"
                              type="number" min={0} max={65534} disabled={!isStaff}
                              value={(acph == null || acph >= 65535) ? '' : acph}
                              placeholder="∞"
                              onChange={e => setSectorLimit(s.id, e.target.value === '' ? null : e.target.value)}
                            />
                          </td>
                          <td className="tl-slots">{fmtSlots(acph)}</td>
                          <td><UsageBar used={used} limit={slotLim} departureHours={departureHours} /></td>
                        </tr>
                        {expanded && routes.map((r, i) => (
                          <tr key={i} className="tl-subrow">
                            <td></td>
                            <td className="tl-subrow__name" colSpan={2}>{r.identifier}</td>
                            <td className="tl-subrow__group">{r.routeSegmentGroup || '—'}</td>
                            <td colSpan={2} className="tl-subrow__slots">{routeSlots[r.identifier] ?? 0} slots</td>
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            )
          }
        </div>

      </div>
      {isStaff && (
        <button className="planner__btn tl-save-btn" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save Limits'}
        </button>
      )}
    </div>
  );
}
