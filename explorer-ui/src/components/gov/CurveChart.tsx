import { useEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from 'react'
import { F } from '../ui'
import type { TallyHistory } from '../../governanceTypes'
import { humanDate } from './GovUi'
import { tallyChartLegend } from './terms'

// Approval and support against their thresholds over a referendum's decision
// period — the picture behind "is it passing?". Two small multiples, each on its own
// 0–100% scale (never a dual axis): the track's threshold curve (dashed), the
// region above it where that measure passes (tinted), the tally's own trajectory
// replayed from the indexed votes (a step line, anchored to the chain's tally with
// any residual stated, never smoothed), a "now" marker and — while it runs — a
// dashed projection of today's value to the end ("if no more votes").
//
// A track page draws the same panels with the curves alone (no trajectory).
//
// Lazy-loaded (React.lazy) by the pages that use it, so the landing bundle never
// carries it.

const PERBILL = 1e9

export interface CurveSeries {
  /** Absolute blocks of the threshold samples (Perbill). */
  thresholds: { block: number; value: number }[]
  /** The measured trajectory (Perbill), as steps at the blocks it changed. */
  points?: { block: number; value: number }[]
}

interface Domain { from: number; to: number }

interface TimeAnchor { block: number; ms: number }

/** A block's moment: interpolated between indexed points, extrapolated at the nominal pace beyond them. */
function blockToMs(block: number, anchors: TimeAnchor[], msPerBlock: number): number {
  if (!anchors.length) return NaN
  if (block <= anchors[0].block) return anchors[0].ms - (anchors[0].block - block) * msPerBlock
  const last = anchors[anchors.length - 1]
  if (block >= last.block) return last.ms + (block - last.block) * msPerBlock
  let lo = 0, hi = anchors.length - 1
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (anchors[mid].block <= block) lo = mid; else hi = mid }
  const a = anchors[lo], b = anchors[hi]
  return a.ms + ((block - a.block) / Math.max(1, b.block - a.block)) * (b.ms - a.ms)
}

function valueAt(series: { block: number; value: number }[], block: number, step: boolean): number | null {
  if (!series.length || block < series[0].block) return null
  let lo = 0, hi = series.length - 1
  if (block >= series[hi].block) return series[hi].value
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (series[mid].block <= block) lo = mid; else hi = mid }
  if (step) return series[lo].value
  const a = series[lo], b = series[hi]
  return a.value + ((block - a.block) / Math.max(1, b.block - a.block)) * (b.value - a.value)
}

const pct = (perbill: number, digits = 1) => `${(perbill / 1e7).toFixed(digits)}%`

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(entries => setW(Math.round(entries[0].contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

function CurvePanel({ label, tone, series, domain, anchors, msPerBlock, nowBlock, projectTo, confirmStart, yMax, live, elapsedAxis }: {
  label: string
  tone: 'approval' | 'support'
  series: CurveSeries
  domain: Domain
  anchors: TimeAnchor[]
  msPerBlock: number
  nowBlock: number | null
  projectTo: number | null
  confirmStart: number | null
  yMax: number
  live: boolean
  /** Label the x axis in days from the start (a track's curves), not dates. */
  elapsedAxis?: boolean
}) {
  const [wrapRef, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const H = 168, PAD_L = 40, PAD_R = 12, PAD_T = 10, PAD_B = 24
  const W = Math.max(width, 260)
  const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B
  const x = (block: number) => PAD_L + ((block - domain.from) / Math.max(1, domain.to - domain.from)) * innerW
  const y = (v: number) => PAD_T + innerH - (Math.min(v, yMax) / yMax) * innerH
  const thr = series.thresholds
  const pts = series.points ?? []

  const thrPath = thr.length ? thr.map((p, i) => `${i ? 'L' : 'M'}${x(p.block).toFixed(1)},${y(p.value).toFixed(1)}`).join('') : ''
  const passArea = thr.length ? `${thrPath}L${x(thr[thr.length - 1].block).toFixed(1)},${y(yMax)}L${x(thr[0].block).toFixed(1)},${y(yMax)}Z` : ''
  const stepEnd = live && nowBlock != null ? Math.min(nowBlock, domain.to) : pts.length ? pts[pts.length - 1].block : domain.from
  let trajPath = ''
  pts.forEach((p, i) => {
    const px = x(Math.max(p.block, domain.from)), py = y(p.value)
    trajPath += i === 0 ? `M${px.toFixed(1)},${py.toFixed(1)}` : `H${px.toFixed(1)}V${py.toFixed(1)}`
  })
  if (pts.length) trajPath += `H${x(stepEnd).toFixed(1)}`
  const lastValue = pts.length ? pts[pts.length - 1].value : null

  const ticks = useMemo(() => {
    const n = W < 420 ? 3 : 5
    if (elapsedAxis) {
      // Whole days on an elapsed axis: day 0, then an even step.
      const totalDays = ((domain.to - domain.from) * msPerBlock) / 86_400_000
      const step = Math.max(1, Math.ceil(totalDays / (n - 1)))
      const out: number[] = []
      for (let d = 0; d <= totalDays + 1e-9; d += step) out.push(domain.from + (d * 86_400_000) / msPerBlock)
      return out
    }
    return Array.from({ length: n }, (_, i) => domain.from + ((domain.to - domain.from) * i) / (n - 1))
  }, [W, domain.from, domain.to, elapsedAxis, msPerBlock])
  const yTicks = [0, yMax / 2, yMax]

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    if (px < PAD_L || px > W - PAD_R) { setHover(null); return }
    setHover(domain.from + ((px - PAD_L) / innerW) * (domain.to - domain.from))
  }

  const hv = hover != null ? valueAt(pts, hover, true) : null
  const ht = hover != null ? valueAt(thr, hover, false) : null
  const hoverMs = hover != null ? blockToMs(hover, anchors, msPerBlock) : NaN
  const tipLeft = hover != null ? Math.min(Math.max(x(hover), 90), W - 90) : 0

  return (
    <div className={`curve-panel ${tone}`} ref={wrapRef}>
      <div className="curve-head">
        <span className="curve-label"><span className="curve-key" aria-hidden="true" />{label}</span>
        {lastValue != null && <span className="curve-now-value">{pct(lastValue, tone === 'support' ? 2 : 1)}</span>}
        {thr.length > 0 && <span className="curve-key-thr"><span className="curve-dash" aria-hidden="true" />threshold</span>}
      </div>
      {width > 0 && (
        <svg width={W} height={H} className="curve-svg" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img"
          aria-label={`${label}${lastValue != null ? ` ${pct(lastValue)}` : ''}${thr.length ? `, threshold from ${pct(thr[0].value)} falling to ${pct(thr[thr.length - 1].value)}` : ''}`}>
          {yTicks.map(t => (
            <g key={t}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} className="curve-grid" />
              <text x={PAD_L - 6} y={y(t) + 3} className="curve-axis" textAnchor="end">{pct(t, 0)}</text>
            </g>
          ))}
          {ticks.map((b, i) => (
            <text key={i} x={x(b)} y={H - 6} className="curve-axis" textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}>
              {elapsedAxis ? `day ${Math.round(((b - domain.from) * msPerBlock) / 86_400_000)}` : humanDate(blockToMs(b, anchors, msPerBlock), false).replace(/^\w+ /, '')}
            </text>
          ))}
          {passArea && <path d={passArea} className="curve-pass" />}
          {thrPath && <path d={thrPath} className="curve-thr" />}
          {confirmStart != null && confirmStart >= domain.from && confirmStart <= domain.to && (
            <g>
              <line x1={x(confirmStart)} x2={x(confirmStart)} y1={PAD_T} y2={PAD_T + innerH} className="curve-mark" />
              <text x={x(confirmStart) + 4} y={PAD_T + 10} className="curve-axis">confirming</text>
            </g>
          )}
          {trajPath && <path d={trajPath} className="curve-line" />}
          {live && lastValue != null && projectTo != null && nowBlock != null && projectTo > nowBlock && (
            <line x1={x(Math.min(nowBlock, domain.to))} x2={x(Math.min(projectTo, domain.to))} y1={y(lastValue)} y2={y(lastValue)} className="curve-proj" />
          )}
          {live && nowBlock != null && nowBlock >= domain.from && nowBlock <= domain.to && (
            <g>
              <line x1={x(nowBlock)} x2={x(nowBlock)} y1={PAD_T} y2={PAD_T + innerH} className="curve-now" />
              <text x={x(nowBlock)} y={PAD_T - 1} className="curve-axis curve-now-label" textAnchor="middle">now</text>
            </g>
          )}
          {lastValue != null && <circle cx={x(stepEnd)} cy={y(lastValue)} r={4} className="curve-dot" />}
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={PAD_T + innerH} className="curve-cross" />}
        </svg>
      )}
      {hover != null && (
        <div className="curve-tip" style={{ left: tipLeft }}>
          <div className="curve-tip-date">{elapsedAxis ? `${(((hover - domain.from) * msPerBlock) / 86_400_000).toFixed(1)} days in` : Number.isFinite(hoverMs) ? humanDate(hoverMs) : '—'}{hover > (nowBlock ?? Infinity) ? ' (ahead)' : ''}</div>
          {hv != null && hover <= stepEnd && <div>{label}: <strong>{pct(hv, 2)}</strong></div>}
          {ht != null && <div>Needs: <strong>{pct(ht, 2)}</strong></div>}
          <div className="curve-tip-block">block ≈ {F.int(Math.round(hover))}</div>
        </div>
      )}
    </div>
  )
}

/** The referendum page's chart: approval and support with their thresholds. */
/** `legend={false}`: the caption keeps only what is particular to this referendum's chart (the page states the legend elsewhere). */
export function TallyChart({ history, headBlock, headMs, msPerBlock, legend = true }: { history: TallyHistory; headBlock: number | null; headMs?: number | null; msPerBlock: number; legend?: boolean }) {
  const live = history.concludedBlock == null
  const anchors = useMemo<TimeAnchor[]>(() => history.points.flatMap(p => (p.ts ? [{ block: p.block, ms: Date.parse(p.ts) }] : [])), [history.points])
  const start = history.decisionStartBlock ?? history.submittedBlock ?? history.points[0]?.block ?? 0
  const decisionEnd = history.decisionStartBlock != null && history.decisionPeriod != null ? history.decisionStartBlock + history.decisionPeriod : null
  const lastPoint = history.points[history.points.length - 1]?.block ?? start
  const end = Math.max(decisionEnd ?? 0, history.concludedBlock ?? 0, live && headBlock ? headBlock : 0, lastPoint, start + 1)
  const from = Math.min(start, history.points[0]?.block ?? start)
  const domain = { from, to: end }

  // While it runs, the axis ahead of the head is the governance clock's line (its
  // anchor and measured pace), the same one every deadline on the page is dated by.
  const timeAnchors = useMemo(() => {
    if (!live || !headBlock) return anchors
    const last = anchors[anchors.length - 1]
    if (last && last.block >= headBlock) return anchors
    const ms = headMs != null && Number.isFinite(headMs) ? headMs : last ? last.ms + (headBlock - last.block) * msPerBlock : NaN
    return Number.isFinite(ms) ? [...anchors, { block: headBlock, ms }] : anchors
  }, [anchors, live, headBlock, headMs, msPerBlock])

  const reliable = history.trajectoryReliable
  const approvalPts = reliable ? history.points.flatMap(p => (p.approval != null ? [{ block: p.block, value: p.approval }] : [])) : []
  const electorate = history.electorate ? Number(history.electorate) : null
  const supportPts = reliable && electorate && electorate > 0
    ? history.points.map(p => ({ block: p.block, value: (Number(p.support) / electorate) * PERBILL }))
    : []
  const approvalThr = history.thresholds.map(t => ({ block: t.block, value: t.approval }))
  const supportThr = history.thresholds.map(t => ({ block: t.block, value: t.support }))
  const supportMax = Math.min(PERBILL, Math.max(...supportThr.map(t => t.value), ...supportPts.map(p => p.value), 0.05 * PERBILL) * 1.15)
  const confirmStart = history.confirmStartBlock

  return (
    <figure className="curve-chart">
      <div className="curve-panels">
        <CurvePanel label="Approval" tone="approval" series={{ thresholds: approvalThr, points: approvalPts }} domain={domain} anchors={timeAnchors}
          msPerBlock={msPerBlock} nowBlock={live ? headBlock : null} projectTo={decisionEnd} confirmStart={confirmStart} yMax={PERBILL} live={live} />
        {supportPts.length > 0 || (live && supportThr.length > 0)
          ? <CurvePanel label="Support" tone="support" series={{ thresholds: supportThr, points: supportPts }} domain={domain} anchors={timeAnchors}
              msPerBlock={msPerBlock} nowBlock={live ? headBlock : null} projectTo={decisionEnd} confirmStart={confirmStart} yMax={supportMax} live={live} />
          : (
            <div className="curve-panel support curve-missing">
              <div className="curve-head"><span className="curve-label"><span className="curve-key" aria-hidden="true" />Support</span></div>
              <p>Support is measured against the HDX in circulation at the time, and that figure is only read while a referendum runs — so a concluded referendum has no support line. Its final support in HDX is stated with the verdict at the top of the page and under Details.</p>
            </div>
          )}
      </div>
      <figcaption className="curve-caption">
        {legend && tallyChartLegend(live)}
        {!reliable && <> <strong>The vote-by-vote line is not drawn:</strong> {history.reason ?? 'it does not reproduce the chain’s tally'}.</>}
        {reliable && history.residual && history.residualShare != null && history.residualShare > 0 && <> The replay leaves {(history.residualShare * 100).toFixed(2)}% of the chain’s turnout unattributed.</>}
        {history.periodsApproximate && <> This referendum ran across a change of block time, so its curve is approximate.</>}
        {live && supportPts.length > 0 && <> Support is shown against today’s HDX in circulation.</>}
      </figcaption>
    </figure>
  )
}

/** A track page's chart: the two threshold curves over the decision period, in days. */
export function TrackCurves({ curve, decisionPeriod, msPerBlock }: { curve: { block: number; approval: number; support: number }[]; decisionPeriod: number; msPerBlock: number }) {
  const anchors: TimeAnchor[] = []
  const supportMax = Math.min(PERBILL, Math.max(...curve.map(c => c.support), 0.05 * PERBILL) * 1.15)
  return (
    <figure className="curve-chart">
      <div className="curve-panels">
        <CurvePanel label="Approval needed" tone="approval" series={{ thresholds: curve.map(c => ({ block: c.block, value: c.approval })) }}
          domain={{ from: 0, to: decisionPeriod }} anchors={anchors} msPerBlock={msPerBlock} nowBlock={null} projectTo={null} confirmStart={null} yMax={PERBILL} live={false} elapsedAxis />
        <CurvePanel label="Support needed" tone="support" series={{ thresholds: curve.map(c => ({ block: c.block, value: c.support })) }}
          domain={{ from: 0, to: decisionPeriod }} anchors={anchors} msPerBlock={msPerBlock} nowBlock={null} projectTo={null} confirmStart={null} yMax={supportMax} live={false} elapsedAxis />
      </div>
      <figcaption className="curve-caption">Dashed line: the bar a referendum must stay above; the tinted area passes. Days from the start of the decision period.</figcaption>
    </figure>
  )
}
