import { useEffect, useRef, useState, useLayoutEffect } from "react";
import * as d3 from "d3";
import "./SlotPlanner.css";

const INIT_TRACKS = [
  { id:'A', col:'black', dep:'KJFK', arr:'EGLL', value: 30, cap:30 },
  { id:'B', col:'black', dep:'KBOS', arr:'EHAM', value: 30, cap: 30 },
  { id:'C', col:'black', dep:'CYYC', arr:'EDDF', value: 11, cap: 30},
];

const HEADER_H = 47;
const ROW_H = 53;

export default function SlotPlanner() {
  const [tracks, setTracks] = useState(INIT_TRACKS);
  const [editing, setEditing] = useState(null);
  const [editVal, setEditVal] = useState('');
  const svgRef = useRef(null);
  const gridRef = useRef(null);
  const [colPositions, setColPositions] = useState(null);

  const startEdit = (id, value, cap) => {setEditing(id); setEditVal(`${value}/${cap}`);};
  const commitEdit = (id) => {
    const [v, c] = editVal.split('/').map(Number);
    if (!isNaN(v) && !isNaN(c) && c > 0) 
      setTracks(p => p.map(t => t.id === id ? { ...t, value: Math.min(v, c), cap: c } : t));
    setEditing(null);
  };

  useLayoutEffect(() => {
    if (!gridRef.current) return;

    const update = () => {
      const containerRect = gridRef.current.getBoundingClientRect();
      const cols = gridRef.current.querySelectorAll('.col');
      const rects = Array.from(cols).map(c => {
        const r = c.getBoundingClientRect();
        return {
          left: r.left - containerRect.left,
          right: r.right - containerRect.left,
        };
      });

      setColPositions({ rects, totalWidth: containerRect.width, totalHeight: containerRect.height });
    };

    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    if (!svgRef.current || !colPositions) return;

    const { rects, totalWidth, totalHeight } = colPositions;
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();
    svg.attr("width", totalWidth).attr("height", totalHeight);
    
    const activeTracks = tracks.filter(t => t.dep);

    activeTracks.forEach(t => {
      const yCenter = HEADER_H + tracks.indexOf(t) * ROW_H + ROW_H / 2;
      const bandwidth = Math.max((t.value / t.cap) * (ROW_H * 0.6), 3);

      const segments = [
        { x1: rects[0].right, x2: rects[1].left },
        { x1: rects[1].right, x2: rects[2].left },
        { x1: rects[2].right, x2: rects[3].left },
      ];

      segments.forEach(({ x1, x2 }) => {
        const mx = (x1 + x2) / 2;
        const path = `
          M ${x1} ${yCenter - bandwidth / 2}
          C ${mx} ${yCenter - bandwidth / 2}, ${mx} ${yCenter - bandwidth / 2}, ${x2} ${yCenter - bandwidth / 2}
          L ${x2} ${yCenter + bandwidth / 2}
          C ${mx} ${yCenter + bandwidth / 2}, ${mx} ${yCenter + bandwidth / 2}, ${x1} ${yCenter + bandwidth / 2}
          Z
        `;
        svg.append("path").attr("d", path).attr("fill", t.col).attr("opacity", 0.2);
    });

    const midX = (rects[1].right + rects[2].left) / 2;
    svg.append("text")
      .attr("x", midX).attr("y", yCenter).attr("dy", "0.35em" )
      .attr("text-anchor", "middle")
      .attr("font-family", "sans-serif").attr("font-size", 11)
      .attr("font-weight", "bold").attr("fill", t.col)
      .attr("cursor", "pointer").attr("pointer-events", "all")
      .text(`${t.value}/${t.cap}`)
      .on("click", () => startEdit(t.id, t.value, t.cap));
  });

}, [tracks, colPositions, editing]);


return (
   <div className="planner">
      <h2 className="planner__title">Slot Planner - Example</h2>
 
      <div className="planner__grid" ref={gridRef}>
 
        <svg ref={svgRef} className="planner__svg" />
 
        <div className="col planner__col">
          <div className="planner__header">Departure</div>
          {tracks.map(t => (
            <div key={t.id} className={`planner__cell ${!t.dep ? 'planner__cell--empty' : ''}`}>
              {t.dep ?? '-'}
            </div>
          ))}
        </div>
 
        <div className="col planner__col">
          <div className="planner__header planner__header--center">Track Start</div>
          {tracks.map(t => (
            <div key={t.id} className="planner__cell planner__cell--center planner__cell--bold"
              style={{ color: t.dep ? t.col : '#ccc' }}>
              {t.id}
            </div>
          ))}
        </div>
 
        <div className="col planner__col">
          <div className="planner__header planner__header--center">Track End</div>
          {tracks.map(t => (
            <div key={t.id} className="planner__cell planner__cell--center planner__cell--bold"
              style={{ color: t.dep ? t.col : '#ccc' }}>
              {t.id}
            </div>
          ))}
        </div>
 
        <div className="col planner__col">
          <div className="planner__header planner__header--right">Arrival</div>
          {tracks.map(t => (
            <div key={t.id} className={`planner__cell planner__cell--right ${!t.arr ? 'planner__cell--empty' : ''}`}>
              {t.arr ?? '-'}
            </div>
          ))}
        </div>
 
      </div>

      {editing && (() => {
        const t = tracks.find(t => t.id === editing);
        return (
          <div className="planner__edit-overlay" style={{ borderColor: t.col }}>
            <div className="planner__edit-label" style={{ color: t.col }}>Edit {t.id} capacity</div>
            <input autoFocus value={editVal}
            className="planner__edit-input"
            style={{ borderColor: t.col, color: t.col }}
            onChange={e => setEditVal(e.target.value)}
            onBlur={() => commitEdit(editing)}
            onKeyDown={e => e.key === 'Enter' && commitEdit(editing)} />
          </div>
        );
      })()}
      </div>
);
}
