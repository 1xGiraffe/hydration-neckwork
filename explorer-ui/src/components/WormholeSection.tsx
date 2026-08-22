import type { ReactNode } from 'react'
import { Link, paths } from '../router'
import {
  AddrPill, Ago, AssetChip, ChartSkeleton, Copy, Dash, EmptyRow, F, MomentLink, TableSkeleton, assetBrandColor, compactAmount,
} from './ui'
import { DashboardSectionTitle as SecTitle } from './DashboardPrimitives'
import { useWormholeBridge } from '../hooks/useExplorerData'
import { WORMHOLE_STATUS, fmtDuration, fmtPct, loadColor, wormholeExplorerLink, wormholescanLink } from '../utils/security'
import { parseUtcTimestamp } from '../utils/time'
import type {
  AssetRef, WormholeAssetRow, WormholeBridgeDetail, WormholeFuse, WormholeInflightOp, WormholeQueuedRelease,
  WormholeTransferRow,
} from '../types'

// Security → Wormhole: does every Wormhole token minted on Hydration still have
// custody behind it on its origin chain?
//
// One equation per asset, in raw units at the asset's own decimals:
//   locked = issuance + inflightIn + inflightOut + queued + residual
// A positive residual is spare custody — the state the migration that seeded
// the origin managers left behind, and harmless. A negative residual is supply
// without backing, which is the whole reason this page exists.
//
// `queued` is the third state between moving and settled: a transfer redeemed
// at its origin chain whose inbound rate limiter refused to release it yet. The
// tokens are burned here and still in custody there, so they belong on the same
// side of the equation as a transfer in flight — without them the amount reads
// as unexplained surplus.
//
// The page's one bold element is the beam board: every asset becomes a
// horizontal beam where the minted supply is a solid bar, transfers in flight
// are hatched, and custody is a single high-contrast tick. A beam whose tick
// sits short of the bar's end is an asset that is not fully backed, and that
// reads across a whole column of assets at a glance. Everything below it is a
// quiet table in the Security page's existing language.

// intergalactic-asset-metadata CDN coordinates per Wormhole chain id, for the
// canonical origin-contract icon (the icon resolver only consults EVM origins;
// a chain missing here simply keeps the local Hydration icon fallback).
const CDN_ORIGIN: Record<number, { ecosystem: string; chainId: string }> = {
  2: { ecosystem: 'ethereum', chainId: '1' },
  30: { ecosystem: 'ethereum', chainId: '8453' },
}

// The bridged asset as the explorer's shared asset chip sees it. The row carries
// its own symbol and decimals, so nothing here depends on the asset directory;
// rows that also know their origin contract get the canonical origin icon.
function assetRef(row: { assetId: string; symbol: string; decimals: number; originChainId?: number; originToken?: string | null }): AssetRef {
  const cdn = row.originChainId != null ? CDN_ORIGIN[row.originChainId] : undefined
  const origin = cdn && row.originToken?.startsWith('0x')
    ? { ...cdn, assetId: row.originToken }
    : null
  return { assetId: Number(row.assetId), symbol: row.symbol, name: row.symbol, decimals: row.decimals, parachainId: null, origin }
}

// A signed difference is coloured only when it is the row's verdict — a dust
// negative inside tolerance stays as quiet as its "Backed" badge.
function residualTone(row: Pick<WormholeAssetRow, 'status'>): string {
  return row.status === 'deficit' ? 'var(--red)'
    : row.status === 'attention' ? 'var(--amber)'
    : 'var(--text-low)'
}

// Chain names come from the snapshot's own chain list, so a chain nobody has
// configured still gets named rather than showing as a bare number.
function chainNamer(d: WormholeBridgeDetail): (chainId: number) => string {
  const byId = new Map<number, string>(d.chains.map(c => [c.chainId, c.name]))
  byId.set(d.hydrationChainId, 'Hydration')
  for (const a of d.assets) if (!byId.has(a.originChainId)) byId.set(a.originChainId, a.originChainName)
  return id => byId.get(id) ?? `chain ${id}`
}

/* ---------- the signature element: one backing beam per asset ---------- */

// Everything the beam draws, as fractions of one scale. The scale is whichever
// side is larger, so a beam always spans its full width and the two sides are
// compared against each other rather than against a page-wide maximum: a $2M
// asset and a $200k asset are both read as "is the tick at the end?".
interface Beam {
  minted: number
  flightOut: number
  flightIn: number
  queued: number
  required: number
  locked: number | null
  scale: number
}
function beamOf(row: WormholeAssetRow): Beam | null {
  if (row.issuance == null) return null
  // Circulating supply: tokens burned at the dead address can never come back
  // over the bridge, so they place no claim on custody.
  const minted = F.num(row.issuance, row.decimals) - F.num(row.burned, row.decimals)
  const flightOut = F.num(row.inflightOut, row.decimals)
  const flightIn = F.num(row.inflightIn, row.decimals)
  // A queued release joins the required side for the same reason an in-flight
  // transfer does: custody is holding it, and Hydration has already burned it.
  const queued = F.num(row.queued, row.decimals)
  const required = minted + flightOut + flightIn + queued
  const locked = row.locked == null ? null : F.num(row.locked, row.decimals)
  return { minted, flightOut, flightIn, queued, required, locked, scale: Math.max(required, locked ?? 0) || 1 }
}

// A signed exact amount. F.exact carries the digits; the sign is put back in
// front of them, because a difference reads as a direction before it reads as
// a quantity.
function signedExact(raw: string, decimals: number): string {
  if (raw === '0') return '0'
  return raw.startsWith('-') ? `-${F.exact(raw.slice(1), decimals)}` : `+${F.exact(raw, decimals)}`
}

function BackingBeam({ row }: { row: WormholeAssetRow }) {
  const beam = beamOf(row)
  const meta = WORMHOLE_STATUS[row.status]
  const amt = (raw: string | null) => raw == null ? '—' : F.exact(raw, row.decimals)
  // The exact numbers live in the tooltip; the beam itself carries the shape.
  const title = [
    `${row.symbol} · asset ${row.assetId}`,
    `Minted on Hydration  ${amt(row.issuance)}`,
    row.burned == null || row.burned === '0' ? '' : `Burned at the dead address  ${amt(row.burned)} (needs no custody)`,
    `Locked on ${row.originChainName}  ${amt(row.locked)}`,
    row.inflightCount == null
      ? 'In flight  unchecked'
      : `In flight  ${amt(row.inflightIn)} in · ${amt(row.inflightOut)} out`,
    row.queued == null || row.queued === '0' ? '' : `Queued at rate limit  ${amt(row.queued)}`,
    row.residual == null ? '' : `Difference  ${signedExact(row.residual, row.decimals)}`,
    row.statusDetail,
  ].filter(Boolean).join('\n')

  if (!beam) {
    return (
      <div className="wh-beam-row">
        <div className="wh-beam-head">
          <AssetChip asset={assetRef(row)} />
          <span className={`badge ${meta.badge}`}>{meta.label}</span>
        </div>
        <div className="wh-beam unread" title={row.statusDetail} />
        <div className="wh-beam-foot"><span className="muted">supply unread</span></div>
      </div>
    )
  }
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / beam.scale) * 100))}%`
  const { minted, flightOut, flightIn, queued, required, locked } = beam
  // Only a shortfall the classifier judged real gets drawn: a dust gap inside
  // tolerance wears a "Backed" badge, and a beam that contradicted its own
  // badge with an alarm mark would teach readers to ignore the mark.
  const uncovered = locked != null && locked < required
    && (row.status === 'deficit' || row.status === 'attention')
  const spare = locked != null && locked > required
  return (
    <div className="wh-beam-row">
      <div className="wh-beam-head">
        <AssetChip asset={assetRef(row)} />
        <span className={`badge ${meta.badge}`}>{meta.label}</span>
      </div>
      <div
        className={`wh-beam${locked == null ? ' unread' : ''}`}
        title={title}
        role="img"
        aria-label={`${row.symbol} backing — ${meta.label.toLowerCase()}. ${row.statusDetail}`}
      >
        {/* Minted supply. The asset's brand hue rides on `color`, so the fill can
            be a soft mix of it while the segment's end edge stays solid. */}
        <span className="wh-seg wh-minted" style={{ left: 0, width: pct(minted), color: assetBrandColor(row.symbol) }} />
        {flightOut > 0 && <span className="wh-seg wh-flight out" style={{ left: pct(minted), width: pct(flightOut) }} />}
        {flightIn > 0 && <span className="wh-seg wh-flight in" style={{ left: pct(minted + flightOut), width: pct(flightIn) }} />}
        {/* Held by the origin rate limiter: drawn after the transfers still
            moving, because it is the last thing between a burn here and custody
            being free there. Same 3px floor as an in-flight segment — a held
            release nobody can see is one nobody will go and release. */}
        {queued > 0 && <span className="wh-seg wh-queued" style={{ left: pct(minted + flightOut + flightIn), width: pct(queued) }} />}
        {/* The stretch of supply custody does not cover. A real shortfall is
            usually a sliver of the whole bar, so it is anchored to the bar's
            end (where it always lives: the gap runs from custody to the bar's
            full extent) and floored at a visible width — otherwise the track's
            overflow clipping would swallow it and a deficit would look exactly
            like health. The exact figures live in the tooltip. */}
        {uncovered && <span className={`wh-seg wh-gap${row.status === 'attention' ? ' warn' : ''}`} style={{ right: 0, width: `max(${pct(required - locked)}, 8px)` }} />}
        {/* Custody past what the chain owes: quiet, and deliberately not alarming. */}
        {spare && <span className="wh-seg wh-spare" style={{ left: pct(required), width: pct(locked - required) }} />}
        {/* The custody mark carries the verdict colour: it is the one thing a
            reader scans down the column for. When custody falls short it sits
            on the gap's left edge (right-anchored, so the floor above moves it
            too); otherwise it clamps inside the track so a flush-at-the-end
            tick is never clipped away. */}
        {locked != null && (
          <i
            className="wh-tick"
            style={{
              ...(uncovered
                ? { right: `max(${pct(required - locked)}, 8px)` }
                : { left: `clamp(0px, calc(${pct(locked)} - 1.5px), calc(100% - 3px))` }),
              ...(row.status === 'deficit' ? { background: 'var(--red)' }
                : row.status === 'attention' ? { background: 'var(--amber)' } : undefined),
            }}
          />
        )}
      </div>
      <div className="wh-beam-foot">
        <span className="mono">{F.amount(row.issuance, row.decimals)} minted</span>
        {row.burned != null && row.burned !== '0' &&
          <span className="mono muted">{F.amount(row.burned, row.decimals)} burned at dEaD</span>}
        <span className="mono muted">{row.locked == null ? 'custody unread' : `${F.amount(row.locked, row.decimals)} locked`}</span>
        {/* An exactly covered asset says nothing more than that; only a real gap
            earns a figure. The token amount is the truth; dollars join it only
            when they round to something ("−$0.00" says less than nothing, and an
            unpriced asset still deserves its number). */}
        {row.residual === '0' && <span className="mono wh-delta muted">exactly covered</span>}
        {row.residual != null && row.residual !== '0' && (
          <span className="mono wh-delta" style={{ color: residualTone(row) }}>
            {row.residual.startsWith('-') ? '' : '+'}{F.amount(row.residual, row.decimals)} {row.symbol}
            {row.residualUsd != null && Math.abs(row.residualUsd) >= 0.005 && (
              <span className="muted"> · {row.residualUsd < 0 ? '' : '+'}{F.usd(row.residualUsd)}</span>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

function BeamBoard({ d }: { d: WormholeBridgeDetail }) {
  return (
    <div className="pf-card">
      {d.assets.length
        ? <div className="wh-beams">{d.assets.map(r => <BackingBeam key={r.assetId} row={r} />)}</div>
        : <div className="hdx-note">No Wormhole asset is registered on this chain.</div>}
      <div className="sec-legend">
        <span><i className="wh-key minted" />minted supply</span>
        <span><i className="wh-key flight" />in flight</span>
        <span><i className="wh-key queued" />queued at rate limit</span>
        <span><i className="wh-key tick" />custody</span>
        <span><i className="wh-key gap" />not backed</span>
        <span><i className="wh-key spare" />spare custody</span>
      </div>
      <div className="hdx-note" style={{ marginTop: 12 }}>
        Each beam compares one asset against itself: the bar is what Hydration has minted plus what is
        still moving, and the tick is what its origin chain holds in custody. A tick at the end of the
        bar means every token is backed; a tick short of it is the state this page exists to catch.
      </div>
    </div>
  )
}

/* ---------- rate-limit fuses ---------- */

// Every NTT leg carries the same instrument the Security page's deposit limits
// carry: a bucket of allowance that refills linearly over one window, where a
// transfer larger than what is left is HELD for a whole window rather than
// refused. So the legs are drawn with the Security page's own fuse tiles — a
// reader who has learned one board has already learned this one.
//
// The two boards below are the origin chain's legs, because those are where the
// real limits live: Hydration's own managers are configured so high that they
// can never be the binding constraint, which the note under the grids states
// from the numbers rather than as a claim.

type FuseDirection = 'in' | 'out'
const FUSE_DIR: Record<FuseDirection, { title: string; noun: string }> = {
  in: { title: 'Into Hydration', noun: 'entry' },
  out: { title: 'Out of Hydration — release leg', noun: 'exit' },
}

// Everything about one leg, in the tooltip: the two exact figures, what the
// percentage means, and what actually happens to a transfer that does not fit.
function fuseTitle(row: WormholeAssetRow, fuse: WormholeFuse | null, dir: FuseDirection, now: number): string {
  const head = `${row.symbol} · ${FUSE_DIR[dir].noun} fuse on ${row.originChainName}`
  if (!fuse) {
    return [head, `${row.originChainName} is not configured on this deployment, so its rate limiter could not be read`,
      'A limit nobody could read is not a limit of zero.'].join('\n')
  }
  const span = fmtDuration(fuse.durationSec * 1000)
  const ago = fuse.lastConsumedAt == null ? null : now - parseUtcTimestamp(fuse.lastConsumedAt)
  return [
    head,
    row.pausedOrigin === true ? 'The origin manager is paused — every transfer is refused until it resumes' : '',
    `Limit ${F.exact(fuse.limit, row.decimals)} ${row.symbol} per ${span}`,
    `Available now ${F.exact(fuse.capacity, row.decimals)} ${row.symbol} · ${fmtPct(fuse.utilizationPct)} consumed`,
    `Refills fully over ${span}`,
    `A transfer beyond the available headroom is held for ${span}, not lost`,
    ago == null ? 'Never consumed' : ago > 0 ? `Last consumed ${fmtDuration(ago)} ago` : 'Last consumed just now',
  ].filter(Boolean).join('\n')
}

// One leg's gauge, in the Security page's own tile: the body fills from the
// bottom with the share of the window's allowance already spent, and the plate
// underneath names the asset. An unread origin renders dormant — never at 0%,
// which would read as a limiter nothing has touched.
function FuseTile({ row, fuse, dir, now, plateDir }: {
  row: WormholeAssetRow; fuse: WormholeFuse | null; dir: FuseDirection; now: number
  // On the Security overview the two directions share one grid, so the plate
  // names the leg; the detail page's grids are split by direction and don't.
  plateDir?: boolean
}) {
  // A paused origin manager is this board's "locked": the limiter's headroom is
  // moot while every transfer is refused, so the tile reads full and red, the
  // same way a locked deposit fuse does.
  const locked = fuse != null && row.pausedOrigin === true
  const pct = locked ? 100 : fuse == null ? 0 : Math.min(100, Math.max(0, fuse.utilizationPct))
  // Below ~2% a proportional fill is a sub-pixel sliver, so any real usage keeps
  // a visible floor; the tooltip stays exact either way.
  const fillPct = pct > 0 ? Math.max(pct, 3) : 0
  return (
    <Link
      to={paths.asset(Number(row.assetId))}
      className={`fuse${fuse == null ? ' dormant' : ''}${locked ? ' locked' : ''}`}
      title={fuseTitle(row, fuse, dir, now)}
      ariaLabel={fuse == null
        ? `${row.symbol} ${FUSE_DIR[dir].noun} rate limit, not configured`
        : locked
          ? `${row.symbol} ${FUSE_DIR[dir].noun} rate limit, origin manager paused`
          : `${row.symbol} ${FUSE_DIR[dir].noun} rate limit, ${fmtPct(fuse.utilizationPct)} consumed`}
    >
      <span className="fuse-body" style={{ color: locked ? 'var(--red)' : loadColor(pct) }}>
        <span className="fuse-fill" style={{ height: `${fillPct}%` }} />
        {/* Past ~70% the fill reaches the label zone, so the number gets a
            backdrop instead of being drawn in its own hue. A locked tile shows
            no number — its 100 is a verdict, not a utilization. */}
        {!locked && pct >= 4 && <span className={`fuse-pct${fillPct >= 70 ? ' on-fill' : ''}`}>{Math.round(pct)}</span>}
      </span>
      <span className="fuse-plate">{plateDir ? `${row.symbol} ${dir}` : row.symbol}</span>
    </Link>
  )
}

// The Security overview's Wormhole strip: only the origin fuses currently
// carrying load, in the same instrument language as the deposit-fuse board
// above it. A quiet bridge renders nothing — the overview stays an exception
// report, and the full boards live on the detail page.
export function WormholeFuseStrip({ now }: { now: number }) {
  const { data: d } = useWormholeBridge()
  if (!d) return null
  const legs: { row: WormholeAssetRow; fuse: WormholeFuse; dir: FuseDirection }[] = []
  let readable = 0
  for (const row of d.assets) {
    for (const dir of ['in', 'out'] as const) {
      const fuse = fuseOf(row, dir)
      if (!fuse) continue
      readable += 1
      // A paused origin manager belongs on the strip even at 0% — its fuse is
      // locked, which is the loudest state the board has.
      if (fuse.utilizationPct > 0 || row.pausedOrigin === true) legs.push({ row, fuse, dir })
    }
  }
  if (!legs.length) return null
  const rank = (l: typeof legs[number]) => l.row.pausedOrigin === true ? 101 : l.fuse.utilizationPct
  legs.sort((a, b) => rank(b) - rank(a))
  const span = fmtDuration(legs[0].fuse.durationSec * 1000)
  return (
    <>
      <SecTitle title="Wormhole rate limits"
        subtitle={legs.some(l => l.row.pausedOrigin === true)
          ? `showing the ${legs.length} of ${readable} origin fuses carrying load or locked · ${span} rolling window`
          : `showing the ${legs.length} carrying load of ${readable} origin fuses · ${span} rolling window`} />
      <div className="pf-card">
        <div className="fuse-grid">
          {legs.map(l => (
            <FuseTile key={`${l.row.assetId}:${l.dir}`} row={l.row} fuse={l.fuse} dir={l.dir} now={now} plateDir />
          ))}
        </div>
        <div className="hdx-note" style={{ marginTop: 12 }}>
          Each bridged asset's origin chain caps how fast value can enter or leave, and a transfer
          beyond the headroom is held for {span}, not lost.{' '}
          <Link className="sec-inline-link" to={paths.security('wormhole')}>See the Wormhole detail →</Link>
        </div>
      </div>
    </>
  )
}

function fuseOf(row: WormholeAssetRow, dir: FuseDirection): WormholeFuse | null {
  const limits = row.limits ?? null
  if (!limits) return null
  return (dir === 'in' ? limits.in : limits.out) ?? null
}

// What the grids can say about themselves, read off the rows rather than
// assumed: the window every limiter shares, the hottest leg on the board, and
// how much higher Hydration's own legs are set than the origin's.
interface FuseFacts {
  readable: boolean
  windowSec: number
  hottest: { symbol: string; dir: FuseDirection; pct: number } | null
  // The smallest allowance Hydration's own managers hold, and the least any of
  // them exceeds the origin limit on the SAME asset by.
  localFloor: { row: WormholeAssetRow; fuse: WormholeFuse } | null
  localRatio: number | null
}
function fuseFacts(rows: WormholeAssetRow[]): FuseFacts {
  const origin: { row: WormholeAssetRow; fuse: WormholeFuse; dir: FuseDirection }[] = []
  const local: { row: WormholeAssetRow; fuse: WormholeFuse }[] = []
  for (const row of rows) {
    for (const dir of ['in', 'out'] as const) {
      const fuse = fuseOf(row, dir)
      if (fuse) origin.push({ row, fuse, dir })
    }
    for (const fuse of [row.limits?.localOut, row.limits?.localIn]) if (fuse) local.push({ row, fuse })
  }
  const hottest = origin.filter(f => f.fuse.utilizationPct > 0)
    .sort((a, b) => b.fuse.utilizationPct - a.fuse.utilizationPct)[0]
  const tokens = (row: WormholeAssetRow, fuse: WormholeFuse) => F.num(fuse.limit, row.decimals)
  const localFloor = local.slice().sort((a, b) => tokens(a.row, a.fuse) - tokens(b.row, b.fuse))[0] ?? null
  // Per asset, because the comparison only means anything between two limits on
  // the same token: how many times over the local leg covers the origin's.
  const ratios: number[] = []
  for (const { row, fuse } of local) {
    const peer = origin.filter(o => o.row.assetId === row.assetId).map(o => tokens(o.row, o.fuse)).filter(v => v > 0)
    if (peer.length) ratios.push(tokens(row, fuse) / Math.max(...peer))
  }
  return {
    readable: origin.length > 0,
    windowSec: origin[0]?.fuse.durationSec ?? local[0]?.fuse.durationSec ?? 0,
    hottest: hottest ? { symbol: hottest.row.symbol, dir: hottest.dir, pct: hottest.fuse.utilizationPct } : null,
    localFloor,
    localRatio: ratios.length ? Math.min(...ratios) : null,
  }
}

// How the "hottest fuse" reads in the section subtitle — the one line that says
// whether any limiter on the board is doing anything at all.
function hottestFuseText(facts: Pick<FuseFacts, 'hottest'>): string | null {
  const h = facts.hottest
  return h ? `${h.symbol} ${FUSE_DIR[h.dir].noun} fuse at ${fmtPct(h.pct, 1)}` : null
}

function RateLimits({ d, facts, now }: { d: WormholeBridgeDetail; facts: FuseFacts; now: number }) {
  const span = fmtDuration(facts.windowSec * 1000)
  return (
    <div className="pf-card">
      {(['in', 'out'] as const).map(dir => (
        <div key={dir}>
          <div className="sec-sub">{FUSE_DIR[dir].title}</div>
          <div className="fuse-grid">
            {d.assets.map(row => <FuseTile key={row.assetId} row={row} fuse={fuseOf(row, dir)} dir={dir} now={now} />)}
          </div>
        </div>
      ))}
      {/* No legend: the deposit-fuse board above already teaches the colour
          scale, and these tiles speak it identically (locked = paused manager). */}
      <div className="hdx-note" style={{ marginTop: 12 }}>
        {facts.localFloor && facts.localRatio != null && (
          <>
            Hydration's own managers are set at least {compactAmount(facts.localRatio)}× above the origin limit on the
            same asset — the smallest of them still allows {F.amount(facts.localFloor.fuse.limit, facts.localFloor.row.decimals)}
            {' '}{facts.localFloor.row.symbol} per {span} — so the origin chain's limiter is the only fuse that can bind.{' '}
          </>
        )}
        A transfer larger than the headroom left is held for {span} rather than lost: inbound always, and outbound when the
        sender asked to be queued instead of reverted.
      </div>
    </div>
  )
}

/* ---------- tables ---------- */

function AssetsTable({ d }: { d: WormholeBridgeDetail }) {
  // An unread in-flight figure means one of two things, and the row cannot tell
  // them apart on its own: no scan at all, or a chain nobody configured. Only
  // the first is a property of the deployment worth saying in every row.
  const scanOff = !d.scan.configured || !d.scan.ok
  return (
    <div className="panel">
      <table className="tbl sec-tbl">
        <thead>
          <tr>
            <th>Asset</th><th>Origin</th><th className="r">Locked</th><th className="r">Minted</th>
            <th className="r">In flight</th><th className="r">Difference</th><th className="r">Status</th>
          </tr>
        </thead>
        <tbody>
          {!d.assets.length ? <EmptyRow cols={7}>No Wormhole asset is registered on this chain</EmptyRow> : d.assets.map(r => {
            const meta = WORMHOLE_STATUS[r.status]
            const custody = wormholeExplorerLink(r.originChainId, r.peer)
            const paused = r.pausedLocal === true || r.pausedOrigin === true
            // One figure for everything that has not landed: transfers still
            // moving between the chains, plus transfers the origin rate limiter
            // is holding back. They belong together because they explain the
            // same thing — why custody and minted supply legitimately differ —
            // and the tooltip splits them apart again.
            const moving = r.inflightCount == null || r.inflightIn == null || r.inflightOut == null
              ? null
              : BigInt(r.inflightIn) + BigInt(r.inflightOut)
            const held = r.queued == null ? null : BigInt(r.queued)
            const pending = moving == null && held == null ? null : (moving ?? 0n) + (held ?? 0n)
            const pendingCount = (r.inflightCount ?? 0) + (r.queuedCount ?? 0)
            const pendingTitle = held != null && held > 0n
              ? [
                moving == null ? 'In flight unchecked' : `${F.exact(moving.toString(), r.decimals)} ${r.symbol} in flight`,
                `${F.exact(held.toString(), r.decimals)} ${r.symbol} queued at the origin rate limit`,
              ].join(' · ')
              : r.inflightCount == null && scanOff ? 'In-flight transfers are not checked on this deployment' : undefined
            return (
              <tr key={r.assetId} className={r.status === 'unconfigured' ? 'dim' : undefined}>
                <td data-label="Asset">
                  <span className="wh-asset">
                    <AssetChip asset={assetRef(r)} />
                    <Link className="hash mono wh-mgr" to={paths.account(r.manager)} title={`Hydration NTT manager ${r.manager}`}>
                      {F.shortAddr(r.manager)}
                    </Link>
                  </span>
                </td>
                <td data-label="Origin">
                  <span className="wh-origin">
                    <span className="wh-chain">{r.originChainName}</span>
                    {custody && (
                      <a className="wh-out mono" href={custody.href} target="_blank" rel="noreferrer noopener"
                         title={`Custody ${r.peer} on ${custody.kind}`}>custody ↗</a>
                    )}
                    {paused && <span className="badge pending" title={r.pausedOrigin === true ? 'The origin manager is paused' : 'The Hydration manager is paused'}>Paused</span>}
                  </span>
                </td>
                <td data-label="Locked" className={`r${r.locked == null ? ' cell-empty' : ''}`}>
                  {r.locked == null ? <Dash /> : <>
                    <span className="mono" title={`${F.exact(r.locked, r.decimals)} ${r.symbol}`}>{F.amount(r.locked, r.decimals)}</span>
                    {r.lockedUsd != null && <span className="muted mono sec-usd"> · {F.usd(r.lockedUsd)}</span>}
                  </>}
                </td>
                <td data-label="Minted" className={`r${r.issuance == null ? ' cell-empty' : ''}`}>
                  {r.issuance == null ? <Dash /> : <>
                    <span className="mono" title={r.burned != null && r.burned !== '0'
                      ? `${F.exact(r.issuance, r.decimals)} ${r.symbol} minted · ${F.exact(r.burned, r.decimals)} burned at the dead address (needs no custody)`
                      : `${F.exact(r.issuance, r.decimals)} ${r.symbol}`}>{F.amount(r.issuance, r.decimals)}</span>
                    {r.issuanceUsd != null && <span className="muted mono sec-usd"> · {F.usd(r.issuanceUsd)}</span>}
                  </>}
                </td>
                <td data-label="In flight" className={`r mono muted${pending == null || pending === 0n ? ' cell-empty' : ''}`}
                    title={pendingTitle}>
                  {pending == null || pending === 0n ? <Dash /> : <>
                    {F.amount(pending.toString(), r.decimals)}
                    {pendingCount ? <span className="wh-count"> · {F.int(pendingCount)}</span> : null}
                  </>}
                </td>
                {/* The signed gap between custody and what the chain owes. It is
                    coloured only when it is the row's verdict, and dollars join
                    the token figure only when they round to something. */}
                <td data-label="Difference" className={`r mono${r.residual == null ? ' cell-empty' : ''}`}
                    style={{ color: residualTone(r) }}
                    title={r.residual == null ? undefined : `${signedExact(r.residual, r.decimals)} ${r.symbol}`}>
                  {r.residual == null ? <Dash /> : r.residual === '0' ? <span className="muted">0</span> : <>
                    {r.residual.startsWith('-') ? '' : '+'}{F.amount(r.residual, r.decimals)}
                    {r.residualUsd != null && Math.abs(r.residualUsd) >= 0.005 &&
                      <span className="sec-usd"> · {r.residualUsd < 0 ? '' : '+'}{F.usd(r.residualUsd)}</span>}
                  </>}
                </td>
                <td data-label="Status" className="r">
                  <span className={`badge ${meta.badge}`} title={r.statusDetail}>{meta.label}</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// When a queued release comes free, said as the release itself would say it:
// past the timer it is already anybody's to complete, so the row states that
// and offers the call by name. Before the timer it is simply a wait.
function ReleaseTiming({ q, now }: { q: WormholeQueuedRelease; now: number }) {
  if (q.releasable) {
    return (
      <span className="wh-release ready" title="Releasable now — anyone can call completeInboundQueuedTransfer to let it out">
        releasable {q.releasableAt == null ? 'now' : <Ago ts={q.releasableAt} now={now} />}
      </span>
    )
  }
  if (q.releasableAt == null) return <Dash />
  const left = parseUtcTimestamp(q.releasableAt) - now
  return (
    <span className="wh-release" title={`Held by the origin rate limiter until ${F.datetime(q.releasableAt)}`}>
      releases in {fmtDuration(left)}
    </span>
  )
}

// Everything that has not landed, in one table: transfers still crossing, and
// transfers the origin rate limiter is holding in its release queue. The two
// share the same columns — route, asset, amount — and differ only in the last
// two: a transfer in flight has a send time and a VAA sequence, a queued
// release has a release time and a message digest.
function InflightPanel({ d, queued, now, name }: {
  d: WormholeBridgeDetail; queued: WormholeQueuedRelease[]; now: number; name: (id: number) => string
}) {
  const decimals = new Map(d.assets.map(a => [a.assetId, a.decimals]))
  const amount = (op: WormholeInflightOp) => {
    const dec = op.assetId == null ? undefined : decimals.get(op.assetId)
    if (op.amount == null || dec == null) return <Dash />
    return <span className="mono" title={`${F.exact(op.amount, dec)} ${op.symbol ?? ''}`.trim()}>{F.amount(op.amount, dec)}</span>
  }
  return (
    <div className="panel">
      <table className="tbl sec-tbl">
        <thead><tr><th>Route</th><th>Asset</th><th className="r">Amount</th><th className="r">When</th><th className="r">Reference</th></tr></thead>
        <tbody>
          {!d.inflight.length && !queued.length
            ? <EmptyRow cols={5}>Nothing in flight — every transfer is settled.</EmptyRow>
            : <>
              {d.inflight.map(op => (
                <tr key={op.id}>
                  <td data-label="Route" className="wh-route">
                    <a href={wormholescanLink(op.id)} target="_blank" rel="noreferrer noopener" className="wh-hop"
                       title="Open this transfer on Wormholescan">
                      {name(op.fromChainId)} <span className="wh-arrow">→</span> {name(op.toChainId)}
                    </a>
                  </td>
                  <td data-label="Asset">{op.symbol && op.assetId != null
                    ? <AssetChip asset={assetRef({ assetId: op.assetId, symbol: op.symbol, decimals: decimals.get(op.assetId) ?? 0 })} />
                    : <span className="muted">unmatched</span>}</td>
                  <td data-label="Amount" className="r">
                    {amount(op)}
                    {op.amountUsd != null && <span className="muted mono sec-usd"> · {F.usd(op.amountUsd)}</span>}
                  </td>
                  <td data-label="Sent" className={`r${op.sentAt == null ? ' cell-empty' : ''}`}>
                    {op.sentAt == null ? <Dash /> : <Ago ts={op.sentAt} now={now} />}
                  </td>
                  <td data-label="Sequence" className="r mono muted">{op.sequence}</td>
                </tr>
              ))}
              {queued.map(q => {
                const dec = decimals.get(q.assetId) ?? 0
                return (
                  <tr key={q.digest} className="wh-queued-row">
                    <td data-label="Route" className="wh-route">
                      <span className="wh-hop" title="Burned on Hydration, redeemed on the origin chain, and held by its inbound rate limiter">
                        {name(d.hydrationChainId)} <span className="wh-arrow">→</span> {name(q.chainId)}
                      </span>
                    </td>
                    <td data-label="Asset"><AssetChip asset={assetRef({ assetId: q.assetId, symbol: q.symbol, decimals: dec })} /></td>
                    <td data-label="Amount" className="r">
                      <span className="mono" title={`${F.exact(q.amount, dec)} ${q.symbol}`}>{F.amount(q.amount, dec)}</span>
                      {q.amountUsd != null && <span className="muted mono sec-usd"> · {F.usd(q.amountUsd)}</span>}
                    </td>
                    <td data-label="Release" className="r"><ReleaseTiming q={q} now={now} /></td>
                    {/* A digest names a message, not a transaction, so it links
                        nowhere: it is shown short and copyable instead. */}
                    <td data-label="Digest" className="r">
                      <span className="wh-digest">
                        <span className="mono muted" title={q.digest}>{F.shortHash(q.digest)}</span>
                        <Copy text={q.digest} />
                      </span>
                    </td>
                  </tr>
                )
              })}
            </>}
        </tbody>
      </table>
    </div>
  )
}

function TransfersTable({ d, now, name }: { d: WormholeBridgeDetail; now: number; name: (id: number) => string }) {
  const decimals = new Map(d.assets.map(a => [a.assetId, a.decimals]))
  const dec = (row: WormholeTransferRow) => decimals.get(row.assetId) ?? 0
  return (
    <div className="panel">
      <table className="tbl sec-tbl">
        <thead>
          <tr><th>When</th><th>Direction</th><th>Asset</th><th className="r">Amount</th><th>Account</th><th>Counterparty</th><th className="r">Sequence</th></tr>
        </thead>
        <tbody>
          {!d.recent.length ? <EmptyRow cols={7}>No Wormhole transfer on record</EmptyRow> : d.recent.map(r => (
            <tr key={`${r.blockHeight}-${r.eventIndex}`}>
              <td data-label="When">
                <MomentLink at={{ blockHeight: r.blockHeight, extrinsicIndex: r.extrinsicIndex, timestamp: r.timestamp }} now={now} />
              </td>
              <td data-label="Direction" className="mono" style={{ color: r.direction === 'in' ? 'var(--green)' : 'var(--sky)' }}>
                {r.direction === 'in' ? 'minted in' : 'burned out'}
              </td>
              <td data-label="Asset"><AssetChip asset={assetRef({ assetId: r.assetId, symbol: r.symbol, decimals: dec(r) })} /></td>
              <td data-label="Amount" className="r">
                <span className="mono" title={`${F.exact(r.amount, dec(r))} ${r.symbol}`}>{F.amount(r.amount, dec(r))}</span>
                {r.amountUsd != null && <span className="muted mono sec-usd"> · {F.usd(r.amountUsd)}</span>}
              </td>
              <td data-label="Account" className={r.accountRef ? undefined : 'cell-empty'}>
                {r.accountRef ? <AddrPill account={r.accountRef} /> : <Dash />}
              </td>
              <td data-label="Counterparty" className="mono muted">{name(r.counterpartyChainId)}</td>
              <td data-label="Sequence" className={`r mono muted${r.sequence == null ? ' cell-empty' : ''}`}>{r.sequence ?? <Dash />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ---------- headline strip, footnote, skeleton ---------- */

function Card({ label, value, sub, tone }: { label: string; value: ReactNode; sub: ReactNode; tone?: string }) {
  return (
    <div className="hdx-card">
      <div className="hk">{label}</div>
      <div className="hv" style={tone ? { color: tone } : undefined}>{value}</div>
      <div className="hs">{sub}</div>
    </div>
  )
}

function Headline({ d }: { d: WormholeBridgeDetail }) {
  const t = d.totals
  const deficit = t.deficitUsd
  // A real shortfall is red; a few units short of a rounding boundary is amber.
  const graded = d.assets.some(r => r.status === 'deficit')
  // A graded shortfall the USD total does not show is one in an asset with no
  // live price: the dollar figure is unknown, but the verdict is anything but
  // green — the AsOf footnote below names the unpriced asset.
  const unpricedShortfall = graded && !(deficit != null && deficit > 0)
  const inflightUnchecked = !d.scan.configured || !d.scan.ok
  const chainsRead = d.chains.filter(c => c.configured && c.ok).length
  return (
    <div className="hdx-cards">
      <Card label="Locked on origin chains" value={t.lockedUsd == null ? <Dash /> : F.usd(t.lockedUsd)}
        sub={`custody across ${F.int(chainsRead)} of ${F.int(d.chains.length)} chains`} />
      <Card label="Minted on Hydration" value={t.issuanceUsd == null ? <Dash /> : F.usd(t.issuanceUsd)}
        sub={`${F.int(d.assets.length)} bridged assets`} />
      <Card label="In flight"
        value={inflightUnchecked ? <Dash /> : F.int(d.inflight.length)}
        sub={inflightUnchecked
          ? 'transfers in transit are not checked'
          : t.inflightUsd != null && d.inflight.length ? `${F.usd(t.inflightUsd)} between chains` : 'every transfer is settled'} />
      {/* The number this page exists to keep at zero. */}
      <Card label="Backing deficit"
        value={unpricedShortfall || deficit == null ? <Dash /> : deficit > 0 ? F.usd(deficit) : '$0'}
        tone={unpricedShortfall ? 'var(--red)' : deficit == null ? undefined : deficit > 0 ? (graded ? 'var(--red)' : 'var(--amber)') : 'var(--green)'}
        sub={unpricedShortfall ? 'shortfall in an asset with no live price'
          : deficit == null ? 'custody unread' : deficit > 0 ? 'supply beyond its custody backing' : 'every token is backed'} />
    </div>
  )
}

function AsOf({ d, now }: { d: WormholeBridgeDetail; now: number }) {
  const read = d.chains.filter(c => c.configured && c.ok && c.asOf)
  const missing = d.chains.filter(c => !c.configured)
  const failing = d.chains.filter(c => c.configured && !c.ok)
  // A bridged asset can lose its price feed (no live pool route) while its
  // balances stay real. Those drop out of the USD totals, and the omission
  // must be stated rather than hidden.
  const unpriced = d.assets.filter(a => a.issuance != null && a.issuanceUsd == null).map(a => a.symbol)
  return (
    <div className="hdx-note sec-asof sec-wh-asof">
      {read.length > 0 && <>
        Custody read from {read.map((c, i) => (
          <span key={c.chainId}>{i > 0 && (i === read.length - 1 ? ' and ' : ', ')}{c.name} <Ago ts={c.asOf as string} now={now} /></span>
        ))}.{' '}
      </>}
      {missing.length > 0 && <>{missing.map(c => c.name).join(', ')} {missing.length === 1 ? 'is' : 'are'} not configured, so those assets are unverified.{' '}</>}
      {failing.length > 0 && <>{failing.map(c => c.name).join(', ')} did not answer the last poll, so its custody is the previous read.{' '}</>}
      {d.asOf && <>Issuance read from chain state <Ago ts={d.asOf} now={now} />.{' '}</>}
      {d.scan.configured
        ? <>Wormholescan {d.scan.ok && d.scan.asOf ? <>read <Ago ts={d.scan.asOf} now={now} /></> : 'did not answer'}.{' '}</>
        : <>Wormholescan is not configured.{' '}</>}
      {d.indexedThrough && <>History indexed through block {F.int(d.indexedThrough.block)}.{' '}</>}
      {unpriced.length > 0 && <>
        {unpriced.join(', ')} {unpriced.length === 1 ? 'has' : 'have'} no current price, so the dollar totals leave {unpriced.length === 1 ? 'it' : 'them'} out.{' '}
      </>}
      Supply not minted through Wormhole is shown per asset as legacy remainder.
    </div>
  )
}

function WormholeSkeleton() {
  return (
    <>
      <ChartSkeleton h={92} />
      <SecTitle title="Backing, per asset" subtitle="custody against minted supply" />
      <ChartSkeleton h={260} />
      <SecTitle title="Assets" />
      <div className="panel"><table className="tbl sec-tbl"><tbody><TableSkeleton cols={7} rows={6} /></tbody></table></div>
      <SecTitle title="Rate limits" />
      <ChartSkeleton h={190} />
      <SecTitle title="In flight" />
      <div className="panel"><table className="tbl sec-tbl"><tbody><TableSkeleton cols={5} rows={2} /></tbody></table></div>
    </>
  )
}

export function WormholeSection({ now }: { now: number }) {
  const { data: d, isError } = useWormholeBridge()
  if (isError) {
    return (
      <>
        <SecTitle title="Wormhole backing" />
        <div className="pf-card"><div className="hdx-note">Failed to load the Wormhole backing snapshot.</div></div>
      </>
    )
  }
  if (!d) return <WormholeSkeleton />

  const name = chainNamer(d)
  const anyConfigured = d.chains.some(c => c.configured)
  const inflightChecked = d.scan.configured && d.scan.ok
  // Queued releases are read from the origin managers, not from Wormholescan,
  // so they are known even on a deployment that checks no transfers in flight —
  // and the panel has to appear for them.
  const queued = d.queued ?? []
  // The two are counted apart rather than summed: the headline card above says
  // how many transfers are in flight, and a combined figure here would silently
  // contradict it.
  const fuses = fuseFacts(d.assets)
  const notSettled = inflightChecked
    ? queued.length
      ? `${F.int(d.inflight.length)} in flight · ${F.int(queued.length)} queued at a rate limit`
      : `${F.int(d.inflight.length)} transfers not yet settled`
    : queued.length ? `${F.int(queued.length)} queued at a rate limit` : undefined

  return (
    <>
      {!anyConfigured && (
        <div className="pf-card sec-warn">
          Origin-chain custody is not configured on this deployment, so backing cannot be verified.
        </div>
      )}

      {/* Subscribing lives in the page head — one Security rule up there covers
          the bridge's states as well as the chain's own safety actions. */}
      <SecTitle title="Backing" subtitle={d.asOf ? undefined : 'no snapshot yet'} />
      <Headline d={d} />

      <SecTitle title="Backing, per asset" subtitle="custody against minted supply" />
      <BeamBoard d={d} />

      <SecTitle title="Assets" subtitle={`${F.int(d.assets.length)} bridged through Wormhole`} />
      <AssetsTable d={d} />

      {/* The window comes from the limiters themselves, so the subtitle never
          promises a period the chain has stopped using. */}
      <SecTitle title="Rate limits"
        subtitle={[
          'origin-chain fuses',
          fuses.windowSec > 0 ? `${fmtDuration(fuses.windowSec * 1000)} rolling window` : null,
          hottestFuseText(fuses),
        ].filter(Boolean).join(' · ')} />
      {fuses.readable
        ? <RateLimits d={d} facts={fuses} now={now} />
        : <div className="pf-card"><div className="hdx-note">
          No origin chain's rate limiter could be read, so how much of each transfer allowance is left is unknown.
        </div></div>}

      <SecTitle title="In flight" subtitle={notSettled} />
      {!inflightChecked && (
        <div className="pf-card">
          <div className="hdx-note">
            In-flight transfers are not checked on this deployment, so a transfer between chains counts as
            spare custody until it lands. That direction can only overstate backing, never hide a shortfall.
          </div>
        </div>
      )}
      {(inflightChecked || queued.length > 0) && <InflightPanel d={d} queued={queued} now={now} name={name} />}

      <SecTitle title="Recent transfers" subtitle="both directions" />
      <TransfersTable d={d} now={now} name={name} />

      <AsOf d={d} now={now} />
    </>
  )
}
