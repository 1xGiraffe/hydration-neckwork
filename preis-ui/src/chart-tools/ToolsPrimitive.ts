import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  PrimitiveHoveredItem,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts'
import { barMetaFromSeries, fractionalLogicalForTime, makeChartScale, timeToX } from './coords'
import type { BarMeta, CoordScale } from './coords'
import { distToSegment, formatDuration, measureStats } from './geometry'
import type { AnchorPoint, ChartDrawing } from './types'

// Renderer target types come from fancy-canvas; derive them from the
// lightweight-charts typings instead of depending on the transitive package.
type CanvasTarget = Parameters<IPrimitivePaneRenderer['draw']>[0]
type BitmapScope = Parameters<Parameters<CanvasTarget['useBitmapCoordinateSpace']>[0]>[0]

type XY = { x: number; y: number }

// Time-scale + bar-meta resolved ONCE per render/hit pass. barMetaFromSeries
// copies the whole bar array (series.data() is O(n)), so it must not be rebuilt
// per anchor — a channel alone maps a dozen anchors per pass.
type Coords = { scale: CoordScale; meta: BarMeta | null }

export interface PendingTrendline {
  p1: AnchorPoint
  cursor: AnchorPoint | null
}

/** Channel placement stage 2: base line committed, offset previewing. */
export interface PendingChannel {
  points: [AnchorPoint, AnchorPoint]
  offset: number | null
}

export interface MeasureState {
  a: AnchorPoint
  b: AnchorPoint
  frozen: boolean
}

const ENDPOINT_HIT_RADIUS = 7
const LINE_HIT_DISTANCE = 5
const HANDLE_RADIUS = 4
const LINE_WIDTH = 3
const EQ_LINE_WIDTH = 1
const EQ_DASH: number[] = [2, 3]
const PREVIEW_DASH: number[] = [6, 4]

const MEASURE_UP_FILL = 'rgba(34, 197, 94, 0.12)'
const MEASURE_UP_BORDER = 'rgba(34, 197, 94, 0.5)'
const MEASURE_DOWN_FILL = 'rgba(239, 68, 68, 0.12)'
const MEASURE_DOWN_BORDER = 'rgba(239, 68, 68, 0.5)'

interface ToolColors {
  line: string
  ring: string
  bgElev: string
  border: string
  textHigh: string
}

// Resolved on EVERY draw (never cached) so theme toggles repaint correctly.
// Drawings are theme-adaptive black/white; the measure label box still uses
// the house tokens, which the canvas cannot read directly.
function resolveColors(element: HTMLElement): ToolColors {
  const light = document.documentElement.dataset.theme === 'light'
  const styles = getComputedStyle(element)
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback
  return {
    line: light ? '#000000' : '#ffffff',
    ring: light ? '#ffffff' : '#000000',
    bgElev: read('--bg-elev', '#0d1525'),
    border: read('--border', 'rgba(255, 255, 255, 0.08)'),
    textHigh: read('--text-high', '#f5f1f8'),
  }
}

function formatSignedPrice(value: number): string {
  const s = Math.abs(value).toPrecision(6)
  const trimmed = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
  return `${value >= 0 ? '+' : '-'}${trimmed}`
}

function offsetAnchor(anchor: AnchorPoint, offset: number): AnchorPoint {
  return { time: anchor.time, price: anchor.price + offset }
}

class ToolsPaneRenderer implements IPrimitivePaneRenderer {
  private readonly source: ChartToolsPrimitive

  constructor(source: ChartToolsPrimitive) {
    this.source = source
  }

  draw(target: CanvasTarget): void {
    target.useBitmapCoordinateSpace(scope => this.source.drawAll(scope))
  }
}

class ToolsPaneView implements IPrimitivePaneView {
  private readonly paneRenderer: ToolsPaneRenderer

  constructor(source: ChartToolsPrimitive) {
    this.paneRenderer = new ToolsPaneRenderer(source)
  }

  zOrder(): PrimitivePaneViewZOrder {
    // Above the series so lines stay visible over candles.
    return 'top'
  }

  renderer(): IPrimitivePaneRenderer | null {
    return this.paneRenderer
  }
}

/**
 * Single series primitive that renders every drawing-tool visual (committed
 * trendlines and channels, selection handles, pending previews, and the
 * measure overlay). All coordinates are recomputed at draw time, so pan/zoom,
 * interval switches, and data refills need no extra plumbing.
 */
export class ChartToolsPrimitive implements ISeriesPrimitive<Time> {
  private chart: SeriesAttachedParameter<Time>['chart'] | null = null
  private series: SeriesAttachedParameter<Time>['series'] | null = null
  private requestUpdate: (() => void) | null = null

  // paneViews must return a reference-stable array: the library caches by
  // reference and only re-reads content through the renderer.
  private readonly views: readonly IPrimitivePaneView[] = [new ToolsPaneView(this)]

  private drawings: ChartDrawing[] = []
  private selectedId: string | null = null
  private pending: PendingTrendline | null = null
  private pendingChannel: PendingChannel | null = null
  private measure: MeasureState | null = null
  // Touch placement reticle, in pane-0 pixel space (screen-anchored, not data-anchored).
  private placementCrosshair: XY | null = null
  private hitTestEnabled = true

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart
    this.series = param.series
    this.requestUpdate = param.requestUpdate
  }

  detached(): void {
    this.chart = null
    this.series = null
    this.requestUpdate = null
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views
  }

  setDrawings(drawings: ChartDrawing[]): void {
    this.drawings = drawings
    this.requestUpdate?.()
  }

  setSelectedId(id: string | null): void {
    this.selectedId = id
    this.requestUpdate?.()
  }

  setPending(pending: PendingTrendline | null): void {
    this.pending = pending
    this.requestUpdate?.()
  }

  setPendingChannel(pendingChannel: PendingChannel | null): void {
    this.pendingChannel = pendingChannel
    this.requestUpdate?.()
  }

  setMeasure(measure: MeasureState | null): void {
    this.measure = measure
    this.requestUpdate?.()
  }

  setPlacementCrosshair(xy: XY | null): void {
    this.placementCrosshair = xy
    this.requestUpdate?.()
  }

  /** Disable hover hits while a drawing tool owns the pointer. */
  setHitTestEnabled(enabled: boolean): void {
    this.hitTestEnabled = enabled
  }

  /** Time-scale + bar-meta for one pass; null while detached. */
  private coordCtx(): Coords | null {
    if (!this.chart || !this.series) return null
    return { scale: makeChartScale(this.chart), meta: barMetaFromSeries(this.series) }
  }

  /**
   * Maps an anchor to media coordinates against a resolved coords context. x
   * prefers the exact bar time, snaps in-range non-bar times to the nearest bar
   * (interval switches), and extrapolates beyond the data edges so anchors in
   * future/past whitespace render; y uses the series price scale. Null when
   * unplaceable.
   */
  private anchorXY(anchor: AnchorPoint, ctx: Coords): XY | null {
    if (!this.series) return null
    const x = timeToX(anchor.time, ctx.scale, ctx.meta)
    const y = this.series.priceToCoordinate(anchor.price)
    return x == null || y == null ? null : { x, y }
  }

  /** Public single-anchor mapping for the controller (resolves its own context). */
  anchorToXY(anchor: AnchorPoint): XY | null {
    const ctx = this.coordCtx()
    return ctx ? this.anchorXY(anchor, ctx) : null
  }

  /** The three channel lines in pixel space (base, offset second, dotted middle). */
  private channelXY(points: [AnchorPoint, AnchorPoint], offset: number, ctx: Coords): {
    base: [XY, XY]
    second: [XY, XY]
    middle: [XY, XY]
  } | null {
    const b0 = this.anchorXY(points[0], ctx)
    const b1 = this.anchorXY(points[1], ctx)
    const s0 = this.anchorXY(offsetAnchor(points[0], offset), ctx)
    const s1 = this.anchorXY(offsetAnchor(points[1], offset), ctx)
    const m0 = this.anchorXY(offsetAnchor(points[0], offset / 2), ctx)
    const m1 = this.anchorXY(offsetAnchor(points[1], offset / 2), ctx)
    if (!b0 || !b1 || !s0 || !s1 || !m0 || !m1) return null
    return { base: [b0, b1], second: [s0, s1], middle: [m0, m1] }
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    // Library hover path (cursor styles); disabled while a drawing tool owns
    // the pointer. Pointer handlers use hitTestAt directly, ungated.
    if (!this.hitTestEnabled) return null
    return this.hitTestAt(x, y)
  }

  /**
   * `slop` scales the hit tolerances: 1 for the precise mouse path, larger for
   * touch, where a fingertip needs a bigger target (missed taps fell through
   * to the candle-inspection click, making drawings hard to select/delete).
   */
  hitTestAt(x: number, y: number, slop = 1): PrimitiveHoveredItem | null {
    const ctx = this.coordCtx()
    if (!ctx) return null
    const lineHit = LINE_HIT_DISTANCE * slop
    const handleHit = ENDPOINT_HIT_RADIUS * slop
    // Handles first (they are only visible on the selected drawing), then
    // line bodies, topmost drawing first.
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const drawing = this.drawings[i]
      if (drawing.id !== this.selectedId) continue
      const prefix = drawing.kind === 'channel' ? 'ch' : 'tl'
      for (const part of [0, 1] as const) {
        const p = this.anchorXY(drawing.points[part], ctx)
        if (p && Math.hypot(x - p.x, y - p.y) <= handleHit) {
          return { externalId: `${prefix}:${drawing.id}:p${part}`, zOrder: 'top', cursorStyle: 'grab' }
        }
      }
      if (drawing.kind === 'channel') {
        const off = this.channelOffsetHandleXY(drawing, ctx)
        if (off && Math.hypot(x - off.x, y - off.y) <= handleHit) {
          return { externalId: `ch:${drawing.id}:off`, zOrder: 'top', cursorStyle: 'grab' }
        }
      }
    }
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const drawing = this.drawings[i]
      if (drawing.kind === 'channel') {
        const lines = this.channelXY(drawing.points, drawing.offset ?? 0, ctx)
        if (!lines) continue
        for (const [a, b] of [lines.base, lines.second, lines.middle]) {
          if (distToSegment(x, y, a.x, a.y, b.x, b.y) <= lineHit) {
            return { externalId: `ch:${drawing.id}`, zOrder: 'top', cursorStyle: 'pointer' }
          }
        }
        continue
      }
      const p0 = this.anchorXY(drawing.points[0], ctx)
      const p1 = this.anchorXY(drawing.points[1], ctx)
      if (!p0 || !p1) continue
      if (distToSegment(x, y, p0.x, p0.y, p1.x, p1.y) <= lineHit) {
        return { externalId: `tl:${drawing.id}`, zOrder: 'top', cursorStyle: 'pointer' }
      }
    }
    return null
  }

  private channelOffsetHandleXY(drawing: ChartDrawing, ctx: Coords): XY | null {
    const lines = this.channelXY(drawing.points, drawing.offset ?? 0, ctx)
    if (!lines) return null
    return {
      x: (lines.second[0].x + lines.second[1].x) / 2,
      y: (lines.second[0].y + lines.second[1].y) / 2,
    }
  }

  drawAll(scope: BitmapScope): void {
    const chart = this.chart
    if (!chart) return
    // Nothing to paint: skip the forced style read (resolveColors) entirely so
    // the always-attached primitive costs nothing on charts with no drawings.
    if (this.drawings.length === 0 && !this.pending && !this.pendingChannel &&
      !this.measure && !this.placementCrosshair) return
    const ctx = this.coordCtx()
    if (!ctx) return
    const colors = resolveColors(chart.chartElement())

    for (const drawing of this.drawings) {
      const selected = drawing.id === this.selectedId
      if (drawing.kind === 'channel') {
        const lines = this.channelXY(drawing.points, drawing.offset ?? 0, ctx)
        if (!lines) continue
        this.strokeLine(scope, lines.base[0], lines.base[1], colors.line, LINE_WIDTH, null)
        this.strokeLine(scope, lines.second[0], lines.second[1], colors.line, LINE_WIDTH, null)
        this.strokeLine(scope, lines.middle[0], lines.middle[1], colors.line, EQ_LINE_WIDTH, EQ_DASH)
        if (selected) {
          this.drawHandle(scope, lines.base[0], colors)
          this.drawHandle(scope, lines.base[1], colors)
          const off = this.channelOffsetHandleXY(drawing, ctx)
          if (off) this.drawHandle(scope, off, colors)
        }
        continue
      }
      const p0 = this.anchorXY(drawing.points[0], ctx)
      const p1 = this.anchorXY(drawing.points[1], ctx)
      if (!p0 || !p1) continue
      this.strokeLine(scope, p0, p1, colors.line, LINE_WIDTH, null)
      if (selected) {
        this.drawHandle(scope, p0, colors)
        this.drawHandle(scope, p1, colors)
      }
    }

    if (this.pending) {
      const p1 = this.anchorXY(this.pending.p1, ctx)
      if (p1) {
        const cursor = this.pending.cursor ? this.anchorXY(this.pending.cursor, ctx) : null
        if (cursor) this.strokeLine(scope, p1, cursor, colors.line, LINE_WIDTH, PREVIEW_DASH)
        this.drawHandle(scope, p1, colors)
      }
    }

    if (this.pendingChannel) {
      const { points, offset } = this.pendingChannel
      const b0 = this.anchorXY(points[0], ctx)
      const b1 = this.anchorXY(points[1], ctx)
      if (b0 && b1) {
        this.strokeLine(scope, b0, b1, colors.line, LINE_WIDTH, null)
        if (offset != null) {
          const lines = this.channelXY(points, offset, ctx)
          if (lines) {
            this.strokeLine(scope, lines.second[0], lines.second[1], colors.line, LINE_WIDTH, PREVIEW_DASH)
            this.strokeLine(scope, lines.middle[0], lines.middle[1], colors.line, EQ_LINE_WIDTH, EQ_DASH)
          }
        }
        this.drawHandle(scope, b0, colors)
        this.drawHandle(scope, b1, colors)
      }
    }

    if (this.measure) this.drawMeasure(scope, this.measure, colors, ctx)

    if (this.placementCrosshair) this.drawPlacementCrosshair(scope, this.placementCrosshair, colors)
  }

  /** Full-pane hairlines + a handle-style dot marking the touch placement target. */
  private drawPlacementCrosshair(scope: BitmapScope, p: XY, colors: ToolColors): void {
    const { context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr } = scope
    const x = p.x * hpr
    const y = p.y * vpr
    ctx.save()
    ctx.strokeStyle = colors.line
    ctx.globalAlpha = 0.55
    ctx.lineWidth = Math.max(1, Math.round(hpr))
    ctx.setLineDash([4 * hpr, 4 * hpr])
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(scope.bitmapSize.width, y)
    ctx.moveTo(x, 0)
    ctx.lineTo(x, scope.bitmapSize.height)
    ctx.stroke()
    ctx.restore()
    this.drawHandle(scope, p, colors)
  }

  private strokeLine(
    scope: BitmapScope,
    a: XY,
    b: XY,
    color: string,
    width: number,
    dash: number[] | null,
  ): void {
    const { context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr } = scope
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(1, Math.round(width * hpr))
    ctx.lineCap = 'round'
    if (dash) ctx.setLineDash(dash.map(v => v * hpr))
    ctx.beginPath()
    ctx.moveTo(a.x * hpr, a.y * vpr)
    ctx.lineTo(b.x * hpr, b.y * vpr)
    ctx.stroke()
    ctx.restore()
  }

  private drawHandle(scope: BitmapScope, p: XY, colors: ToolColors): void {
    const { context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr } = scope
    ctx.save()
    ctx.beginPath()
    ctx.arc(p.x * hpr, p.y * vpr, HANDLE_RADIUS * hpr, 0, Math.PI * 2)
    ctx.fillStyle = colors.line
    ctx.fill()
    ctx.lineWidth = Math.max(1, Math.round(hpr))
    ctx.strokeStyle = colors.ring
    ctx.stroke()
    ctx.restore()
  }

  private drawMeasure(scope: BitmapScope, measure: MeasureState, colors: ToolColors, coords: Coords): void {
    const chart = this.chart
    if (!chart) return
    const a = this.anchorXY(measure.a, coords)
    const b = this.anchorXY(measure.b, coords)
    if (!a || !b) return
    // No degenerate box before the second point exists (never a 0-value overlay).
    if (measure.a.time === measure.b.time && measure.a.price === measure.b.price) return

    const { context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr } = scope
    const up = measure.b.price >= measure.a.price

    const left = Math.min(a.x, b.x) * hpr
    const top = Math.min(a.y, b.y) * vpr
    const width = Math.abs(a.x - b.x) * hpr
    const height = Math.abs(a.y - b.y) * vpr

    ctx.save()
    ctx.fillStyle = up ? MEASURE_UP_FILL : MEASURE_DOWN_FILL
    ctx.fillRect(left, top, width, height)
    ctx.strokeStyle = up ? MEASURE_UP_BORDER : MEASURE_DOWN_BORDER
    ctx.lineWidth = Math.max(1, Math.round(hpr))
    ctx.strokeRect(left, top, width, height)
    ctx.restore()

    // Bar count over the actual (possibly gapped) grid, valid beyond the data
    // edges too — the library's timeToIndex clamps at the edges instead.
    const meta = coords.meta
    const bars = meta == null
      ? 0
      : Math.abs(Math.round(fractionalLogicalForTime(measure.b.time, meta)) -
          Math.round(fractionalLogicalForTime(measure.a.time, meta)))
    const stats = measureStats(measure.a, measure.b, bars)
    const sign = stats.deltaPct >= 0 ? '+' : '-'
    const lines = [
      formatSignedPrice(stats.deltaPrice),
      `${sign}${Math.abs(stats.deltaPct).toFixed(2)}%`,
      `${stats.bars} bars · ${formatDuration(stats.seconds)}`,
    ]

    ctx.save()
    ctx.font = `${Math.round(11 * vpr)}px GeistMono, monospace`
    ctx.textBaseline = 'top'
    const padX = 8 * hpr
    const padY = 6 * vpr
    const lineHeight = 15 * vpr
    const textWidth = Math.max(...lines.map(line => ctx.measureText(line).width))
    const boxWidth = textWidth + padX * 2
    const boxHeight = lineHeight * lines.length + padY * 2

    // Position near the drag end, clamped inside the pane.
    let boxX = b.x * hpr + 12 * hpr
    let boxY = b.y * vpr - boxHeight - 12 * vpr
    boxX = Math.min(Math.max(boxX, 4 * hpr), Math.max(4 * hpr, scope.bitmapSize.width - boxWidth - 4 * hpr))
    boxY = Math.min(Math.max(boxY, 4 * vpr), Math.max(4 * vpr, scope.bitmapSize.height - boxHeight - 4 * vpr))

    ctx.fillStyle = colors.bgElev
    ctx.strokeStyle = colors.border
    ctx.lineWidth = Math.max(1, Math.round(hpr))
    ctx.beginPath()
    ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 4 * hpr)
    ctx.fill()
    ctx.stroke()

    ctx.fillStyle = colors.textHigh
    lines.forEach((line, i) => {
      ctx.fillText(line, boxX + padX, boxY + padY + i * lineHeight)
    })
    ctx.restore()
  }
}
