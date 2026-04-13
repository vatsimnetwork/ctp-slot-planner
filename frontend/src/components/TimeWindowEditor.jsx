import React, { useState, useCallback, useMemo } from 'react';
import './TimeWindowEditor.css';

const STEP_MINUTES = 30;

function formatOffset(minutes) {
    if (minutes === 0) return '0';
    const sign = minutes > 0 ? '+' : '-';
    const hours = Math.floor(Math.abs(minutes) / 60);
    const mins = Math.abs(minutes) % 60;
    if (hours === 0) return `${sign}${mins}m`;
    if (mins === 0) return `${sign}${hours}h`;
    return `${sign}${hours}h ${mins}m`;
}

export default function TimeWindowEditor({
    referenceWindow = { startOffset: 0, endOffset: 180 },
    initialWindow,
    onChange,
    minDuration = STEP_MINUTES,
    globalMinOffset = null,
    globalMaxOffset = null,
}) {
    const [activeWindow, setActiveWindow] = useState({
        startOffset: initialWindow ? initialWindow.startOffset : referenceWindow.startOffset,
        endOffset: initialWindow ? initialWindow.endOffset : referenceWindow.endOffset,
    });

    const resetToReference = useCallback(() => {
        const w = {
            startOffset: referenceWindow.startOffset,
            endOffset: referenceWindow.endOffset,
        };
        setActiveWindow(w);
        onChange?.(w);
    }, [referenceWindow, onChange]);

    const validateAndSet = useCallback((newStart, newEnd) => {
        if (newEnd <= newStart) return false;
        if (minDuration != null && (newEnd - newStart) < minDuration) return false;
        if (globalMinOffset != null && newStart < globalMinOffset) return false;
        if (globalMaxOffset != null && newEnd > globalMaxOffset) return false;
        setActiveWindow({ startOffset: newStart, endOffset: newEnd });
        onChange?.({ startOffset: newStart, endOffset: newEnd });
        return true;
    }, [minDuration, globalMinOffset, globalMaxOffset, onChange]);

    const shift = useCallback((delta) => {
        validateAndSet(activeWindow.startOffset + delta, activeWindow.endOffset + delta);
    }, [activeWindow, validateAndSet]);

    const extendStart = useCallback(() => {
        const newStart = activeWindow.startOffset - STEP_MINUTES;
        if (globalMinOffset != null && newStart < globalMinOffset) return;
        validateAndSet(newStart, activeWindow.endOffset);
    }, [activeWindow, globalMinOffset, validateAndSet]);

    const extendEnd = useCallback(() => {
        const newEnd = activeWindow.endOffset + STEP_MINUTES;
        if (globalMaxOffset != null && newEnd > globalMaxOffset) return;
        validateAndSet(activeWindow.startOffset, newEnd);
    }, [activeWindow, globalMaxOffset, validateAndSet]);

    const shrinkStart = useCallback(() => {
        const newStart = activeWindow.startOffset + STEP_MINUTES;
        if (newStart >= activeWindow.endOffset - minDuration) return;
        if (globalMinOffset != null && newStart < globalMinOffset) return;
        validateAndSet(newStart, activeWindow.endOffset);
    }, [activeWindow, minDuration, globalMinOffset, validateAndSet]);

    const shrinkEnd = useCallback(() => {
        const newEnd = activeWindow.endOffset - STEP_MINUTES;
        if (newEnd <= activeWindow.startOffset + minDuration) return;
        if (globalMaxOffset != null && newEnd > globalMaxOffset) return;
        validateAndSet(activeWindow.startOffset, newEnd);
    }, [activeWindow, minDuration, globalMaxOffset, validateAndSet]);

    const { axisTicks, refLeft, refWidth, actLeft, actWidth } = useMemo(() => {
        const allOffsets = [
            referenceWindow.startOffset,
            referenceWindow.endOffset,
            activeWindow.startOffset,
            activeWindow.endOffset,
        ];
        if (globalMinOffset != null) allOffsets.push(globalMinOffset);
        if (globalMaxOffset != null) allOffsets.push(globalMaxOffset);

        const min = Math.min(...allOffsets);
        const max = Math.max(...allOffsets);

        const step = STEP_MINUTES;
        const axisMin = Math.floor(min / step) * step;
        const axisMax = Math.ceil(max / step) * step;

        const ticks = [];
        for (let t = axisMin; t <= axisMax; t += step) {
            ticks.push(t);
        }

        const range = axisMax - axisMin;
        const pct = (v) => range === 0 ? 50 : ((v - axisMin) / range) * 100;

        return {
            axisTicks: ticks,
            refLeft: pct(referenceWindow.startOffset),
            refWidth: pct(referenceWindow.endOffset) - pct(referenceWindow.startOffset),
            actLeft: pct(activeWindow.startOffset),
            actWidth: pct(activeWindow.endOffset) - pct(activeWindow.startOffset),
            axisMin,
        };
    }, [referenceWindow, activeWindow, globalMinOffset, globalMaxOffset]);

    const axisLabels = useMemo(() => axisTicks.map(t => ({
        value: t,
        label: t.toString(),
        pct: axisTicks.indexOf(t) / (axisTicks.length - 1 || 1) * 100,
    })), [axisTicks]);

    const isModified = activeWindow.startOffset !== referenceWindow.startOffset ||
        activeWindow.endOffset !== referenceWindow.endOffset;

    return (
        <div className="twe">
            <div className="twe__header">
                <span className="twe__label">Time Window</span>
                <div className="twe__values">
                    <span className="twe__value">{formatOffset(activeWindow.startOffset)}</span>
                    <span className="twe__sep">—</span>
                    <span className="twe__value">{formatOffset(activeWindow.endOffset)}</span>
                    <span className="twe__duration">({formatOffset(activeWindow.endOffset - activeWindow.startOffset)})</span>
                </div>
                <button className={`twe__reset${isModified ? ' twe__reset--visible' : ''}`} onClick={resetToReference} type="button">
                    Reset
                </button>
            </div>

            <div className="twe__timeline">
                <div className="twe__track twe__track--ref">
                    <div
                        className="twe__bar twe__bar--reference"
                        style={{ left: `${refLeft}%`, width: `${refWidth}%` }}
                    />
                </div>
                <div className="twe__track twe__track--act">
                    <div
                        className="twe__bar twe__bar--active"
                        style={{ left: `${actLeft}%`, width: `${actWidth}%` }}
                    />
                </div>
                <div className="twe__axis">
                    {axisLabels.map(({ value, label, pct }) => (
                        <span key={value} className="twe__tick" style={{ left: `${pct}%` }}>
                            {label}
                        </span>
                    ))}
                </div>
            </div>

            <div className="twe__controls">
                <div className="twe__controls-row">
                    <div className="twe__group">
                        <span className="twe__group-label">Start</span>
                        <button className="twe__btn" onClick={extendStart} type="button">Earlier −30m</button>
                        <button className="twe__btn" onClick={shrinkStart} type="button">Later +30m</button>
                    </div>
                    <div className="twe__group">
                        <span className="twe__group-label">End</span>
                        <button className="twe__btn" onClick={shrinkEnd} type="button">Earlier −30m</button>
                        <button className="twe__btn" onClick={extendEnd} type="button">Later +30m</button>
                    </div>
                </div>
                <div className="twe__controls-row">
                    <div className="twe__group">
                        <span className="twe__group-label">Shift</span>
                        <button className="twe__btn" onClick={() => shift(-STEP_MINUTES)} type="button">−30m</button>
                        <button className="twe__btn" onClick={() => shift(STEP_MINUTES)} type="button">+30m</button>
                    </div>
                </div>
            </div>
        </div>
    );
}