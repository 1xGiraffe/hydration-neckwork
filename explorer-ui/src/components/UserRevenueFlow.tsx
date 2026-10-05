import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Usd, F } from './ui'
import { RiverFullscreenButton, RiverLegend, type RiverProps } from './RevenueFlow'
import { useRevenueHollarColor } from '../hooks/useRevenueHollarColor'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { subscribeFrame } from '../hooks/flowLoop'
import { createRateScheduler, useUserRevenueFlowStream, type RateEmission, type RateScheduler } from '../hooks/useUserRevenueFlowStream'
import { userRevenueColor, userRevenueLegendItems } from './revenueColors'
import type { UserRevenueFlowResponse } from '../types'

// The user river — the twin of the protocol river (RevenueFlow.tsx), SIGNED:
// what users earn drifts in from the right into the counter; what they pay
// (borrow interest, exit fees, staking forfeits) leaves the counter and drifts
// out to the "paid" sink (top on phones) — in its own stream's colour, drawn
// hollow: sign is a treatment, never a colour (revenueColors.ts). The counter shows
// the NET. It streams the newest folded hour's measured rate per block (see
// useUserRevenueFlowStream.ts) and says which hour that is. Both rivers draw on
// the one shared frame loop (flowLoop.ts) and split one particle budget; with
// prefers-reduced-motion there are no particles at all — the counter and a
// static ledger of the hour's signed rows. Full screen is the page's (one view,
// both rivers): the river only renders the button and adapts to `fullscreen`.

interface Particle extends RateEmission {
  lane: number
  durationMs: number
  sizePx: number
  travelPx: number
  out: boolean
}

function fraction(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 8) / 0x00ffffff
}

/** Mote diameter from magnitude: $0.01 → ~5px, $0.05 → ~9px. */
function moteSize(usd: number): number {
  const magnitude = Math.log10(Math.max(Math.abs(usd), 0.001) / 0.001)
  return Math.round(Math.min(11, 3 + magnitude * 2.6))
}

const nowMs = () => Date.now()
/** An accumulated amount is worth a particle from one cent. */
const EMIT_USD = 0.01
const PILL_USD = 0.05
const STRAY_MS = 90_000
const fmtHourUtc = (iso: string): string => `${iso.slice(11, 16)} UTC ${iso.slice(0, 10)}`

export function UserRevenueFlow({ maxActive = { desktop: 90, mobile: 20 }, fullscreen = false, onToggleFullscreen }: RiverProps) {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  // Full screen always runs left to right: its cells are wider than tall even stacked on a phone.
  const vertical = useMediaQuery('(max-width: 720px)') && !fullscreen
  const [scheduler] = useState<RateScheduler>(() => createRateScheduler({ emitUsd: EMIT_USD, pillUsd: PILL_USD, maxActive: maxActive.desktop, now: nowMs }))
  const [rates, setRates] = useState<UserRevenueFlowResponse | null>(null)
  const onRates = useCallback((r: UserRevenueFlowResponse) => setRates(r), [])
  useUserRevenueFlowStream(scheduler, onRates)
  useRevenueHollarColor()

  useEffect(() => {
    scheduler.setMaxActive(vertical ? maxActive.mobile : maxActive.desktop)
  }, [scheduler, vertical, maxActive.mobile, maxActive.desktop])

  const stageRef = useRef<HTMLDivElement>(null)
  const particlesRef = useRef<Particle[]>([])
  const [particles, setParticles] = useState<Particle[]>([])
  const [netUsd, setNetUsd] = useState(0)
  const [paidUsd, setPaidUsd] = useState(0)
  const [pulse, setPulse] = useState(0)
  // The layout the particles in flight were measured for.
  const layoutRef = useRef(`${fullscreen}:${vertical}`)

  useEffect(() => {
    const onFrame = (now: number) => {
      const { due, credit } = scheduler.drain(now)
      let netDelta = credit
      let paidDelta = credit < 0 ? -credit : 0
      // Travel is measured at spawn: particles in flight when the stage
      // changes size (full screen in or out, a rotation past the breakpoint)
      // settle at once — incomes into the net, costs into the sink — rather
      // than stopping short or overshooting their target.
      const layout = `${fullscreen}:${vertical}`
      if (layoutRef.current !== layout) {
        layoutRef.current = layout
        const flown = particlesRef.current
        if (flown.length) {
          for (const p of flown) {
            netDelta += p.usd
            if (p.out) paidDelta += -p.usd
          }
          particlesRef.current = []
          setParticles([])
          scheduler.setInFlight(0)
        }
      }
      if (!due.length && netDelta === 0) {
        // Prune strays a freeze swallowed the animationend of (value already counted on spawn for outflows).
        if (particlesRef.current.some(p => now - p.at > STRAY_MS)) {
          const kept = particlesRef.current.filter(p => {
            if (now - p.at <= STRAY_MS) return true
            netDelta += p.usd
            if (p.out) paidDelta += -p.usd
            return false
          })
          particlesRef.current = kept
          setParticles(kept)
          scheduler.setInFlight(kept.length)
          if (netDelta) setNetUsd(v => v + netDelta)
          if (paidDelta) setPaidUsd(v => v + paidDelta)
        }
        return
      }
      if (reducedMotion) {
        for (const e of due) {
          netDelta += e.usd
          if (e.usd < 0) paidDelta += -e.usd
        }
      } else if (due.length) {
        const stage = stageRef.current
        const w = stage ? stage.clientWidth : 1200
        const h = stage ? stage.clientHeight : 420
        const spawned = due.map(e => {
          const out = e.usd < 0
          const laneSeed = fraction(`${e.id}:lane`)
          const paceSeed = fraction(`${e.id}:pace`)
          const base = (vertical ? 7_000 : 11_000) * (fullscreen ? 1.25 : 1)
          const travel = vertical
            ? (out ? -(h - 190) : h - 140)
            : (out ? w - 172 - 96 : -(w - 172))
          return {
            ...e,
            out,
            lane: 10 + laneSeed * 70,
            durationMs: Math.round(base + paceSeed * base * 0.4),
            sizePx: moteSize(e.usd),
            travelPx: travel,
          }
        })
        const next = [...particlesRef.current, ...spawned]
        particlesRef.current = next
        setParticles(next)
        scheduler.setInFlight(next.length)
      }
      if (netDelta) setNetUsd(v => v + netDelta)
      if (paidDelta) setPaidUsd(v => v + paidDelta)
    }
    return subscribeFrame(onFrame)
  }, [scheduler, reducedMotion, vertical, fullscreen])

  function arrive(p: Particle): void {
    particlesRef.current = particlesRef.current.filter(x => x.id !== p.id)
    setParticles(particlesRef.current)
    scheduler.setInFlight(particlesRef.current.length)
    // Both directions settle on ARRIVAL — an income at the counter, a cost at
    // the sink — so the net never runs ahead of what visibly flowed.
    setNetUsd(v => v + p.usd)
    if (p.out) setPaidUsd(v => v - p.usd)
    else setPulse(x => x + 1)
  }

  const ledger = useMemo(() => (rates?.drips ?? []).slice(0, 12), [rates])
  const legendItems = useMemo(() => userRevenueLegendItems(rates?.drips ?? []), [rates])
  const legend = <RiverLegend items={legendItems} label="User Revenue streams" />
  // Revisable streams (token accrual, farms, voting) stream their trailing-24h mean: their newest hours are not decided yet.
  const hourLabel = rates?.hour
    ? `streaming the hour from ${fmtHourUtc(rates.hour)}${rates.revisableMeanHours ? `; token, farm and voting streams at their ${rates.revisableMeanHours}h mean` : ''}`
    : 'waiting for the newest published hour'

  if (reducedMotion) {
    return (
      <>
      <div className={`rev-river rev-ledger-mode ur-river${fullscreen ? ' rev-fullscreen' : ''}`}>
        {onToggleFullscreen && <RiverFullscreenButton fullscreen={fullscreen} onToggle={onToggleFullscreen} />}
        <div className="rev-counter" aria-live="off">
          <div className="rev-counter-num mono"><Usd v={netUsd} /></div>
          <div className="rev-counter-sub">net earned by users while watching · {hourLabel}</div>
        </div>
        <div className="rev-ledger">
          {ledger.length === 0 && <div className="rev-empty">No published hour yet.</div>}
          {ledger.map(d => {
            const perHour = rates ? d.usdPerBlock * (3_600 / rates.blockSeconds) : 0
            return (
              <div className="rev-ledger-row" key={d.key}>
                <span
                  className={`rev-dot${perHour < 0 ? ' rev-dot-out' : ''}`}
                  style={(perHour < 0 ? { '--tint': userRevenueColor(d.stream) } : { background: userRevenueColor(d.stream) }) as React.CSSProperties}
                />
                <span className="rev-ledger-label">{d.label}</span>
                <span className={`mono${perHour < 0 ? ' ur-neg' : ''}`}>{F.usd(perHour)}/h</span>
              </div>
            )
          })}
        </div>
      </div>
      {legend}
      </>
    )
  }

  return (
    <>
    <div className={`rev-river ur-river${vertical ? ' rev-vertical' : ''}${fullscreen ? ' rev-fullscreen' : ''}`}>
      <div className="rev-current" aria-hidden="true" />
      {onToggleFullscreen && <RiverFullscreenButton fullscreen={fullscreen} onToggle={onToggleFullscreen} />}
      <div className={`rev-counter${pulse % 2 === 0 ? ' pulse-a' : ' pulse-b'}`}>
        <div className="rev-counter-num mono"><Usd v={netUsd} /></div>
        <div className="rev-counter-sub">net earned by users while watching</div>
      </div>
      <div className="ur-sink" title="Costs users paid: HOLLAR and other borrow interest, exit fees, forfeited staking rewards">
        <span className="ur-sink-k">paid</span>
        <span className="ur-sink-v mono"><Usd v={paidUsd > 0 ? -paidUsd : 0} /></span>
      </div>
      <div className="rev-stage" ref={stageRef} aria-hidden={particles.length === 0 ? undefined : true}>
        {particles.map(p => {
          const tint = userRevenueColor(p.stream)
          const style = { '--lane': `${p.lane}%`, '--dur': `${p.durationMs}ms`, '--travel': `${p.travelPx}px`, '--size': `${p.sizePx}px`, '--tint': tint } as React.CSSProperties
          return p.kind === 'pill' ? (
            <div key={p.id} className={`rev-particle rev-pill${p.out ? ' rev-out' : ''}`} style={style} onAnimationEnd={() => arrive(p)}>
              <span className={`rev-dot${p.out ? ' rev-dot-out' : ''}`} style={p.out ? undefined : { background: tint }} />
              <span className="rev-pill-label">{p.label}</span>
              <span className={`rev-pill-usd mono${p.out ? ' ur-neg' : ''}`}>{F.usd(p.usd)}</span>
            </div>
          ) : (
            <span
              key={p.id}
              className={`rev-particle rev-mote${p.out ? ' rev-out' : ''}`}
              title={`${p.label} · ${F.usd(p.usd)}`}
              style={style}
              onAnimationEnd={() => arrive(p)}
            />
          )
        })}
      </div>
      <div className="rev-river-foot">
        <span className="ur-foot-note">{hourLabel}</span>
      </div>
    </div>
    {legend}
    </>
  )
}
