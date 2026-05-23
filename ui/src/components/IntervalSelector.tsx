import { INTERVALS, INTERVAL_LABELS } from '../types'
import type { OHLCVInterval } from '../types'

interface IntervalSelectorProps {
  value: OHLCVInterval
  onChange: (interval: OHLCVInterval) => void
}

export default function IntervalSelector({ value, onChange }: IntervalSelectorProps) {
  return (
    <>
      <style>{`
        .intervals {
          display: inline-flex; align-items: center; gap: 2px;
          background: var(--panel); border-radius: 9999px; padding: 3px;
          border: 1px solid var(--border);
        }
        .intervals button {
          height: 26px; padding: 0 12px;
          font-family: 'GeistMono', monospace; font-size: 11px; font-weight: 500;
          text-transform: uppercase; letter-spacing: 0.04em;
          color: var(--text-medium); border-radius: 9999px;
          transition: color 160ms, background 160ms;
        }
        .intervals button:hover { color: var(--text-high); }
        .intervals button.active { background: var(--accent); color: var(--accent-on); }
      `}</style>
      <div className="intervals" role="tablist" aria-label="Chart interval">
        {INTERVALS.map(iv => (
          <button
            key={iv}
            type="button"
            role="tab"
            aria-selected={iv === value}
            className={iv === value ? 'active' : ''}
            onClick={() => onChange(iv)}
          >
            {INTERVAL_LABELS[iv]}
          </button>
        ))}
      </div>
    </>
  )
}
