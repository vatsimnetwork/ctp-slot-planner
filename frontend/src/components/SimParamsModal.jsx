import React from 'react';
import TimeSpinner from './TimeSpinner.jsx';

export default function SimParamsModal({ mode, params, onParamsChange, onConfirm, onClose }) {
  const set = (k, v) => onParamsChange({ ...params, [k]: v });
  const label = mode === 'calculate' ? 'Calculate Slots' : 'Simulate Slots';
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{label} — Parameters</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {mode === 'calculate' && <>
            <div className="modal-section-title">Slot Generation</div>
            <label className="modal-row"><span className="modal-label">Slot Generation Mode</span>
              <select className="modal-select" value={params.IntendedSlotGenerationMode} onChange={e => set('IntendedSlotGenerationMode', e.target.value)}>
                <option value="MaximizeSlots">Maximize Slots</option>
                <option value="MaximizeAirportPairs">Maximize Airport Pairs</option>
                <option value="Random">Random</option>
              </select>
            </label>
          </>}
          {mode === 'simulate' && <>
            <div className="modal-section-title">Simulation</div>
            <label className="modal-row"><span className="modal-label">Analysis Resolution (minutes)</span>
              <input className="modal-input" type="number" min={1} max={60} value={params.SimulationAnalysisResolutionInMinutes} onChange={e => set('SimulationAnalysisResolutionInMinutes', parseInt(e.target.value) || 2)}/>
            </label>
            <label className="modal-row modal-row--check">
              <input type="checkbox" checked={params.ShouldSimulationUseActualWeatherForecastData} onChange={e => set('ShouldSimulationUseActualWeatherForecastData', e.target.checked)}/>
              <span className="modal-label">Use Actual Weather Forecast Data</span>
            </label>
            <label className="modal-row modal-row--check">
              <input type="checkbox" checked={params.HighSimulationAccuracy} onChange={e => set('HighSimulationAccuracy', e.target.checked)}/>
              <span className="modal-label">High Simulation Accuracy (ellipsoid earth model)</span>
            </label>
            <label className="modal-row"><span className="modal-label">Calculation Fallback Ground Speed (kt)</span>
              <input className="modal-input" type="number" min={100} max={600} value={params.CalculationFallbackGroundSpeed} onChange={e => set('CalculationFallbackGroundSpeed', parseFloat(e.target.value) || 300)}/>
            </label>
          </>}
          <div className="modal-section-title">Departure Time Windows</div>
          <label className="modal-row"><span className="modal-label">Offset Calculation Mode</span>
            <select className="modal-select" value={params.IntendedDepartureTimeWindowOffsetsCalculationMode} onChange={e => set('IntendedDepartureTimeWindowOffsetsCalculationMode', e.target.value)}>
              <option value="None">None</option>
              <option value="EarliestRoutes">Earliest Routes</option>
              <option value="LatestRoutes">Latest Routes</option>
              <option value="RouteAverage">Route Average</option>
            </select>
          </label>
          <label className="modal-row"><span className="modal-label">Synchronisation Longitude (°)</span>
            <input className="modal-input" type="number" step={0.5} min={-180} max={180} value={params.DepartureTimeWindowOffsetSynchronizationLongitude} onChange={e => set('DepartureTimeWindowOffsetSynchronizationLongitude', parseFloat(e.target.value) || -30)}/>
          </label>
          <div className="modal-row">
            <span className="modal-label">Synchronisation Time (UTC)</span>
            <TimeSpinner value={params.DepartureTimeWindowOffsetSynchronizationTimeOfDay} onChange={v => set('DepartureTimeWindowOffsetSynchronizationTimeOfDay', v)}/>
          </div>
          {mode === 'simulate' && <>
            <div className="modal-section-title">Throughput</div>
            <label className="modal-row"><span className="modal-label">Waypoint Throughput Calculation</span>
              <select className="modal-select" value={params.IntendedWaypointThroughputCalculationMode} onChange={e => set('IntendedWaypointThroughputCalculationMode', e.target.value)}>
                <option value="None">None</option>
                <option value="FirstWaypointsOfNATRouteSegmentsOnly">First Waypoints of NAT Route Segments Only</option>
                <option value="AllWaypoints">All Waypoints</option>
              </select>
            </label>
            <label className="modal-row"><span className="modal-label">Waypoint Count Threshold (NM)</span>
              <input className="modal-input" type="number" step={0.5} min={0} value={params.ThresholdToCheckIfAirplaneIsCountedAtWaypointInNm} onChange={e => set('ThresholdToCheckIfAirplaneIsCountedAtWaypointInNm', parseFloat(e.target.value) || 5)}/>
            </label>
            <label className="modal-row modal-row--check">
              <input type="checkbox" checked={params.CalculateThroughputDataOnlyForManuallyProvidedSectors} onChange={e => set('CalculateThroughputDataOnlyForManuallyProvidedSectors', e.target.checked)}/>
              <span className="modal-label">Throughput for Manually Provided Sectors Only</span>
            </label>
          </>}
        </div>
        <div className="modal-footer">
          <button className="planner__btn" onClick={onConfirm}>Run {label}</button>
          <button className="planner__btn" style={{ background: 'var(--text-muted)' }} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
