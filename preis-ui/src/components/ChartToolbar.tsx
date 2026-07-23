import type { ToolId } from '../chart-tools/types'

interface ChartToolbarProps {
  tool: ToolId
  onTool: (tool: ToolId) => void
  hasSelection: boolean
  onDelete: () => void
}

const TOOLS: ReadonlyArray<{ id: ToolId; title: string; icon: React.ReactNode }> = [
  {
    id: 'cursor',
    title: 'Cursor',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
        <path d="M13 13l6 6" />
      </svg>
    ),
  },
  {
    id: 'trendline',
    title: 'Trendline — drag or click two points',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <line x1="7.5" y1="16.5" x2="16.5" y2="7.5" />
        <circle cx="5.5" cy="18.5" r="2" />
        <circle cx="18.5" cy="5.5" r="2" />
      </svg>
    ),
  },
  {
    id: 'channel',
    title: 'Channel — draw the base line, then set the offset',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <line x1="3" y1="15" x2="15" y2="3" />
        <line x1="9" y1="21" x2="21" y2="9" />
      </svg>
    ),
  },
  {
    id: 'measure',
    title: 'Measure — press and drag',
    icon: (
      // Diagonal ruler: rotated rounded rectangle with tick marks.
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="7.4" y="-1.4" width="6" height="20" rx="1.5" transform="rotate(45 12 12)" />
        <path d="M8.5 11.3l2.1 2.1" />
        <path d="M11.3 8.5l2.1 2.1" />
        <path d="M14.1 5.7l2.1 2.1" />
      </svg>
    ),
  },
]

export default function ChartToolbar({ tool, onTool, hasSelection, onDelete }: ChartToolbarProps) {
  return (
    <>
      <style>{`
        .chart-tools {
          position: absolute; top: 40px; left: 10px; z-index: 6;
          display: flex; flex-direction: column; gap: 2px; padding: 3px;
          background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px;
          box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
        }
        .chart-tools button {
          width: 32px; height: 32px; border-radius: 6px;
          display: inline-flex; align-items: center; justify-content: center;
          color: var(--text-medium);
          transition: color 160ms, background 160ms, transform 140ms var(--ease-out-soft);
        }
        .chart-tools button:hover { color: var(--text-high); background: var(--panel-hover); }
        .chart-tools button:active { transform: scale(0.94); }
        .chart-tools button.active { color: var(--accent-on); background: var(--accent); }
        .chart-tools button svg { width: 16px; height: 16px; }
        .chart-tools-sep { height: 1px; margin: 2px 3px; background: var(--separator); }
        .chart-tools .chart-tools-delete { color: var(--red); }
        .chart-tools .chart-tools-delete:hover { color: var(--red); background: var(--red-soft); }
        /* The mobile legend sits at top 48px and can wrap to two rows; start
           the toolbar below it. */
        @media (max-width: 768px) {
          .chart-tools { top: 84px; left: 8px; }
        }
      `}</style>
      <div
        className="chart-tools"
        role="group"
        aria-label="Chart drawing tools"
        onMouseDown={e => e.stopPropagation()}
      >
        {TOOLS.map(item => (
          <button
            key={item.id}
            type="button"
            title={item.title}
            aria-pressed={tool === item.id}
            className={tool === item.id ? 'active' : ''}
            onClick={() => onTool(item.id)}
          >
            {item.icon}
          </button>
        ))}
        {hasSelection && (
          <>
            <div className="chart-tools-sep" aria-hidden="true" />
            <button
              type="button"
              title="Delete drawing (Del)"
              className="chart-tools-delete"
              onClick={onDelete}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            </button>
          </>
        )}
      </div>
    </>
  )
}
