export type ToolId = 'cursor' | 'trendline' | 'channel' | 'measure'

/** Chart-space anchor: unix seconds (UTCTimestamp) and raw price. */
export interface AnchorPoint {
  time: number
  price: number
}

export type DrawingKind = 'trendline' | 'channel'

/**
 * A stored drawing. `kind` is absent for trendlines (v1 data stays readable);
 * channels add a price-space `offset` for the parallel second line, with the
 * equilibrium middle line at exactly half the offset.
 */
export interface ChartDrawing {
  id: string
  points: [AnchorPoint, AnchorPoint]
  kind?: DrawingKind
  offset?: number
}
