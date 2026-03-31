import React from 'react';
import { BRACE_W } from '../constants.js';

export default function CurlyBrace({ height }) {
  if (height < 6) return <div style={{ width: BRACE_W }} />;
  const W = BRACE_W, mid = height / 2, c = Math.min(height * 0.11, 13), sp = W * 0.48;
  const d = [
    `M ${W} 0`,
    `C ${sp} 0,${sp} ${c},${sp} ${c}`,
    `L ${sp} ${mid - c}`,
    `C ${sp} ${mid - c * 0.35},0 ${mid - c * 0.15},0 ${mid}`,
    `C 0 ${mid + c * 0.15},${sp} ${mid + c * 0.35},${sp} ${mid + c}`,
    `L ${sp} ${height - c}`,
    `C ${sp} ${height - c},${sp} ${height},${W} ${height}`,
  ].join(' ');
  return (
    <svg width={W} height={height} style={{ display: 'block', flexShrink: 0 }}>
      <path d={d} fill="none" stroke="var(--border)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
