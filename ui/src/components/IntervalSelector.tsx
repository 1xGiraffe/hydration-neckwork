import { INTERVALS, INTERVAL_LABELS } from '../types'
import type { OHLCVInterval } from '../types'

interface IntervalSelectorProps {
  value: OHLCVInterval
  onChange: (interval: OHLCVInterval) => void
}

export default function IntervalSelector({ value, onChange }: IntervalSelectorProps) {
  return (
    <div style={{ display: 'flex', gap: '4px' }}>
      {INTERVALS.map((interval) => (
        <button
          key={interval}
          onClick={() => onChange(interval)}
          style={{
            padding: '4px 10px',
            fontSize: '12px',
            fontWeight: 500,
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            transition: 'background 0.15s',
            background: interval === value ? '#1e293b' : 'transparent',
            color: interval === value ? '#4FFFDF' : '#576B80',
          }}
        >
          {INTERVAL_LABELS[interval]}
        </button>
      ))}
    </div>
  )
}
