import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import { barMetaFromSeries, makeChartScale, xToTime } from './coords'
import { newDrawingId } from './geometry'
import { readDrawings, writeDrawings } from './store'
import { ChartToolsPrimitive } from './ToolsPrimitive'
import type { MeasureState } from './ToolsPrimitive'
import type { AnchorPoint, ChartDrawing, ToolId } from './types'

type PlacementStage = 'p1' | 'p2' | 'offset'

export interface ToolState {
  tool: ToolId
  hasSelection: boolean
}

interface ToolControllerOptions {
  chart: IChartApi
  series: ISeriesApi<'Candlestick'>
  pairKey: string
  onStateChange: (state: ToolState) => void
}

type DragPart = 'p0' | 'p1' | 'off' | 'body'

// One live pointer gesture. Geometry comes exclusively from pointer events with
// self-computed pane-0 coordinates, because MouseEventParams.point is pane-local
// per pane (a volume-pane point would otherwise resolve against pane 0's scales).
type Interaction =
  | {
      kind: 'place'
      pointerId: number
      tool: 'trendline' | 'channel'
      p1: AnchorPoint
      fromPending: boolean
      lastAnchor: AnchorPoint
      startX: number
      startY: number
      moved: boolean
    }
  | { kind: 'channelOffset'; pointerId: number; lastOffset: number; startX: number; startY: number; moved: boolean }
  | {
      kind: 'measure'
      pointerId: number
      // fromPending = this is the second of two clicks (mouse click-click flow).
      fromPending: boolean
      lastAnchor: AnchorPoint
      startX: number
      startY: number
      moved: boolean
    }
  // Touch placement: dragging moves the reticle by the pointer's delta (the
  // finger stays away from the target); a tap jumps the reticle to the tap.
  | {
      kind: 'reticle'
      pointerId: number
      crossStartX: number
      crossStartY: number
      startX: number
      startY: number
      moved: boolean
    }
  | {
      kind: 'drag'
      pointerId: number
      id: string
      part: DragPart
      startAnchors: [AnchorPoint, AnchorPoint]
      startOffset: number | undefined
      startTime: number | null
      startPrice: number | null
      startX: number
      startY: number
      moved: boolean
    }

const DRAG_MOVE_THRESHOLD_PX = 3
// Fingertips drift while tapping: touch needs a larger move threshold so a tap
// that wobbles a few px still reads as a tap (commit) rather than a drag, and a
// wider hit slop so tapping a drawing doesn't fall through to candle inspection.
const TOUCH_MOVE_THRESHOLD_PX = 10
const TOUCH_HIT_SLOP = 3
// A channel needs a visible gap between its base and second line; committing
// with the offset point on the base line would collapse it into one line.
const MIN_CHANNEL_OFFSET_PX = 4

function parseExternalId(externalId: string): { id: string; part: DragPart } | null {
  if (!externalId.startsWith('tl:') && !externalId.startsWith('ch:')) return null
  const [, id, part] = externalId.split(':')
  if (!id) return null
  return { id, part: part === 'p0' || part === 'p1' || part === 'off' ? part : 'body' }
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
}

function anchorsEqual(a: AnchorPoint, b: AnchorPoint): boolean {
  return a.time === b.time && a.price === b.price
}

/**
 * Owns drawing-tool interaction and persistence for one chart mount. All
 * placement/drag/measure geometry is pointer-event driven (pane-0 gated, with
 * pointer capture so off-window releases end cleanly); the chart's own click
 * pipeline is suppressed via `isCapturing()` plus a short-lived click guard.
 */
export class ToolController {
  private readonly chart: IChartApi
  private readonly series: ISeriesApi<'Candlestick'>
  private readonly pairKey: string
  private readonly onStateChange: (state: ToolState) => void
  private readonly primitive: ChartToolsPrimitive
  private readonly chartElement: HTMLDivElement

  private tool: ToolId = 'cursor'
  private drawings: ChartDrawing[]
  private selectedId: string | null = null
  private pending: { p1: AnchorPoint } | null = null
  // Channel placement stage 2: the committed base line awaiting its offset.
  private channelBase: [AnchorPoint, AnchorPoint] | null = null
  private measure: MeasureState | null = null
  // Mouse click-click ruler: start point set, awaiting the second click.
  private measurePending = false
  // Touch crosshair placement (TradingView-mobile style): the reticle lives in
  // pane-0 pixel space; anchors resolve from it only on a commit tap. Cancel is
  // switching tools or Escape. Covers trendline, channel, and measure.
  private placement:
    | { tool: 'trendline' | 'channel' | 'measure'; stage: PlacementStage; x: number; y: number; p1: AnchorPoint | null }
    | null = null
  private lastPointerType: string | null = null
  private interaction: Interaction | null = null
  private scrollScaleEnabled = true
  // Suppresses the chart's synthesized click for gestures we already handled
  // (trendline commit, deselect, drag release, middle-click delete).
  private clickGuard = false

  constructor({ chart, series, pairKey, onStateChange }: ToolControllerOptions) {
    this.chart = chart
    this.series = series
    this.pairKey = pairKey
    this.onStateChange = onStateChange
    this.chartElement = chart.chartElement()

    this.primitive = new ChartToolsPrimitive()
    series.attachPrimitive(this.primitive)
    this.drawings = readDrawings(pairKey)
    this.primitive.setDrawings(this.drawings)

    this.chartElement.addEventListener('pointerdown', this.onPointerDown, true)
    // Non-passive touch handlers claim (preventDefault + stopPropagation) only
    // the touches we own — a tool that owns the pane, or a touch landing on a
    // drawing — so the browser cannot scroll and the library cannot pan them out
    // from under our pointer drag (which otherwise fires pointercancel). Touches
    // on empty chart still fall through to the library for normal panning.
    this.chartElement.addEventListener('touchstart', this.onTouchStart, { capture: true, passive: false })
    this.chartElement.addEventListener('touchmove', this.onTouchMove, { capture: true, passive: false })
    // Window-level so moves/releases outside the chart (or window) still end
    // interactions; handlers early-exit when nothing is live. The capture-phase
    // pointerdown only records the pointer type (it also sees toolbar presses,
    // which is what decides touch-vs-mouse placement when a tool activates).
    window.addEventListener('pointerdown', this.onGlobalPointerDown, true)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerCancel)
    window.addEventListener('keydown', this.onKeyDown)
  }

  setTool(tool: ToolId, opts: { keepMeasure?: boolean } = {}): void {
    if (this.interaction) this.cancelInteraction()
    this.tool = tool
    this.pending = null
    this.primitive.setPending(null)
    this.channelBase = null
    this.primitive.setPendingChannel(null)
    // A finished (frozen) measurement can survive the auto-return to cursor so
    // the reading stays visible; an in-progress one is always discarded.
    if (opts.keepMeasure) this.measurePending = false
    else this.clearMeasure()
    this.placement = null
    this.primitive.setPlacementCrosshair(null)
    if (tool !== 'cursor') {
      this.selectedId = null
      this.primitive.setSelectedId(null)
    }
    if ((tool === 'trendline' || tool === 'channel' || tool === 'measure') && this.prefersCrosshairPlacement()) {
      this.startPlacement(tool)
    }
    this.primitive.setHitTestEnabled(tool === 'cursor')
    this.syncInteractionMode()
    this.notify()
  }

  /**
   * Touch gets TradingView-mobile-style placement: a screen-space reticle the
   * user positions by dragging (relative move, so the fingertip never occludes
   * the target) and commits with a tap anywhere. Mouse keeps the direct
   * drag-draw / click-click / press-drag flows.
   */
  private prefersCrosshairPlacement(): boolean {
    if (this.lastPointerType != null) return this.lastPointerType !== 'mouse'
    return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
  }

  /** Arms the reticle at pane center for the tool's first point. */
  private startPlacement(tool: 'trendline' | 'channel' | 'measure'): void {
    this.placement = { tool, stage: 'p1', x: this.paneWidth() / 2, y: this.pane0Height() / 2, p1: null }
    this.primitive.setPlacementCrosshair({ x: this.placement.x, y: this.placement.y })
  }

  /** Commits the reticle's current position as the active stage's point (tap). */
  private confirmPlacement(): void {
    const placement = this.placement
    if (!placement) return
    const anchor = this.anchorAtXY(placement.x, placement.y)
    if (!anchor) return

    if (placement.tool === 'measure') {
      if (placement.stage === 'p1') {
        this.measure = { a: anchor, b: anchor, frozen: false }
        this.primitive.setMeasure(this.measure)
        placement.stage = 'p2'
      } else if (this.measure) {
        // A zero-area second tap keeps waiting rather than freezing nothing.
        if (anchorsEqual(anchor, this.measure.a)) return
        // Second tap freezes the box and returns to the cursor, exactly like the
        // other tools — no reticle is left behind, so nothing jumps. The frozen
        // box stays visible until the next chart tap clears it.
        this.measure = { ...this.measure, b: anchor, frozen: true }
        this.primitive.setMeasure(this.measure)
        this.setTool('cursor', { keepMeasure: true })
      }
      return
    }

    switch (placement.stage) {
      case 'p1':
        placement.p1 = anchor
        placement.stage = 'p2'
        this.primitive.setPending({ p1: anchor, cursor: anchor })
        return
      case 'p2':
        // A second point equal to the first is a no-op, never a zero-length line.
        if (!placement.p1 || anchorsEqual(anchor, placement.p1)) return
        if (placement.tool === 'channel') {
          this.enterChannelStage2(placement.p1, anchor)
          placement.stage = 'offset'
          this.syncPlacementPreview()
        } else {
          this.commitTrendline(placement.p1, anchor)
        }
        return
      case 'offset': {
        if (!this.channelBase) return
        // A tap on (or level with) the base line would collapse the channel;
        // keep waiting for a tap that gives it a visible width.
        if (!this.channelHasVisibleWidth(placement.x, placement.y, this.channelBase)) return
        const offset = this.offsetAt(placement.x, placement.y, this.channelBase)
        if (offset == null) return
        this.commitChannel(this.channelBase, offset)
        return
      }
    }
  }

  /** Abandons crosshair placement entirely (nothing persisted). */
  private cancelPlacement(): void {
    if (this.placement) this.setTool('cursor')
  }

  /** Reticle + stage previews at the placement's current position. */
  private syncPlacementPreview(): void {
    const placement = this.placement
    if (!placement) return
    this.primitive.setPlacementCrosshair({ x: placement.x, y: placement.y })
    if (placement.tool === 'measure') {
      if (placement.stage === 'p2' && this.measure) {
        const anchor = this.anchorAtXY(placement.x, placement.y)
        if (anchor) {
          this.measure = { ...this.measure, b: anchor }
          this.primitive.setMeasure(this.measure)
        }
      }
      return
    }
    if (placement.stage === 'p2' && placement.p1) {
      const cursor = this.anchorAtXY(placement.x, placement.y)
      this.primitive.setPending({ p1: placement.p1, cursor })
    } else if (placement.stage === 'offset' && this.channelBase) {
      const offset = this.offsetAt(placement.x, placement.y, this.channelBase)
      if (offset != null) this.primitive.setPendingChannel({ points: this.channelBase, offset })
    }
  }

  deleteSelection(): void {
    if (this.selectedId != null) this.deleteDrawing(this.selectedId)
  }

  /** True while the drawing tools should swallow the chart's own click handling. */
  isCapturing(): boolean {
    return this.tool !== 'cursor' ||
      this.interaction != null ||
      this.pending != null ||
      this.channelBase != null ||
      this.measure != null ||
      this.placement != null ||
      this.selectedId != null ||
      this.clickGuard
  }

  dispose(): void {
    this.chartElement.removeEventListener('pointerdown', this.onPointerDown, true)
    this.chartElement.removeEventListener('touchstart', this.onTouchStart, true)
    this.chartElement.removeEventListener('touchmove', this.onTouchMove, true)
    window.removeEventListener('pointerdown', this.onGlobalPointerDown, true)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerCancel)
    window.removeEventListener('keydown', this.onKeyDown)
    if (this.interaction) this.releasePointerCapture(this.interaction.pointerId)
    this.interaction = null
    // Restore pan/zoom and touch behavior even when disposed mid-interaction.
    if (!this.scrollScaleEnabled) {
      this.chart.applyOptions({ handleScroll: true, handleScale: true })
      this.scrollScaleEnabled = true
    }
    this.chartElement.style.touchAction = ''
    this.series.detachPrimitive(this.primitive)
  }

  private notify(): void {
    this.onStateChange({ tool: this.tool, hasSelection: this.selectedId != null })
  }

  // --- pane-0 coordinate helpers -------------------------------------------

  /** Pane-0 coordinates: the chart element's top-left is pane 0's origin
   *  (price scale sits on the right, time axis at the bottom). */
  private toPaneXY(event: PointerEvent): { x: number; y: number } {
    const rect = this.chartElement.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  private pane0Height(): number {
    const panes = this.chart.panes()
    const height = panes.length > 0 ? panes[0].getHeight() : 0
    return height > 0 ? height : this.chartElement.clientHeight
  }

  private paneWidth(): number {
    const width = this.chart.timeScale().width()
    return width > 0 ? width : this.chartElement.clientWidth
  }

  private inPane0(x: number, y: number): boolean {
    return x >= 0 && x <= this.paneWidth() && y >= 0 && y <= this.pane0Height()
  }

  private clampYToPane0(y: number): number {
    return Math.min(Math.max(y, 0), this.pane0Height())
  }

  private clampXToPane(x: number): number {
    return Math.min(Math.max(x, 0), this.paneWidth())
  }

  /** With Shift held, snap a point level with `base` so the segment is horizontal. */
  private constrainHorizontal(point: AnchorPoint, base: AnchorPoint, shiftKey: boolean): AnchorPoint {
    return shiftKey ? { time: point.time, price: base.price } : point
  }

  /** Anchor at pane-0 (x, y); time may be extrapolated beyond the data edges. */
  private anchorAtXY(x: number, y: number): AnchorPoint | null {
    const time = xToTime(x, makeChartScale(this.chart), barMetaFromSeries(this.series))
    if (time == null) return null
    const price = this.series.coordinateToPrice(y)
    if (price == null) return null
    return { time, price }
  }

  // --- shared state transitions --------------------------------------------

  private clearMeasure(): void {
    this.measure = null
    this.measurePending = false
    this.primitive.setMeasure(null)
  }

  private deleteDrawing(id: string): void {
    const next = this.drawings.filter(d => d.id !== id)
    if (next.length === this.drawings.length) return
    this.drawings = next
    if (this.selectedId === id) {
      this.selectedId = null
      this.primitive.setSelectedId(null)
    }
    this.primitive.setDrawings(next)
    writeDrawings(this.pairKey, next)
    this.notify()
  }

  private commitTrendline(p1: AnchorPoint, p2: AnchorPoint): void {
    this.drawings = [...this.drawings, { id: newDrawingId(), points: [p1, p2] }]
    this.primitive.setDrawings(this.drawings)
    writeDrawings(this.pairKey, this.drawings)
    this.pending = null
    this.primitive.setPending(null)
    this.setTool('cursor')
  }

  /** Channel stage 1 done: base line fixed, stage 2 previews the offset. */
  private enterChannelStage2(p1: AnchorPoint, p2: AnchorPoint): void {
    this.pending = null
    this.primitive.setPending(null)
    this.channelBase = [p1, p2]
    this.primitive.setPendingChannel({ points: this.channelBase, offset: null })
  }

  private commitChannel(points: [AnchorPoint, AnchorPoint], offset: number): void {
    this.drawings = [...this.drawings, { id: newDrawingId(), points, kind: 'channel', offset }]
    this.primitive.setDrawings(this.drawings)
    writeDrawings(this.pairKey, this.drawings)
    this.channelBase = null
    this.primitive.setPendingChannel(null)
    this.setTool('cursor')
  }

  /**
   * Price-space offset that makes the channel's second line pass through
   * pane-0 point (x, y): cursor price minus the base line's price at x,
   * interpolated in pixel space to match how the segment is rendered.
   */
  private offsetAt(x: number, y: number, points: [AnchorPoint, AnchorPoint]): number | null {
    const a = this.primitive.anchorToXY(points[0])
    const b = this.primitive.anchorToXY(points[1])
    if (!a || !b) return null
    const baseY = a.x === b.x ? (a.y + b.y) / 2 : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x)
    const cursorPrice = this.series.coordinateToPrice(y)
    const basePrice = this.series.coordinateToPrice(baseY)
    if (cursorPrice == null || basePrice == null) return null
    return cursorPrice - basePrice
  }

  /** True when (x, y) sits far enough from the base line to form a real channel. */
  private channelHasVisibleWidth(x: number, y: number, points: [AnchorPoint, AnchorPoint]): boolean {
    const a = this.primitive.anchorToXY(points[0])
    const b = this.primitive.anchorToXY(points[1])
    if (!a || !b) return false
    const baseY = a.x === b.x ? (a.y + b.y) / 2 : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x)
    return Math.abs(y - baseY) >= MIN_CHANNEL_OFFSET_PX
  }

  /** Chart pan/zoom and browser touch gestures are off while a drawing tool is
   *  active or a cursor-tool drag is live; restored otherwise. */
  private syncInteractionMode(): void {
    const chartOwnsGestures = this.tool === 'cursor' && this.interaction?.kind !== 'drag'
    if (chartOwnsGestures !== this.scrollScaleEnabled) {
      this.chart.applyOptions({ handleScroll: chartOwnsGestures, handleScale: chartOwnsGestures })
      this.scrollScaleEnabled = chartOwnsGestures
    }
    this.chartElement.style.touchAction = chartOwnsGestures ? '' : 'none'
  }

  private armClickGuard(): void {
    this.clickGuard = true
  }

  private scheduleClickGuardRelease(): void {
    // The chart's synthesized click dispatches before timers run.
    window.setTimeout(() => { this.clickGuard = false }, 0)
  }

  private beginInteraction(event: PointerEvent, interaction: Interaction): void {
    this.interaction = interaction
    try {
      this.chartElement.setPointerCapture(event.pointerId)
    } catch {
      // Pointer may already be gone; the window listeners still cover us.
    }
    // Canceling pointerdown suppresses the compatibility mousedown, so the
    // chart never starts its own gesture (and never synthesizes a click).
    event.preventDefault()
    event.stopPropagation()
    this.syncInteractionMode()
  }

  private releasePointerCapture(pointerId: number): void {
    try {
      this.chartElement.releasePointerCapture(pointerId)
    } catch {
      // Already released.
    }
  }

  private cancelInteraction(): void {
    const interaction = this.interaction
    if (!interaction) return
    this.interaction = null
    this.releasePointerCapture(interaction.pointerId)
    switch (interaction.kind) {
      case 'drag': {
        // Revert to the gesture's start geometry; nothing was persisted.
        const index = this.drawings.findIndex(d => d.id === interaction.id)
        if (index >= 0) {
          const restored: ChartDrawing = {
            ...this.drawings[index],
            points: interaction.startAnchors,
            ...(interaction.startOffset !== undefined ? { offset: interaction.startOffset } : {}),
          }
          this.drawings = [...this.drawings.slice(0, index), restored, ...this.drawings.slice(index + 1)]
          this.primitive.setDrawings(this.drawings)
        }
        break
      }
      case 'measure':
        this.clearMeasure()
        break
      case 'place':
        this.primitive.setPending(interaction.fromPending ? { p1: interaction.p1, cursor: null } : null)
        break
      case 'channelOffset':
        // Stage 2 stays alive; the offset keeps previewing from the hover.
        if (this.channelBase) this.primitive.setPendingChannel({ points: this.channelBase, offset: null })
        break
      case 'reticle':
        // The reticle simply stays where the interrupted gesture left it.
        break
    }
    this.syncInteractionMode()
  }

  // --- pointer handlers -----------------------------------------------------

  private readonly onGlobalPointerDown = (event: PointerEvent): void => {
    this.lastPointerType = event.pointerType
  }

  /** Whether a single touch at pane (x, y) is one the drawing tools should own. */
  private touchClaims(x: number, y: number): boolean {
    if (this.tool !== 'cursor' || this.placement != null) return true
    return this.primitive.hitTestAt(x, y, TOUCH_HIT_SLOP) != null
  }

  private readonly onTouchStart = (event: TouchEvent): void => {
    // Leave multi-touch (pinch-zoom) to the library.
    if (event.touches.length !== 1) return
    const touch = event.touches[0]
    const rect = this.chartElement.getBoundingClientRect()
    if (this.touchClaims(touch.clientX - rect.left, touch.clientY - rect.top)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  private readonly onTouchMove = (event: TouchEvent): void => {
    // Keep the browser/library out of a live drag for its whole duration.
    if (this.interaction && event.touches.length === 1) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    const { x, y } = this.toPaneXY(event)
    const hitSlop = event.pointerType === 'mouse' ? 1 : TOUCH_HIT_SLOP

    // Middle mouse deletes the drawing under the pointer, in any tool.
    if (event.button === 1) {
      const hit = this.primitive.hitTestAt(x, y, hitSlop)
      const parsed = hit ? parseExternalId(hit.externalId) : null
      if (parsed) {
        event.preventDefault()
        event.stopPropagation()
        this.deleteDrawing(parsed.id)
        this.armClickGuard()
      }
      return
    }
    if (event.button !== 0) return
    // One gesture at a time: a second finger (or a stray press) never hijacks a
    // live interaction or its pointer capture.
    if (this.interaction) return

    // Touch crosshair placement owns the gesture for every drawing tool: a drag
    // moves the reticle relatively, a tap (no movement) commits the point.
    if (this.placement) {
      if (!this.inPane0(x, y)) return
      this.beginInteraction(event, {
        kind: 'reticle', pointerId: event.pointerId,
        crossStartX: this.placement.x, crossStartY: this.placement.y,
        startX: x, startY: y, moved: false,
      })
      return
    }

    // A frozen measurement clears on the next press (which may start a new one).
    // Guard the synthesized click so dismissing it never opens the volume modal.
    if (this.measure?.frozen) {
      this.clearMeasure()
      this.armClickGuard()
    }

    if (this.tool === 'trendline' || this.tool === 'channel') {
      if (!this.inPane0(x, y)) return

      // Channel stage 2: this press previews/commits the parallel offset.
      if (this.tool === 'channel' && this.channelBase) {
        const offset = this.offsetAt(x, y, this.channelBase)
        if (offset == null) return
        this.primitive.setPendingChannel({ points: this.channelBase, offset })
        this.beginInteraction(event, {
          kind: 'channelOffset', pointerId: event.pointerId, lastOffset: offset,
          startX: x, startY: y, moved: false,
        })
        return
      }

      // Stage 1 (both tools): drag-draw or two taps define the base line.
      const anchor = this.anchorAtXY(x, y)
      if (!anchor) return
      const fromPending = this.pending != null
      const p1 = this.pending ? this.pending.p1 : anchor
      this.beginInteraction(event, {
        kind: 'place', pointerId: event.pointerId, tool: this.tool, p1, fromPending,
        lastAnchor: anchor, startX: x, startY: y, moved: false,
      })
      if (fromPending) this.primitive.setPending({ p1, cursor: this.constrainHorizontal(anchor, p1, event.shiftKey) })
      return
    }

    if (this.tool === 'measure') {
      if (!this.inPane0(x, y)) return
      const anchor = this.anchorAtXY(x, y)
      if (!anchor) return
      // Mouse: drag-draw or two clicks, same as the trendline tool. The first
      // press sets the start; a second click (fromPending) sets the end.
      const fromPending = this.measurePending
      if (!fromPending) {
        this.measure = { a: anchor, b: anchor, frozen: false }
        this.primitive.setMeasure(this.measure)
      } else if (this.measure) {
        this.primitive.setMeasure({ ...this.measure, b: anchor })
      }
      this.beginInteraction(event, {
        kind: 'measure', pointerId: event.pointerId, fromPending,
        lastAnchor: anchor, startX: x, startY: y, moved: false,
      })
      return
    }

    // Cursor tool: hit test directly at the pointer (no hover needed; touch works).
    const hit = this.primitive.hitTestAt(x, y, hitSlop)
    const parsed = hit ? parseExternalId(hit.externalId) : null
    if (parsed) {
      const drawing = this.drawings.find(d => d.id === parsed.id)
      if (!drawing) return
      this.beginInteraction(event, {
        kind: 'drag', pointerId: event.pointerId, id: parsed.id, part: parsed.part,
        startAnchors: [{ ...drawing.points[0] }, { ...drawing.points[1] }],
        startOffset: drawing.offset,
        startTime: xToTime(x, makeChartScale(this.chart), barMetaFromSeries(this.series)),
        startPrice: this.series.coordinateToPrice(y),
        startX: x, startY: y, moved: false,
      })
      return
    }

    if (this.selectedId != null) {
      // Deselect on empty press; guard the synthesized click so the volume
      // modal does not open on the same gesture. Pan still works (no preventDefault).
      this.selectedId = null
      this.primitive.setSelectedId(null)
      this.armClickGuard()
      this.notify()
    }
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const interaction = this.interaction
    if (interaction && event.pointerId === interaction.pointerId) {
      this.updateInteraction(event, interaction)
      return
    }
    // Between taps the previews follow the mouse (touch has no hover; the
    // next tap drags or commits directly). Never while crosshair placement is
    // active — there the reticle alone drives every preview.
    if (!interaction && event.pointerType === 'mouse' && !this.placement) {
      if (this.channelBase) {
        const { x, y } = this.toPaneXY(event)
        if (!this.inPane0(x, y)) return
        const offset = this.offsetAt(x, y, this.channelBase)
        if (offset != null) this.primitive.setPendingChannel({ points: this.channelBase, offset })
        return
      }
      if (this.pending) {
        const { x, y } = this.toPaneXY(event)
        if (!this.inPane0(x, y)) return
        const anchor = this.anchorAtXY(x, y)
        if (anchor) {
          this.primitive.setPending({ p1: this.pending.p1, cursor: this.constrainHorizontal(anchor, this.pending.p1, event.shiftKey) })
        }
        return
      }
      if (this.measurePending && this.measure) {
        const { x, y } = this.toPaneXY(event)
        if (!this.inPane0(x, y)) return
        const anchor = this.anchorAtXY(x, y)
        if (anchor) this.primitive.setMeasure({ ...this.measure, b: anchor })
      }
    }
  }

  private updateInteraction(event: PointerEvent, interaction: Interaction): void {
    const { x, y } = this.toPaneXY(event)
    const moveThreshold = event.pointerType === 'mouse' ? DRAG_MOVE_THRESHOLD_PX : TOUCH_MOVE_THRESHOLD_PX
    if (!interaction.moved &&
      Math.hypot(x - interaction.startX, y - interaction.startY) > moveThreshold) {
      interaction.moved = true
    }
    const clampedY = this.clampYToPane0(y)

    switch (interaction.kind) {
      case 'place': {
        const anchor = this.anchorAtXY(x, clampedY)
        if (!anchor) return
        // Store the raw anchor as the release fallback; constrain only for the
        // live preview, so releasing Shift is honoured even over a data gap.
        interaction.lastAnchor = anchor
        if (interaction.fromPending || interaction.moved) {
          this.primitive.setPending({ p1: interaction.p1, cursor: this.constrainHorizontal(anchor, interaction.p1, event.shiftKey) })
        }
        return
      }
      case 'channelOffset': {
        if (!this.channelBase) return
        const offset = this.offsetAt(x, clampedY, this.channelBase)
        if (offset == null) return
        interaction.lastOffset = offset
        this.primitive.setPendingChannel({ points: this.channelBase, offset })
        return
      }
      case 'reticle': {
        if (!this.placement) return
        this.placement.x = this.clampXToPane(interaction.crossStartX + (x - interaction.startX))
        this.placement.y = this.clampYToPane0(interaction.crossStartY + (y - interaction.startY))
        this.syncPlacementPreview()
        return
      }
      case 'measure': {
        if (!this.measure || this.measure.frozen) return
        const anchor = this.anchorAtXY(x, clampedY)
        if (!anchor) return
        interaction.lastAnchor = anchor
        this.measure = { ...this.measure, b: anchor }
        this.primitive.setMeasure(this.measure)
        return
      }
      case 'drag': {
        // No anchor mutation below the movement threshold (a jittery click
        // must not displace the line in memory).
        if (!interaction.moved) return
        this.applyDrag(interaction, x, clampedY, event.shiftKey)
        return
      }
    }
  }

  private applyDrag(interaction: Extract<Interaction, { kind: 'drag' }>, x: number, y: number, shiftKey: boolean): void {
    const index = this.drawings.findIndex(d => d.id === interaction.id)
    if (index < 0) return
    const current = this.drawings[index]
    const cursorTime = xToTime(x, makeChartScale(this.chart), barMetaFromSeries(this.series))
    const cursorPrice = this.series.coordinateToPrice(y)

    if (interaction.part === 'off') {
      // Drag the channel's second line: recompute the price-space offset so
      // it tracks the pointer; base anchors stay put.
      const offset = this.offsetAt(x, y, current.points)
      if (offset == null) return
      const updated: ChartDrawing = { ...current, offset }
      this.drawings = [...this.drawings.slice(0, index), updated, ...this.drawings.slice(index + 1)]
      this.primitive.setDrawings(this.drawings)
      return
    }

    let points: [AnchorPoint, AnchorPoint]
    if (interaction.part === 'body') {
      // Δtime/Δprice from the drag origin applied to both anchors; in-range
      // times snap back to bars at render time.
      const deltaTime = cursorTime != null && interaction.startTime != null ? cursorTime - interaction.startTime : 0
      const deltaPrice = cursorPrice != null && interaction.startPrice != null ? cursorPrice - interaction.startPrice : 0
      points = [
        { time: interaction.startAnchors[0].time + deltaTime, price: interaction.startAnchors[0].price + deltaPrice },
        { time: interaction.startAnchors[1].time + deltaTime, price: interaction.startAnchors[1].price + deltaPrice },
      ]
    } else {
      const pointIndex = interaction.part === 'p0' ? 0 : 1
      const previous = current.points[pointIndex]
      const other = current.points[pointIndex === 0 ? 1 : 0]
      const raw: AnchorPoint = {
        time: cursorTime ?? previous.time,
        price: cursorPrice ?? previous.price,
      }
      // Shift keeps the dragged endpoint level with the other one (horizontal).
      const next = this.constrainHorizontal(raw, other, shiftKey)
      points = pointIndex === 0 ? [next, current.points[1]] : [current.points[0], next]
    }

    // Spread preserves kind/offset for channels.
    const updated: ChartDrawing = { ...current, points }
    this.drawings = [...this.drawings.slice(0, index), updated, ...this.drawings.slice(index + 1)]
    this.primitive.setDrawings(this.drawings)
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    const interaction = this.interaction
    if (this.clickGuard && !interaction) {
      // Deselect/middle-delete guards live until the press releases.
      this.scheduleClickGuardRelease()
    }
    if (!interaction || event.pointerId !== interaction.pointerId) return

    this.interaction = null
    this.releasePointerCapture(event.pointerId)
    const { x, y } = this.toPaneXY(event)
    const clampedY = this.clampYToPane0(y)

    switch (interaction.kind) {
      case 'place': {
        const raw = this.anchorAtXY(x, clampedY) ?? interaction.lastAnchor
        const release = this.constrainHorizontal(raw, interaction.p1, event.shiftKey)
        if (interaction.fromPending || interaction.moved) {
          if (anchorsEqual(release, interaction.p1)) {
            // Zero-length line: drag-draw discards; a repeated tap keeps waiting.
            this.pending = interaction.fromPending ? { p1: interaction.p1 } : null
            this.primitive.setPending(this.pending ? { p1: this.pending.p1, cursor: null } : null)
          } else if (interaction.tool === 'channel') {
            this.enterChannelStage2(interaction.p1, release)
          } else {
            this.commitTrendline(interaction.p1, release)
          }
        } else {
          this.pending = { p1: interaction.p1 }
          this.primitive.setPending({ p1: interaction.p1, cursor: null })
        }
        break
      }
      case 'channelOffset': {
        if (!this.channelBase) break
        // Releasing on the base line would collapse the channel; keep stage 2
        // alive and wait for a release that gives it a visible width.
        if (!this.channelHasVisibleWidth(x, clampedY, this.channelBase)) {
          this.primitive.setPendingChannel({ points: this.channelBase, offset: null })
          break
        }
        const offset = this.offsetAt(x, clampedY, this.channelBase) ?? interaction.lastOffset
        this.commitChannel(this.channelBase, offset)
        break
      }
      case 'reticle': {
        // TradingView-mobile semantics: positioning is drag-only, and a tap
        // (no movement) commits the current stage at the reticle — wherever it
        // sits, not where the tap landed. A drag just repositioned it.
        if (!interaction.moved) {
          this.confirmPlacement()
        }
        break
      }
      case 'measure': {
        if (!this.measure) break
        const release = this.anchorAtXY(x, clampedY) ?? interaction.lastAnchor
        if (interaction.fromPending || interaction.moved) {
          if (anchorsEqual(release, this.measure.a)) {
            // Zero-area: a drag back to the start clears; a repeated click waits.
            if (interaction.fromPending) {
              this.measurePending = true
            } else {
              this.clearMeasure()
            }
          } else {
            this.measure = { ...this.measure, b: release, frozen: true }
            this.measurePending = false
            this.primitive.setMeasure(this.measure)
          }
        } else {
          // First click without movement → await the second click.
          this.measurePending = true
          this.measure = { ...this.measure, b: release }
          this.primitive.setMeasure(this.measure)
        }
        break
      }
      case 'drag': {
        if (interaction.moved) {
          writeDrawings(this.pairKey, this.drawings)
        } else if (interaction.part === 'body') {
          // A press-and-release on the line body without movement is a select-click.
          this.selectedId = interaction.id
          this.primitive.setSelectedId(interaction.id)
          this.notify()
        }
        break
      }
    }

    this.armClickGuard()
    this.scheduleClickGuardRelease()
    this.syncInteractionMode()
  }

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.interaction && event.pointerId === this.interaction.pointerId) {
      this.cancelInteraction()
    }
    // A guard armed by a no-interaction press (deselect, frozen-measure dismiss)
    // is normally released on pointerup; if the browser takes over the gesture
    // and cancels instead, release it here so the next click is not swallowed.
    if (this.clickGuard && !this.interaction) this.scheduleClickGuardRelease()
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // The volume modal, asset picker, and drawer handle their own keys first
    // (their handlers preventDefault); never act behind an open modal.
    if (event.defaultPrevented) return
    if (event.key !== 'Escape' && event.key !== 'Delete' && event.key !== 'Backspace') return
    if (document.querySelector('.omniwatch-modal, .picker-modal')) return

    if (event.key === 'Escape') {
      if (this.interaction) {
        this.cancelInteraction()
        event.preventDefault()
      } else if (this.placement) {
        this.cancelPlacement()
        event.preventDefault()
      } else if (this.channelBase) {
        // Stage 2 cancels back to nothing (the base line is discarded too).
        this.channelBase = null
        this.primitive.setPendingChannel(null)
        event.preventDefault()
      } else if (this.pending) {
        this.pending = null
        this.primitive.setPending(null)
        event.preventDefault()
      } else if (this.measure) {
        this.clearMeasure()
        event.preventDefault()
      } else if (this.selectedId != null) {
        this.selectedId = null
        this.primitive.setSelectedId(null)
        this.notify()
        event.preventDefault()
      }
      return
    }

    if (this.selectedId != null) {
      if (isEditableTarget(event.target)) return
      event.preventDefault()
      this.deleteSelection()
    }
  }
}
