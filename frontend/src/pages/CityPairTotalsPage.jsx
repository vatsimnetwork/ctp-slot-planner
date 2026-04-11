import React, { useMemo } from 'react';

const PREF_NONE = 0;
const PREF_DEFERRED = 1;
const PREF_PREFERRED = 2;

const PREF_LABEL = { [PREF_DEFERRED]: 'D', [PREF_PREFERRED]: 'P' };

export default function CityPairTotalsPage({ data, setupData, deferredPairs, onToggleDeferred }) {
  const { deps, depRoutesByDep, tracksByDepRoute, arrRoutesByTrack, arrByArrRoute, defaultCaps } = setupData;

  const arrAirports = useMemo(() =>
    [...new Set(Object.values(arrByArrRoute))].sort()
  , [arrByArrRoute]);

  const reachablePairs = useMemo(() => {
    const pairs = new Set();
    for (const dep of deps) {
      for (const depRoute of (depRoutesByDep[dep] || [])) {
        for (const track of (tracksByDepRoute[depRoute] || [])) {
          for (const arrRoute of (arrRoutesByTrack[track] || [])) {
            const arr = arrByArrRoute[arrRoute];
            if (arr) pairs.add(`${dep}|${arr}`);
          }
        }
      }
    }
    return pairs;
  }, [deps, arrAirports, depRoutesByDep, tracksByDepRoute, arrRoutesByTrack, arrByArrRoute]);

  const pairTotals = useMemo(() => {
    const map = {};
    for (const conn of (data.connections || [])) {
      const key = `${conn.dep}|${conn.arr}`;
      map[key] = (map[key] || 0) + (conn.value || 0);
    }
    return map;
  }, [data.connections]);

  const depSums = useMemo(() => {
    const sums = {};
    for (const [key, val] of Object.entries(pairTotals)) {
      const dep = key.split('|')[0];
      sums[dep] = (sums[dep] || 0) + val;
    }
    return sums;
  }, [pairTotals]);

  const arrSums = useMemo(() => {
    const sums = {};
    for (const [key, val] of Object.entries(pairTotals)) {
      const arr = key.split('|')[1];
      sums[arr] = (sums[arr] || 0) + val;
    }
    return sums;
  }, [pairTotals]);

  const grandTotal = useMemo(() => Object.values(pairTotals).reduce((a, b) => a + b, 0), [pairTotals]);

  const depCapTotal = useMemo(() =>
    deps.reduce((s, d) => s + (defaultCaps.deps[d] ?? 0), 0)
  , [deps, defaultCaps]);

  const arrCapTotal = useMemo(() =>
    arrAirports.reduce((s, a) => s + (defaultCaps.arrs[a] ?? 0), 0)
  , [arrAirports, defaultCaps]);

  const maxPossible = Math.min(depCapTotal, arrCapTotal);

  const routingsPerPair = useMemo(() => {
    const map = {};
    for (const conn of (data.connections || [])) {
      const key = `${conn.dep}|${conn.arr}`;
      map[key] = (map[key] || 0) + 1;
    }
    return map;
  }, [data.connections]);

  const numPairsWithSlots  = Object.keys(pairTotals).filter(k => (pairTotals[k] || 0) > 0).length;
  const totalRoutings      = (data.connections || []).length;
  const numPairsWithRoutes = Object.keys(routingsPerPair).length;
  const avgRoutings        = numPairsWithRoutes > 0 ? (totalRoutings / numPairsWithRoutes) : 0;
  const maxRoutings        = numPairsWithRoutes > 0 ? Math.max(...Object.values(routingsPerPair)) : 0;
  const slotsRemaining     = maxPossible - grandTotal;
  const slotsPct           = maxPossible > 0 ? Math.round((grandTotal / maxPossible) * 100) : 0;
  const pairsPct           = reachablePairs.size > 0 ? Math.round((numPairsWithSlots / reachablePairs.size) * 100) : 0;

  const deferredCount = deferredPairs ? [...deferredPairs.values()].filter(p => p === PREF_DEFERRED).length : 0;
  const preferredCount = deferredPairs ? [...deferredPairs.values()].filter(p => p === PREF_PREFERRED).length : 0;

  return (
    <div className="cpt">
      <div className="cpt__scroll-wrap">
        <table className="cpt__table">
          <thead>
            <tr>
              <th className="cpt__corner">
                <span className="cpt__corner-dep">&darr; Departure</span>
                <span className="cpt__corner-arr">Arrival &rarr;</span>
              </th>
              {arrAirports.map(arr => (
                <th key={arr} className="cpt__arr-head">{arr}</th>
              ))}
              <th className="cpt__summary-head cpt__summary-head--first">Assigned</th>
              <th className="cpt__summary-head">Capacity</th>
              <th className="cpt__summary-head">Remaining</th>
            </tr>
          </thead>
          <tbody>
            {deps.map(dep => {
              const depCap       = defaultCaps.deps[dep] ?? null;
              const depAssigned  = depSums[dep] ?? 0;
              const depRemaining = depCap !== null ? depCap - depAssigned : null;
              return (
                <tr key={dep}>
                  <td className="cpt__dep-label">{dep}</td>
                  {arrAirports.map(arr => {
                    const key      = `${dep}|${arr}`;
                    const possible = reachablePairs.has(key);
                    const val      = pairTotals[key] ?? 0;
                    const pref     = deferredPairs ? (deferredPairs.get(key) ?? PREF_NONE) : PREF_NONE;
                    if (!possible) return <td key={arr} className="cpt__cell cpt__cell--impossible"></td>;
                    const isDeferred  = pref === PREF_DEFERRED;
                    const isPreferred = pref === PREF_PREFERRED;
                    let cellClass = `cpt__cell ${val === 0 ? 'cpt__cell--zero' : 'cpt__cell--value'}`;
                    if (isDeferred)  cellClass += ' cpt__cell--deferred';
                    if (isPreferred)  cellClass += ' cpt__cell--preferred';
                    let title = '';
                    if (onToggleDeferred) {
                      if (pref === PREF_NONE)       title = 'Click to mark departures';
                      else if (pref === PREF_DEFERRED)  title = 'Deferred — departures pushed to end of window (click to make preferred)';
                      else if (pref === PREF_PREFERRED) title = 'Preferred — departures at start of window (click to clear)';
                    }
                    return (
                      <td key={arr}
                        className={cellClass}
                        onClick={onToggleDeferred ? () => onToggleDeferred(key) : undefined}
                        style={onToggleDeferred ? { cursor: 'pointer' } : undefined}
                        title={title}
                      >
                        {val}{PREF_LABEL[pref] || ''}
                      </td>
                    );
                  })}
                  <td className="cpt__summary-cell cpt__summary-cell--first">{depAssigned}</td>
                  <td className="cpt__summary-cell">{depCap ?? '\u2014'}</td>
                  <td className={`cpt__summary-cell${depRemaining !== null && depRemaining < 0 ? ' cpt__summary-cell--over' : ''}`}>
                    {depRemaining !== null ? depRemaining : '\u2014'}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="cpt__footer-row cpt__footer-row--assigned">
              <td className="cpt__footer-label">Assigned</td>
              {arrAirports.map(arr => (
                <td key={arr} className="cpt__footer-cell">{arrSums[arr] ?? 0}</td>
              ))}
              <td className="cpt__grand-total" colSpan={3} rowSpan={3}>
                <span className="cpt__grand-total-label">Total Slots</span>
                <span className="cpt__grand-total-value">{grandTotal}</span>
              </td>
            </tr>
            <tr className="cpt__footer-row">
              <td className="cpt__footer-label">Capacity</td>
              {arrAirports.map(arr => (
                <td key={arr} className="cpt__footer-cell">{defaultCaps.arrs[arr] ?? '\u2014'}</td>
              ))}
            </tr>
            <tr className="cpt__footer-row">
              <td className="cpt__footer-label">Remaining</td>
              {arrAirports.map(arr => {
                const cap      = defaultCaps.arrs[arr] ?? null;
                const assigned = arrSums[arr] ?? 0;
                const rem      = cap !== null ? cap - assigned : null;
                return (
                  <td key={arr} className={`cpt__footer-cell${rem !== null && rem < 0 ? ' cpt__footer-cell--over' : ''}`}>
                    {rem !== null ? rem : '\u2014'}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>

      {grandTotal > 0 && (
        <div className="cpt__stats">
          <div className="cpt__stats-row">
            <span className="cpt__stats-label">Possible slots allocated:</span>
            <span className="cpt__stats-value">
              {grandTotal} / {maxPossible} ({slotsRemaining >= 0 ? slotsRemaining : 0} remaining) | {slotsPct}%
            </span>
          </div>
          <div className="cpt__stats-row">
            <span className="cpt__stats-label">Number of city pairs:</span>
            <span className="cpt__stats-value">
              {numPairsWithSlots} / {reachablePairs.size} | {pairsPct}%
            </span>
          </div>
          <div className="cpt__stats-row">
            <span className="cpt__stats-label">Total number of routings:</span>
            <span className="cpt__stats-value">{totalRoutings}</span>
          </div>
          <div className="cpt__stats-row">
            <span className="cpt__stats-label">Average routings per city pair:</span>
            <span className="cpt__stats-value">
              {avgRoutings.toFixed(1)} (highest: {maxRoutings})
            </span>
          </div>
          {(deferredCount > 0 || preferredCount > 0) && (
            <div className="cpt__stats-row">
              <span className="cpt__stats-label">Departure preferences:</span>
              <span className="cpt__stats-value">
                {deferredCount > 0 && <span>Deferred: {deferredCount}</span>}
                {deferredCount > 0 && preferredCount > 0 && <span> · </span>}
                {preferredCount > 0 && <span>Preferred: {preferredCount}</span>}
              </span>
            </div>
          )}
        </div>
      )}

      {onToggleDeferred && (
        <div className="cpt__legend">
          <span className="cpt__legend-swatch cpt__legend-swatch--deferred"></span>
          <span className="cpt__legend-text">Deferred — pushed to end of window</span>
          <span className="cpt__legend-sep">·</span>
          <span className="cpt__legend-swatch cpt__legend-swatch--preferred"></span>
          <span className="cpt__legend-text">Preferred — at start of window</span>
          <span className="cpt__legend-sep">·</span>
          <span className="cpt__legend-text">Click cell to cycle: none → deferred → preferred → none</span>
        </div>
      )}
    </div>
  );
}
