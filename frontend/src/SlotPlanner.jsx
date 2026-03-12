import { useState } from "react";
import "./SlotPlanner.css";

const INIT = [
  { id:'A', col:'black', dep:'KJFK', arr:'EGLL' },
  { id:'B', col:'black', dep:'KBOS', arr:'EHAM' },
  { id:'C', col:'black', dep:'CYYC', arr:'EDDF' },
  { id:'D', col:'black', dep:null,   arr:null   },
  { id:'E', col:'black', dep:null,   arr:null   },
];

export default function SlotPlanner() {
  const [tracks] = useState(INIT);

  return (
    <div className="planner">
      <h2 className="planner__title">Slot Planner - Example</h2>

      <div className="planner__grid">

        <div className="planner__col">
          <div className="planner__header">Departure</div>
          {tracks.map(t => (
            <div key={t.id} className={`planner__cell ${!t.dep ? 'planner__cell--empty' : ''}`}>
              {t.dep ?? '-'}
            </div>
          ))}
        </div>
        
        <div className="planner__col">
          <div className="planner__header planner__header--center">Track Start</div>
          {tracks.map( t=> (
            <div key={t.id} className="planner__cell planner__cell--center planner__cell--bold"
            style={{ color: t.dep ? t.col : '#ccc' }}>
              {t.id}
            </div>
          ))}
        </div>
        
        <div className="planner__col">
          <div className="planner__header planner__header--center">Track End</div>
          {tracks.map(t => (
            <div key={t.id} className="planner__cell planner__cell--center planner__cell--bold"
            style={{ color: t.dep ? t.col : '#ccc'}}>
              {t.id}
            </div>
          ))}
        </div>

        <div className="planner__col">
          <div className="planner__header planner__header--right">Arrival</div>
          {tracks.map(t => (
            <div key={t.id} className={`planner__cell planner__cell--right ${!t.arr ? 'planner__cell--empty' : ''}`}>
            {t.arr ?? '-'}
        </div>
          ))}
        </div>

      </div>
    </div>
  );
}