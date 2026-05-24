import { INTERVALS, INTERVAL_LABELS } from '../types'
import type { OHLCVInterval } from '../types'

interface IntervalSelectorProps {
  value: OHLCVInterval
  onChange: (interval: OHLCVInterval) => void
}

export default function IntervalSelector({ value, onChange }: IntervalSelectorProps) {
  const activeIndex = INTERVALS.indexOf(value)

  return (
    <>
      <style>{`
        .intervals {
          --interval-width: 42px;
          --interval-gap: 2px;
          position: relative;
          display: grid; grid-template-columns: repeat(8, var(--interval-width)); gap: var(--interval-gap);
          background: var(--panel); border-radius: 9999px; padding: 3px;
          border: 1px solid var(--border);
        }
        .intervals .active-indicator {
          position: absolute; top: 3px; bottom: 3px; left: 3px;
          width: var(--interval-width); border-radius: 9999px;
          background: var(--accent);
          transform: translateX(calc(var(--active-index) * (var(--interval-width) + var(--interval-gap))));
          transition: transform 180ms var(--ease-out-soft), background 160ms;
          pointer-events: none;
        }
        .intervals button {
          position: relative; z-index: 1;
          height: 26px; width: var(--interval-width);
          font-family: 'GeistMono', monospace; font-size: 11px; font-weight: 500;
          text-transform: uppercase; letter-spacing: 0.04em;
          color: var(--text-medium); border-radius: 9999px;
          text-align: center;
          transition: color 160ms, transform 140ms var(--ease-out-soft);
        }
        .intervals button:hover { color: var(--text-high); transform: translateY(-1px); }
        .intervals button.active { color: var(--accent-on); }
      `}</style>
      <div
        className="intervals"
        role="tablist"
        aria-label="Chart interval"
        style={{ '--active-index': activeIndex } as React.CSSProperties}
      >
        <span className="active-indicator" aria-hidden="true" />
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
