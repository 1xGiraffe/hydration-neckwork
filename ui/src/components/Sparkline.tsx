import React, { useId } from 'react'

interface SparklineProps {
  data: number[]
  change7d: number | null
  width?: number
  height?: number
}

function buildPoints(data: number[], width: number, height: number): string {
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  return data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * width
      const y = height - ((v - min) / range) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

function SparklineInner({ data, change7d, width = 80, height = 28 }: SparklineProps) {
  const id = useId()
  const gradientId = 'spark-' + id

  if (data.length < 2) {
    return null
  }

  // Match the up/down semantics used elsewhere (change chips, hero stats):
  // up → green, down → red. Null falls back to neutral gray (no signal).
  let color: string
  let fillOpacity: number
  if (change7d === null) {
    color = 'var(--text-low)'
    fillOpacity = 0.3
  } else if (change7d >= 0) {
    color = 'var(--green)'
    fillOpacity = 0.45
  } else {
    color = 'var(--red)'
    fillOpacity = 0.4
  }
  const linePoints = buildPoints(data, width, height)
  const fillPoints = `${linePoints} ${width},${height} 0,${height}`

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={fillOpacity} />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon
        points={fillPoints}
        fill={`url(#${gradientId})`}
      />
      <polyline
        points={linePoints}
        stroke={color}
        strokeWidth="1.5"
        fill="none"
      />
    </svg>
  )
}

export default React.memo(SparklineInner, (prev, next) =>
  prev.data === next.data && prev.change7d === next.change7d
)
