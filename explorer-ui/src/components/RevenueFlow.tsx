import { useEffect, useMemo, useRef, useState } from 'react'
import { AddrPill, F } from './ui'
import { useMediaQuery } from '../hooks/useMediaQuery'
import {
  createFlowScheduler,
  useRevenueFlowStream,
  type FlowEmission,
  type FlowScheduler,
} from '../hooks/useRevenueFlowStream'
import { REVENUE_STREAM_COLOR, REVENUE_STREAM_LABEL } from './revenueColors'

// The revenue river — the page's signature. Every protocol income drifts from
// the right edge into the treasury counter on the left (top → bottom on
// phones): readable pills for incomes worth reading, glowing motes for the
// long tail of tiny ones, one mote per market per block for the borrow drip.
// The counter ticks up when a particle ARRIVES, so the number the eye follows
// is the money that visibly flowed in.
//
// Density is honest by construction: the scheduler paces real items with
// identity-derived jitter and coalesces bursts into merged motes (never
// dropping value — see useRevenueFlowStream). The river pauses while the tab
// is hidden, and `prefers-reduced-motion` swaps the whole animation for a calm
// live ledger of the same items.

interface Particle extends FlowEmission {
  /** Visual params, derived deterministically from the emission id. */
  lane: number
  durationMs: number
  sizePx: number
  /** Signed transform distance to the counter, measured at spawn. */
  travelPx: number
}

function fraction(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 8) / 0x00ffffff
}

/** Mote diameter from value: $0.0001 → ~4px, $0.05 → ~10px. */
function moteSize(usd: number): number {
  const magnitude = Math.log10(Math.max(usd, 0.0001) / 0.0001)
  return Math.round(Math.min(11, 4 + magnitude * 2.4))
}

function toParticle(e: FlowEmission, vertical: boolean, fullscreen: boolean, travelPx: number): Particle {
  const laneSeed = fraction(`${e.id}:lane`)
  const paceSeed = fraction(`${e.id}:pace`)
  const base = vertical ? 8_000 : 12_000
  return {
    ...e,
    lane: 10 + laneSeed * 74,
    durationMs: Math.round((base + paceSeed * base * 0.4) * (fullscreen ? 1.25 : 1)),
    // Network fees are rare (about one a minute) AND tiny (half a cent), so
    // pure value-sizing made the stream read as absent; floor their motes at a
    // clearly visible size — rarity already keeps them honest.
    sizePx: e.kind === 'merged' ? 13 : e.stream === 'network_fee' ? Math.max(9, moteSize(e.usd)) : moteSize(e.usd),
    travelPx,
  }
}

/** Module-level so the scheduler's clock is not an impure closure made in render. */
const nowMs = () => Date.now()

const DESKTOP_MAX_ACTIVE = 90
const MOBILE_MAX_ACTIVE = 40
const FULLSCREEN_MAX_ACTIVE = 160
/** Below this an income is a mote; at or above, a readable pill. */
const PILL_THRESHOLD_USD = 0.05

export function RevenueFlow() {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const vertical = useMediaQuery('(max-width: 720px)')

  // One scheduler per mounted river (lazy state init, never recreated): its
  // session total is the number the counter shows.
  const [scheduler] = useState<FlowScheduler>(() => createFlowScheduler({
    blockMs: 6_000,
    maxActive: DESKTOP_MAX_ACTIVE,
    pillThresholdUsd: PILL_THRESHOLD_USD,
    now: nowMs,
  }))
  useRevenueFlowStream(scheduler)

  const [fullscreen, setFullscreen] = useState(false)
  const [hidden, setHidden] = useState(typeof document !== 'undefined' && document.hidden)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scheduler.setMaxActive(fullscreen ? FULLSCREEN_MAX_ACTIVE : vertical ? MOBILE_MAX_ACTIVE : DESKTOP_MAX_ACTIVE)
  }, [scheduler, fullscreen, vertical])

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  function toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen()
    else if (panelRef.current?.requestFullscreen) void panelRef.current.requestFullscreen()
  }

  // Arrived money: the counter the river pours into. Ticks on particle arrival
  // (ledger rows count immediately — nothing visibly flows there).
  const [arrivedUsd, setArrivedUsd] = useState(0)
  const [pulse, setPulse] = useState(0)
  const [particles, setParticles] = useState<Particle[]>([])
  const [ledger, setLedger] = useState<FlowEmission[]>([])

  useEffect(() => {
    if (hidden) return
    let frame = 0
    const loop = () => {
      const due = scheduler.drain(Date.now())
      if (due.length) {
        if (reducedMotion) {
          setLedger(prev => [...due.reverse(), ...prev].slice(0, 14))
          setArrivedUsd(prev => prev + due.reduce((s, e) => s + e.usd, 0))
        } else {
          // Travel distance measured from the live stage box, so the transform
          // animation (compositor-only, no per-frame layout) ends at the counter.
          const stage = panelRef.current
          const travel = vertical
            ? (stage ? stage.clientHeight : 420) - 140
            : -(((stage ? stage.clientWidth : 1200)) - 172)
          setParticles(prev => [...prev, ...due.map(e => toParticle(e, vertical, fullscreen, travel))].slice(-200))
        }
      }
      frame = window.requestAnimationFrame(loop)
    }
    frame = window.requestAnimationFrame(loop)
    return () => window.cancelAnimationFrame(frame)
  }, [scheduler, reducedMotion, vertical, fullscreen, hidden])

  function arrive(particle: Particle): void {
    setParticles(prev => prev.filter(p => p.id !== particle.id))
    setArrivedUsd(prev => prev + particle.usd)
    setPulse(p => p + 1)
  }

  const streams = useMemo(() => Object.entries(REVENUE_STREAM_LABEL) as [keyof typeof REVENUE_STREAM_LABEL, string][], [])

  if (reducedMotion) {
    return (
      <div className="rev-river rev-ledger-mode">
        <div className="rev-counter" aria-live="off">
          <div className="rev-counter-num mono">{F.usd(arrivedUsd)}</div>
          <div className="rev-counter-sub">collected while watching</div>
        </div>
        <div className="rev-ledger">
          {ledger.length === 0 && <div className="rev-empty">Waiting for the next income…</div>}
          {ledger.map(e => (
            <div className="rev-ledger-row" key={e.id}>
              <span className="rev-dot" style={{ background: REVENUE_STREAM_COLOR[e.stream] }} />
              <span className="rev-ledger-label">
                {e.item?.account
                  ? <AddrPill account={e.item.account} noCopy />
                  : (e.label ?? REVENUE_STREAM_LABEL[e.stream])}
              </span>
              <span className="mono">{F.usd(e.usd)}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={panelRef}
      className={`rev-river${vertical ? ' rev-vertical' : ''}${hidden ? ' rev-paused' : ''}${fullscreen ? ' rev-fullscreen' : ''}`}
    >
      <div className="rev-current" aria-hidden="true" />
      <div className={`rev-counter${pulse % 2 === 0 ? ' pulse-a' : ' pulse-b'}`}>
        <div className="rev-counter-num mono">{F.usd(arrivedUsd)}</div>
        <div className="rev-counter-sub">collected while watching</div>
      </div>
      <button
        type="button"
        className="rev-fs-btn"
        onClick={toggleFullscreen}
        aria-label={fullscreen ? 'Exit full screen' : 'Watch full screen'}
        title={fullscreen ? 'Exit full screen' : 'Watch full screen'}
      >
        {fullscreen ? '✕' : '⛶'}
      </button>
      <div className="rev-stage" aria-hidden={particles.length === 0 ? undefined : true}>
        {particles.map(p => (
          p.kind === 'pill' && p.item ? (
            <div
              key={p.id}
              className="rev-particle rev-pill"
              style={{ '--lane': `${p.lane}%`, '--dur': `${p.durationMs}ms`, '--travel': `${p.travelPx}px` } as React.CSSProperties}
              onAnimationEnd={() => arrive(p)}
            >
              <span className="rev-dot" style={{ background: REVENUE_STREAM_COLOR[p.stream] }} />
              {p.item.account ? (
                <AddrPill account={p.item.account} noCopy />
              ) : (
                <span className="rev-pill-label">{REVENUE_STREAM_LABEL[p.stream]}</span>
              )}
              <span className="rev-pill-usd mono">{F.usd(p.usd)}</span>
            </div>
          ) : (
            <span
              key={p.id}
              className={`rev-particle rev-mote${p.kind === 'merged' ? ' rev-merged' : ''}`}
              title={`${p.label ?? REVENUE_STREAM_LABEL[p.stream]} · ${F.usd(p.usd)}`}
              style={{
                '--lane': `${p.lane}%`,
                '--dur': `${p.durationMs}ms`,
                '--travel': `${p.travelPx}px`,
                '--size': `${p.sizePx}px`,
                '--tint': REVENUE_STREAM_COLOR[p.stream],
              } as React.CSSProperties}
              onAnimationEnd={() => arrive(p)}
            />
          )
        ))}
      </div>
      <div className="rev-river-foot">
        <span className="rev-legend">
          {streams.map(([key, label]) => (
            <span className="rev-legend-item" key={key}>
              <span className="rev-dot" style={{ background: REVENUE_STREAM_COLOR[key] }} />
              {label}
            </span>
          ))}
        </span>
      </div>
    </div>
  )
}
