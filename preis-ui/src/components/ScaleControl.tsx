interface ScaleControlProps {
  logarithmic: boolean
  onToggle: () => void
}

// The chart's price-scale switch: both scales are always on screen, so the
// control answers "which scale am I on" without being operated, and clicking
// either label switches. One button rather than two, because it is one setting —
// the two words are labels for the ends of a switch, not separate targets.
export default function ScaleControl({ logarithmic, onToggle }: ScaleControlProps) {
  return (
    <div className="sc-segmented" onMouseDown={e => e.stopPropagation()}>
      <button
        type="button"
        role="switch"
        aria-checked={logarithmic}
        aria-label="Logarithmic price scale"
        title={logarithmic ? 'Switch to linear price scale' : 'Switch to logarithmic price scale'}
        style={{ '--active-index': logarithmic ? 1 : 0 } as React.CSSProperties}
        onClick={onToggle}
      >
        <span className="sc-indicator" aria-hidden="true" />
        <span className={'sc-cell' + (logarithmic ? '' : ' on')}>LIN</span>
        <span className={'sc-cell' + (logarithmic ? ' on' : '')}>LOG</span>
      </button>
    </div>
  )
}
