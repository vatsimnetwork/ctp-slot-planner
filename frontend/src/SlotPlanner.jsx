import { useEffect, useRef, useState, useLayoutEffect } from "react";
import * as d3 from "d3";
import "./SlotPlanner.css";

const AIRPORT_PAIRS = [
  {
    dep: 'CYQX',
    arr: 'EGLL',
    tracks: [
      { id:'A', col:'#2783C5', depToStart: { value:12, cap:30 }, startToEnd: { value:11, cap:12 }, endToArr: { value:10, cap:11 } },
    ]
  },
  {
    dep: 'CYYR',
    arr: 'EINN',
    tracks: [
      { id:'B', col:'#29B473', depToStart: { value:18, cap:30 }, startToEnd: { value:17, cap:18 }, endToArr: { value:16, cap:17 } },
    ]
  },
  {
    dep: 'KBOS',
    arr: 'EGLL',
    tracks: [
      { id:'C', col:'#2A3B90', depToStart: { value:28, cap:30 }, startToEnd: { value:26, cap:28 }, endToArr: { value:25, cap:26 } },
      { id:'D', col:'#2783C5', depToStart: { value:22, cap:30 }, startToEnd: { value:20, cap:22 }, endToArr: { value:19, cap:20 } },
    ]
  },
  {
    dep: 'KJFK',
    arr: 'EGLL',
    tracks: [
      { id:'E', col:'#29B473', depToStart: { value:30, cap:30 }, startToEnd: { value:28, cap:30 }, endToArr: { value:27, cap:28 } },
      { id:'F', col:'#2A3B90', depToStart: { value:25, cap:30 }, startToEnd: { value:23, cap:25 }, endToArr: { value:22, cap:23 } },
    ]
  },
];

const HEADER_H = 47;
const ROW_H = 53;

const allTracks = AIRPORT_PAIRS.flatMap(p => p.tracks.map(t => ({ ...t, dep: p.dep, arr: p.arr })));

const getPairYCenter = (pair) => {
  const firstIdx = allTracks.findIndex(t => t.dep === pair.dep && t.id === pair.tracks[0].id);
  const lastIdx  = allTracks.findIndex(t => t.dep === pair.dep && t.id === pair.tracks[pair.tracks.length - 1].id);
  const yFirst   = HEADER_H + firstIdx * ROW_H + ROW_H / 2;
  const yLast    = HEADER_H + lastIdx  * ROW_H + ROW_H / 2;
  return (yFirst + yLast) / 2;
};

export default function SlotPlanner() {
  const [pairs, setPairs] = useState(AIRPORT_PAIRS);
  const [selectedDep, setSelectedDep] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editVal, setEditVal] = useState('');
  const svgRef = useRef(null);
  const gridRef = useRef(null);
  const [colPositions, setColPositions] = useState(null);

  const flatTracks = pairs.flatMap(p => p.tracks.map(t => ({ ...t, dep: p.dep, arr: p.arr })));

  const startEdit = (pairIdx, trackId, segment, value, cap) => {
    setEditing({ pairIdx, trackId, segment });
    setEditVal(`${value}/${cap}`);
  };

  const commitEdit = () => {
    if (!editing) return;
    const [v, c] = editVal.split('/').map(Number);
    if (!isNaN(v) && !isNaN(c) && c > 0) {
      setPairs(prev => prev.map((p, i) => i !== editing.pairIdx ? p : {
        ...p,
        tracks: p.tracks.map(t => t.id === editing.trackId ? {
          ...t,
          [editing.segment]: { value: Math.min(v, c), cap: c }
        } : t)
      }));
    }
    setEditing(null);
  };

  useLayoutEffect(() => {
    if (!gridRef.current) return;
    const update = () => {
      const containerRect = gridRef.current.getBoundingClientRect();
      const cols = gridRef.current.querySelectorAll('.col');
      const rects = Array.from(cols).map(c => {
        const r = c.getBoundingClientRect();
        return { left: r.left - containerRect.left, right: r.right - containerRect.left };
      });
      setColPositions({ rects, totalWidth: containerRect.width, totalHeight: containerRect.height });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [pairs]);

  useEffect(() => {
    if (!svgRef.current || !colPositions) return;
    const { rects, totalWidth, totalHeight } = colPositions;
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();
    svg.attr("width", totalWidth).attr("height", totalHeight);

    pairs.forEach(pair => {
      const pairYCenter = getPairYCenter(pair);
      const isHighlighted = !selectedDep || selectedDep === pair.dep;

      pair.tracks.forEach(t => {
        const trackIdx = flatTracks.findIndex(ft => ft.id === t.id);
        const trackYCenter = HEADER_H + trackIdx * ROW_H + ROW_H / 2;

        const drawBand = (x1, y1, x2, y2, seg) => {
          const bw = Math.max((seg.value / seg.cap) * (ROW_H * 0.6), 3);
          const mx = (x1 + x2) / 2;
          const path = `
            M ${x1} ${y1 - bw / 2}
            C ${mx} ${y1 - bw / 2}, ${mx} ${y2 - bw / 2}, ${x2} ${y2 - bw / 2}
            L ${x2} ${y2 + bw / 2}
            C ${mx} ${y2 + bw / 2}, ${mx} ${y1 + bw / 2}, ${x1} ${y1 + bw / 2}
            Z
          `;
          svg.append("path").attr("d", path).attr("fill", t.col)
            .attr("opacity", isHighlighted ? 0.55 : 0.05);
        };

        drawBand(rects[0].right, pairYCenter, rects[1].left, trackYCenter, t.depToStart);
        drawBand(rects[1].right, trackYCenter, rects[1].right, trackYCenter, t.startToEnd);
        drawBand(rects[1].right, trackYCenter, rects[2].left, pairYCenter, t.endToArr);

        const segments = [
          { x: (rects[0].right + rects[1].left) / 2,  seg: t.depToStart, key: 'depToStart' },
          { x: (rects[1].left  + rects[1].right) / 2, seg: t.startToEnd, key: 'startToEnd' },
          { x: (rects[1].right + rects[2].left) / 2,  seg: t.endToArr,   key: 'endToArr'   },
        ];

        segments.forEach(({ x, seg, key }) => {
          const isEditingThis = editing && editing.trackId === t.id && editing.segment === key;
          if (isEditingThis) return;

          const label = `${seg.value}/${seg.cap}`;
          const pillW = 48;
          const pillH = 22;

          svg.append("rect")
            .attr("x", x - pillW / 2).attr("y", trackYCenter - pillH / 2)
            .attr("width", pillW).attr("height", pillH).attr("rx", 5)
            .attr("fill", t.col)
            .attr("opacity", isHighlighted ? 0.9 : 0.1)
            .attr("cursor", "pointer").attr("pointer-events", "all")
            .on("click", () => startEdit(pairs.indexOf(pair), t.id, key, seg.value, seg.cap));

          svg.append("text")
            .attr("x", x).attr("y", trackYCenter).attr("dy", "0.35em")
            .attr("text-anchor", "middle")
            .attr("font-family", "'Ubuntu', sans-serif")
            .attr("font-size", 13)
            .attr("font-weight", "700")
            .attr("fill", "white")
            .attr("opacity", isHighlighted ? 1 : 0.1)
            .attr("cursor", "pointer").attr("pointer-events", "all")
            .text(label)
            .on("click", () => startEdit(pairs.indexOf(pair), t.id, key, seg.value, seg.cap));
        });
      });
    });

  }, [pairs, colPositions, editing, selectedDep]);

  return (
    <div className="planner" onClick={() => setSelectedDep(null)}>
      <h2 className="planner__title">CTP Slot Planner</h2>

      <div className="planner__grid" ref={gridRef} onClick={e => e.stopPropagation()}>

        <svg ref={svgRef} className="planner__svg" />

        <div className="col planner__col">
          <div className="planner__header">Departure</div>
          {pairs.map(p => (
            <div key={p.dep}
              className="planner__cell"
              style={{
                height: p.tracks.length * ROW_H,
                display: 'flex',
                alignItems: 'center',
                cursor: 'pointer',
                background: selectedDep === p.dep ? '#e8edf8' : 'white',
                fontWeight: selectedDep === p.dep ? '700' : '400',
              }}
              onClick={e => { e.stopPropagation(); setSelectedDep(selectedDep === p.dep ? null : p.dep); }}>
              {p.dep}
            </div>
          ))}
        </div>

        <div className="col planner__col">
          <div className="planner__header planner__header--center">Track</div>
          {flatTracks.map(t => {
            const isActive = !selectedDep || selectedDep === t.dep;
            return (
              <div key={t.id} className="planner__cell planner__cell--center"
                style={{ opacity: isActive ? 1 : 0.2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontWeight: '700', fontSize: 18, color: t.col }}>{t.id}</span>
              </div>
            );
          })}
        </div>

        <div className="col planner__col">
          <div className="planner__header planner__header--right">Arrival</div>
          {pairs.map(p => (
            <div key={p.arr}
              className="planner__cell planner__cell--right"
              style={{
                height: p.tracks.length * ROW_H,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                opacity: !selectedDep || selectedDep === p.dep ? 1 : 0.2,
              }}>
              {p.arr}
            </div>
          ))}
        </div>

      </div>

      {editing && (() => {
        const t = pairs[editing.pairIdx]?.tracks.find(t => t.id === editing.trackId);
        if (!t) return null;
        return (
          <div className="planner__edit-overlay" style={{ borderColor: t.col }}>
            <div className="planner__edit-label" style={{ color: t.col }}>
              Track {t.id} · {editing.segment}
            </div>
            <input
              autoFocus
              className="planner__edit-input"
              value={editVal}
              style={{ borderColor: t.col, color: t.col }}
              onChange={e => setEditVal(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={e => e.key === 'Enter' && commitEdit()} />
          </div>
        );
      })()}
    </div>
  );
}