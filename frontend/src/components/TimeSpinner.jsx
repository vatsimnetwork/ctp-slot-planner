import React from 'react';
import { parseTime, formatTime } from '../utils.js';

export default function TimeSpinner({ value, onChange, style, className }) {
  const { h, m } = parseTime(value);
  const setH = (d) => onChange(formatTime({ h: ((h + d) % 24 + 24) % 24, m }));
  const setM = (d) => {
    let nm = m + d, nh = h;
    if (nm >= 60) { nm -= 60; nh = (nh + 1) % 24; }
    if (nm < 0)   { nm += 60; nh = ((nh - 1) % 24 + 24) % 24; }
    onChange(formatTime({ h: nh, m: nm }));
  };
  const Arr = ({ onClick, dir }) => (
    <button className="planner__time-arrow" type="button" tabIndex={-1} onClick={e => { e.stopPropagation(); onClick(); }}>
      {dir === 'up' ? '▲' : '▼'}
    </button>
  );
  return (
    <div className={`planner__time-spinner${className ? ' ' + className : ''}`} style={style} onClick={e => e.stopPropagation()}>
      <div className="planner__time-col">
        <Arr onClick={() => setH(1)} dir="up"/>
        <span className="planner__time-seg">{String(h).padStart(2, '0')}</span>
        <Arr onClick={() => setH(-1)} dir="down"/>
      </div>
      <span className="planner__time-sep">:</span>
      <div className="planner__time-col">
        <Arr onClick={() => setM(1)} dir="up"/>
        <span className="planner__time-seg">{String(m).padStart(2, '0')}</span>
        <Arr onClick={() => setM(-1)} dir="down"/>
      </div>
      <span className="planner__time-z">z</span>
    </div>
  );
}
