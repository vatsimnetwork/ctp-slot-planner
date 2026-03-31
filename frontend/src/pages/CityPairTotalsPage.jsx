import React, { useMemo } from 'react';

export default function CityPairTotalsPage({ data, setupData }) {
  const { deps, depRoutesByDep, tracksByDepRoute, arrRoutesByTrack, arrByArrRoute, defaultCaps } = setupData;

  // Derive actual arrival airports from the route graph (setupData.arrs is ALL airports in the system)
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
    for (const dep of deps) {
      sums[dep] = arrAirports.reduce((acc, arr) => {
        const key = `${dep}|${arr}`;
        return reachablePairs.has(key) ? acc + (pairTotals[key] || 0) : acc;
      }, 0);
    }
    return sums;
  }, [deps, arrAirports, pairTotals, reachablePairs]);

  const arrSums = useMemo(() => {
    const sums = {};
    for (const arr of arrAirports) {
      sums[arr] = deps.reduce((acc, dep) => {
        const key = `${dep}|${arr}`;
        return reachablePairs.has(key) ? acc + (pairTotals[key] || 0) : acc;
      }, 0);
    }
    return sums;
  }, [deps, arrAirports, pairTotals, reachablePairs]);

  const grandTotal = useMemo(() => Object.values(pairTotals).reduce((a, b) => a + b, 0), [pairTotals]);

  return (
    <div className="cpt">
      <div className="cpt__scroll-wrap">
        <table className="cpt__table">
          <thead>
            <tr>
              <th className="cpt__corner">
                <span className="cpt__corner-dep">↓ Departure</span>
                <span className="cpt__corner-arr">Arrival →</span>
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
                    if (!possible) return <td key={arr} className="cpt__cell cpt__cell--impossible"></td>;
                    if (val === 0) return <td key={arr} className="cpt__cell cpt__cell--zero">0</td>;
                    return <td key={arr} className="cpt__cell cpt__cell--value">{val}</td>;
                  })}
                  <td className="cpt__summary-cell cpt__summary-cell--first">{depAssigned}</td>
                  <td className="cpt__summary-cell">{depCap ?? '—'}</td>
                  <td className={`cpt__summary-cell${depRemaining !== null && depRemaining < 0 ? ' cpt__summary-cell--over' : ''}`}>
                    {depRemaining !== null ? depRemaining : '—'}
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
                <td key={arr} className="cpt__footer-cell">{defaultCaps.arrs[arr] ?? '—'}</td>
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
                    {rem !== null ? rem : '—'}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
