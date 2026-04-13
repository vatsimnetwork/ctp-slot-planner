import React, { useMemo, useState, useCallback } from 'react';
import TimeWindowEditor from '../components/TimeWindowEditor';

function editorToShift(w, hours) {
  const startShift = w.startOffset / 60;
  const endShift = (w.endOffset - hours * 60) / 60;
  return { startShift, endShift };
}

function computeInitialFromShift(shift, hours) {
  if (!shift) return null;
  return {
    startOffset: shift.startShift * 60,
    endOffset: hours * 60 + shift.endShift * 60,
  };
}

export default function CityPairTotalsPage({ data, setupData, airportWindowShifts, updatePairShift, departureTimeWindowHours }) {
  const { deps, depRoutesByDep, tracksByDepRoute, arrRoutesByTrack, arrByArrRoute, defaultCaps } = setupData;
  const [selectedPair, setSelectedPair] = useState(null);

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

  const shiftedCount = airportWindowShifts ? airportWindowShifts.size : 0;

  const handleEditorChange = useCallback((w) => {
    if (!selectedPair || !updatePairShift) return;
    const shift = editorToShift(w, departureTimeWindowHours);
    if (Math.abs(shift.startShift) < 1e-9 && Math.abs(shift.endShift) < 1e-9) {
      updatePairShift(selectedPair, null);
    } else {
      updatePairShift(selectedPair, shift);
    }
  }, [selectedPair, updatePairShift, departureTimeWindowHours]);

  const refWindow = { startOffset: 0, endOffset: departureTimeWindowHours * 60 };

  return (
    <div className="cpt">
      <div className="cpt__layout">
        <div className="cpt__table-side">
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
                        const shift    = airportWindowShifts ? airportWindowShifts.get(key) : null;
                        const hasShift = shift && (shift.startShift !== 0 || shift.endShift !== 0);
                        if (!possible) return <td key={arr} className="cpt__cell cpt__cell--impossible"></td>;
                        let cellClass = `cpt__cell ${val === 0 ? 'cpt__cell--zero' : 'cpt__cell--value'}`;
                        if (selectedPair === key) cellClass += ' cpt__cell--selected';
                        return (
                          <td key={arr}
                            className={cellClass}
                            onClick={updatePairShift ? () => setSelectedPair(prev => prev === key ? null : key) : undefined}
                            style={updatePairShift ? { cursor: 'pointer', position: 'relative' } : { position: 'relative' }}
                            title={`${dep} → ${arr}`}
                          >
                            {val}
                            {hasShift && <span className="cpt__cell-marker" />}
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
              {shiftedCount > 0 && (
                <div className="cpt__stats-row">
                  <span className="cpt__stats-label">Window-shifted pairs:</span>
                  <span className="cpt__stats-value">{shiftedCount}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {selectedPair && updatePairShift && (
          <div className="cpt__editor-panel">
            <div className="cpt__editor-panel-header">
              <strong>{selectedPair.replace('|', ' → ')}</strong>
              <button className="cpt__editor-close" onClick={() => setSelectedPair(null)}>✕</button>
            </div>
            <TimeWindowEditor
              key={selectedPair}
              referenceWindow={refWindow}
              initialWindow={computeInitialFromShift(airportWindowShifts?.get(selectedPair), departureTimeWindowHours)}
              minDuration={30}
              globalMinOffset={-120}
              globalMaxOffset={departureTimeWindowHours * 60 + 120}
              onChange={handleEditorChange}
            />
          </div>
        )}
      </div>
    </div>
  );
}
