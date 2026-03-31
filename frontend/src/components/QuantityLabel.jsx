import React from 'react';

export default function QuantityLabel({ used, cap, size = 'md' }) {
  return (
    <span className={`qty-label qty-label--${size}${cap != null && used > cap ? ' qty-label--over' : ''}`}>
      {used}{cap != null ? <span className="qty-sep">/{cap}</span> : null}
    </span>
  );
}
