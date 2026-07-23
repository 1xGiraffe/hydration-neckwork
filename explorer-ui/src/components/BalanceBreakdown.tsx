import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { F, compactAmount } from './ui'
import { lockColor } from './HdxCharts'
import type { AddressBalance, BalanceLockComponent, BalanceUnlockSlice } from '../types'

// Compact per-asset lock/reserve view for the balances-treemap inspector
// (accounts and tags alike — tag figures are the members' components summed).
//
// One bar aggregates everything: transferable, then the BINDING unlock timeline
// (locks overlap, so the server decomposes frozen = the largest lock into
// time-ordered slices — colored by the lock that causes each slice, toned by
// how soon it frees, linear vesting fading out), then the static reserves
// (DCA/OTC orders, deposits — they release only when cancelled or cleared).
// Below it, the unlock schedule answers the actual question: WHEN does HOW MUCH
// unlock, and WHY is it locked.

const big = (v: string | undefined | null) => { try { return BigInt(v || '0') } catch { return 0n } }
const min = (a: bigint, b: bigint) => (a < b ? a : b)

interface SourceMeta { label: string; color: string }
// Lock hues come from the shared lock palette (lockColor) so this bar and the
// /hdx dashboard stay in parity: transferable light blue, vote (new + old)
// lavender, staking purple, vesting red (gradient when linear), GHDX brand
// black with dark-grey unstake batches, and ONE blue for every clearable
// deposit/order. Names are singular; GHDX is abbreviated to fit the dense bar.
const SOURCE_META: Record<string, SourceMeta> = {
  vesting: { label: 'vesting', color: lockColor('vesting') },
  staking: { label: 'staking', color: lockColor('staking') },
  vote: { label: 'vote', color: lockColor('vote') },
  gigahdx: { label: 'GHDX', color: lockColor('gigahdx') },
  democracy: { label: 'vote (old)', color: lockColor('vote') },
  elections: { label: 'council elections (legacy)', color: 'var(--text-low)' },
  sufficiency: { label: 'ED cover', color: 'var(--text-low)' },
  dca: { label: 'DCA budget', color: 'var(--bd-clear)' },
  otc: { label: 'OTC order', color: 'var(--bd-clear)' },
  preimage: { label: 'preimage deposit', color: 'var(--bd-clear)' },
  identity: { label: 'identity deposit', color: 'var(--bd-clear)' },
  proxy: { label: 'proxy deposit', color: 'var(--bd-clear)' },
  multisig: { label: 'multisig deposit', color: 'var(--bd-clear)' },
  referenda: { label: 'referenda deposits', color: 'var(--bd-clear)' },
  other: { label: 'other', color: 'var(--bd-clear)' },
}
// Running/matured GHDX unstake batches: dark grey, distinct from staked black.
const GHDX_UNSTAKE_GREY = '#5c6270'
const sourceMeta = (source: string): SourceMeta => SOURCE_META[source] ?? { label: source, color: 'var(--text-low)' }
// 'vote+staking' ties → "votes + staking", colored by the first cause.
const causeLabel = (cause: string) => cause.split('+').map(c => sourceMeta(c).label).join(' + ')
const causeColor = (cause: string) => sourceMeta(cause.split('+')[0]).color

// Ordinal same-hue tones: sooner-free = lighter ("shadows" of the cause color).
// GIGAHDX's brand black can't lighten toward the dark surface, so its shades
// mix toward a neutral slate that works on both themes.
const tone = (color: string, pct: number) =>
  `color-mix(in srgb, ${color} ${pct}%, ${color === '#000000' ? '#98a0b4' : 'var(--bg-elev)'})`

// Time left until an estimated unlock, in days ("18h" under 1.5 days) — never
// calendar dates.
function fmtIn(until: string): string {
  const t = new Date(until.replace(' ', 'T') + 'Z').getTime()
  if (Number.isNaN(t)) return ''
  const days = (t - Date.now()) / 86400e3
  if (days <= 0) return 'now'
  if (days < 1.5) return `${Math.max(1, Math.round(days * 24))}h`
  return `${Math.round(days)}d`
}

// "in 21d" / "now" (just matured) / "" (no estimate) — never "in now" or a
// dangling "in ".
function relWhen(until: string | undefined): string {
  const w = until ? fmtIn(until) : ''
  return !w ? '' : w === 'now' ? 'now' : `in ${w}`
}

// One row of the unlock schedule: reason · how much · lock-duration description.
interface ScheduleRow { key: string; cause: string; amount: bigint; desc?: string; color: string; toneOverride?: string; gradient?: boolean }

// Static reserve-side rows collapse into as few slices as possible: DCA and OTC
// orders stay their own (product) slices; every deposit-shaped rest — identity,
// proxy, multisig, referenda, preimages, plus whatever stays unattributed —
// merges into ONE "until cleared" slice named by its parts.
function mergeStatics(statics: BalanceLockComponent[]): { label: string; color: string; amount: bigint; detail: string }[] {
  const orders = statics.filter(c => c.source === 'dca' || c.source === 'otc')
  const deposits = statics.filter(c => c.source !== 'dca' && c.source !== 'otc')
  const out = orders.map(c => ({
    label: c.source === 'otc' ? 'OTC' : 'DCA',
    color: sourceMeta(c.source).color,
    amount: big(c.amount),
    detail: c.source === 'otc' ? 'until pulled' : 'until cancelled',
  }))
  if (deposits.length) {
    out.push({
      label: 'deposits',
      color: 'var(--bd-clear)',
      amount: deposits.reduce((s, c) => s + big(c.amount), 0n),
      detail: 'until cleared',
    })
  }
  return out
}

type Segment = { key: string; background: string; value: number; tip: ReactNode }

// The aggregated composition bar: div-based so slices can carry gradients;
// 2px surface gaps between slices; per-slice hover tooltip below the bar.
function AggregateBar({ segments }: { segments: Segment[] }) {
  const [hover, setHover] = useState<{ leftPct: number; tip: ReactNode } | null>(null)
  const totalPct = segments.reduce((s, x) => s + x.value, 0)
  if (totalPct <= 0) return null
  const placed = segments.reduce<(typeof segments[number] & { x0: number; w: number })[]>((acc, s, i) => {
    const x0 = i === 0 ? 0 : acc[i - 1].x0 + acc[i - 1].w
    acc.push({ ...s, x0, w: s.value / totalPct * 100 })
    return acc
  }, [])
  return (
    <div className="hdx-chart-wrap" onMouseLeave={() => setHover(null)}>
      <div className="bd-agg" aria-hidden="true">
        {placed.map(s => (
          <span
            key={s.key} className="bd-agg-seg"
            style={{ left: `${s.x0}%`, width: `max(2px, calc(${s.w.toFixed(3)}% - 1px))`, background: s.background }}
            onMouseEnter={() => setHover({ leftPct: s.x0 + s.w / 2, tip: s.tip })}
          />
        ))}
      </div>
      {hover && <div className="hdx-tip" style={{ left: `${Math.min(88, Math.max(12, hover.leftPct))}%`, top: 22 }}>{hover.tip}</div>}
    </div>
  )
}

// Desktop-only floor: how wide the bar must stay to still read as a useful
// composition bar (a few legible segments) when it shares a line with the
// legend in Variant A, rather than being squeezed to a sliver.
const MIN_BAR_PX = 240
// Gap between the bar and the legend when they share a line (Variant A).
const BAND_GAP_PX = 14

// Adaptive desktop layout: Variant A puts the bar and the (single-line)
// legend on one row below a lone "Locks" label when there's room; Variant B
// (today's layout) keeps the label beside the bar and drops the legend to
// its own row when the legend is too wide to share a line with a useful bar.
// Decided by measuring the legend's real single-line width (item count and
// note lengths both affect it) against the available container width — not
// a fixed breakpoint — and re-measured whenever that content changes or the
// container resizes. Mobile (≤720px) always renders the Variant B markup;
// CSS alone forces both variants into the same stacked mobile look, so the
// measurement result never matters there.
function BreakdownBand({ rows, segments, legendContent }: {
  rows: ScheduleRow[]; segments: Segment[]; legendContent: (r: ScheduleRow) => ReactNode
}) {
  const bandRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  // Optimistic default (share the line); corrected synchronously by the
  // layout effect below before the browser paints, so there's no flicker.
  const [shareLine, setShareLine] = useState(true)

  // A stable signature of the legend's actual content — changes only when
  // the item set itself changes (not on every unrelated re-render), so the
  // measurement effect re-runs exactly when it needs to (in addition to
  // container resizes, handled by the ResizeObserver below).
  const legendKey = rows.map(r => `${r.key}:${r.cause}:${r.amount}:${r.desc ?? ''}`).join('|')

  useLayoutEffect(() => {
    const el = bandRef.current
    if (!el) return
    const measure = () => {
      const legendWidth = measureRef.current?.scrollWidth ?? 0
      setShareLine(legendWidth + MIN_BAR_PX + BAND_GAP_PX <= el.clientWidth)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    // legendKey covers content changes; the observer covers container resize.
  }, [legendKey])

  const legend = rows.length > 0 && (
    <div className="bd-sched" role="list" aria-label="Unlock schedule">
      {rows.map(r => <div className="bd-sched-row" role="listitem" key={r.key}>{legendContent(r)}</div>)}
    </div>
  )

  return (
    <div ref={bandRef} className="tm-breakdown" data-testid="balance-breakdown">
      {/* Off-screen, non-wrapping clone of the legend — rendered only to
          measure its true single-line width via scrollWidth; never shown. */}
      <div ref={measureRef} className="bd-legend-measure" aria-hidden="true">
        {rows.map(r => <span className="bd-sched-row" key={r.key}>{legendContent(r)}</span>)}
      </div>
      {shareLine ? (
        <>
          <span className="tm-metric-label">Locks</span>
          <div className="bd-row2">
            <AggregateBar segments={segments} />
            {legend}
          </div>
        </>
      ) : (
        <>
          <div className="bd-row1">
            <span className="tm-metric-label">Locks</span>
            <AggregateBar segments={segments} />
          </div>
          {legend}
        </>
      )}
    </div>
  )
}

// Open-ended slices describe what must happen before they can free.
function openEndedWhen(cause: string): { detail?: string } {
  const first = cause.split('+')[0]
  if (first === 'staking') return { detail: 'unstake to free' }
  if (first === 'gigahdx') return { detail: 'staked · 28d unbond' }
  if (first === 'vote' || first === 'democracy') return { detail: 'while voting/delegating' }
  if (first === 'elections') return { detail: 'orphaned lock' }
  return {}
}

export function BalanceBreakdown({ balance }: { balance: AddressBalance }) {
  const { asset } = balance
  const dec = asset.decimals
  const free = big(balance.free)
  const reserved = big(balance.reserved)
  const total = free + reserved
  // The lock snapshot lags live balances by up to its refresh interval; clamp so
  // the bar never shows a negative transferable slice.
  const frozen = min(big(balance.frozen), free)
  const transferable = free - frozen
  const components = balance.breakdown ?? []
  if (total <= 0n || (frozen <= 0n && reserved <= 0n && !components.length)) return null

  // Static reserve side: named reserves, holds and deposits + the unattributed rest.
  const statics: BalanceLockComponent[] = components.filter(c => c.kind !== 'lock' && big(c.amount) > 0n)
  const staticCovered = statics.reduce((s, c) => s + big(c.amount), 0n)
  if (reserved > staticCovered) statics.push({ kind: 'reserve', source: 'other', amount: (reserved - staticCovered).toString() })

  // Binding unlock timeline; without one (old snapshot rows), the whole frozen
  // amount renders as one open-ended slice caused by the largest lock.
  const largestLock = components.filter(c => c.kind === 'lock').sort((a, b) => (big(b.amount) > big(a.amount) ? 1 : -1))[0]
  const timeline: BalanceUnlockSlice[] = balance.timeline?.length
    ? balance.timeline
    : frozen > 0n ? [{ state: 'active', cause: largestLock?.source ?? 'other', amount: frozen.toString() }] : []

  // Schedule rows in the reading order: releasable now → the "until …" group
  // (merged deposits, orders, open-ended floors) → dated releases ascending, so
  // the right edge of the bar is the longest-locked balance.
  const releasableRows: ScheduleRow[] = []
  const openRows: ScheduleRow[] = []
  const datedRows: ScheduleRow[] = []
  const scheduledSlices = timeline.filter(s => s.state === 'scheduled')
  timeline.forEach((s, i) => {
    const color = causeColor(s.cause)
    const amount = big(s.amount)
    if (s.state === 'releasable') {
      // A releasable gigahdx slice is a MATURED unstake batch awaiting withdrawal.
      const unstake = s.cause === 'gigahdx'
      releasableRows.push({
        key: `t${i}`, cause: unstake ? 'GHDX unstake' : causeLabel(s.cause), amount,
        desc: s.cause === 'staking' ? 'unstake to free' : s.cause.includes('vesting') ? 'claim to free' : 'unlock call away',
        color: unstake ? GHDX_UNSTAKE_GREY : color,
        toneOverride: tone(unstake ? GHDX_UNSTAKE_GREY : color, 38),
      })
    } else if (s.state === 'scheduled') {
      const idx = scheduledSlices.indexOf(s)
      const pct = scheduledSlices.length > 1 ? 55 + Math.round((idx / (scheduledSlices.length - 1)) * 30) : 70
      // A dated (non-conditional) GHDX slice is a running unstake batch —
      // dark grey, distinct from the staked black part which only frees if
      // unstaked now.
      const unstake = s.cause === 'gigahdx' && !s.conditional
      datedRows.push({
        key: `t${i}`, cause: unstake ? 'GHDX unstake' : causeLabel(s.cause), amount,
        desc: [relWhen(s.until), s.linear ? 'vests linearly' : s.conditional ? 'if unstaked now' : ''].filter(Boolean).join(' · ') || 'scheduled',
        color: unstake ? GHDX_UNSTAKE_GREY : color,
        toneOverride: unstake ? GHDX_UNSTAKE_GREY : tone(color, pct),
        gradient: s.linear,
      })
    } else {
      const open = openEndedWhen(s.cause)
      // A known minimum from dated locks underneath (e.g. 5x/6x conviction
      // priors below a still-cast vote): can't free earlier, and the
      // open-ended hold may extend it.
      const notBefore = s.until ? fmtIn(s.until) : ''
      const desc = [notBefore && notBefore !== 'now' ? `≥ ${notBefore}` : undefined, open.detail].filter(Boolean).join(' · ')
      // Open-ended holds render LIGHT (indefinite), dated locks solid — an
      // ongoing vote must not look like a hard vote lock.
      openRows.push({
        key: `t${i}`, cause: causeLabel(s.cause), amount, desc: desc || 'until cleared', color,
        toneOverride: `color-mix(in srgb, ${color} 52%, white)`,
      })
    }
  })
  // Static rows lead with the reason itself (OTC / DCA / deposits); the
  // duration description is just "until pulled/cancelled/cleared".
  const staticRows: ScheduleRow[] = mergeStatics(statics).map((m, i) => ({
    key: `s${i}`, cause: m.label, amount: m.amount, desc: m.detail, color: m.color,
  }))
  // Reading order = time to liquidity, ascending: transferable, then
  // everything the owner can clear by acting now (releasable, deposits and
  // orders, still-cast votes), then the hard time locks in date order.
  const rows: ScheduleRow[] = [
    { key: 'free', cause: 'free', amount: transferable, color: 'var(--bd-free)' },
    ...releasableRows,
    ...staticRows,
    ...openRows,
    ...datedRows,
  ]

  // A row's color: the tone-shaded shade when there is one (dated/releasable
  // slices), the plain cause color otherwise (transferable, statics).
  const rowColor = (r: ScheduleRow) => (r.toneOverride && !r.gradient ? r.toneOverride : r.color)
  // Row content is shared between the legend list and each bar segment's
  // hover tip, so a hover always reads exactly like its legend row — same
  // dot, name and compact amount, same muted note, and (unlike the old
  // tooltip) no USD figure.
  const legendContent = (r: ScheduleRow): ReactNode => (
    <>
      <i className="bd-dot" style={{ background: rowColor(r) }} aria-hidden="true" />
      <span className="bd-cause">{r.cause}</span>
      <span className="bd-sched-amt">{compactAmount(F.num(r.amount.toString(), dec))}</span>
      {r.desc && <span className="bd-note">{r.desc}</span>}
    </>
  )

  // The aggregated bar mirrors the schedule rows 1:1. A div bar (not SVG) so
  // the linear-vesting slice can fade with a CSS gradient.
  const segments = rows.map(r => ({
    key: r.key,
    background: r.gradient
      ? `linear-gradient(90deg, ${tone(r.color, 72)}, ${tone(r.color, 24)})`
      : (r.toneOverride ?? r.color),
    value: Number(r.amount * 10_000n / (total || 1n)) / 100,
    tip: <span className="bd-tip-row">{legendContent(r)}</span>,
  })).filter(s => s.value > 0)

  return <BreakdownBand rows={rows} segments={segments} legendContent={legendContent} />
}
