import { useState } from 'react'
import { INTERVALS, INTERVAL_LABELS } from '../types'
import type { OHLCVInterval } from '../types'

interface IntervalSelectorProps {
  value: OHLCVInterval
  onChange: (interval: OHLCVInterval) => void
}

export default function IntervalSelector({ value, onChange }: IntervalSelectorProps) {
  const [hovered, setHovered] = useState<OHLCVInterval | null>(null)
  return (
    <div style={{ display: 'flex', gap: '2px' }} role="tablist" aria-label="Chart interval">
      {INTERVALS.map((interval) => {
        const isActive = interval === value
        const isHovered = hovered === interval
        return (
          <button
            key={interval}
            onClick={() => onChange(interval)}
            onMouseEnter={() => setHovered(interval)}
            onMouseLeave={() => setHovered(null)}
            role="tab"
            aria-selected={isActive}
            aria-label={`${INTERVAL_LABELS[interval]} interval`}
            style={{
              padding: '4px 10px',
              fontSize: '12px',
              fontWeight: 500,
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              transition: 'background 0.15s, color 0.15s',
              background: isActive ? '#1e293b' : isHovered ? '#0d1b2a' : 'transparent',
              color: isActive ? '#4FFFDF' : isHovered ? '#e2e8f0' : '#576B80',
            }}
          >
            {INTERVAL_LABELS[interval]}
          </button>
        )
      })}
    </div>
  )
}
