import type { ReactNode } from 'react'
import { Link, paths } from '../router'
import { AddrPill, Usd, Amt, Ago, AssetChip, ChartSkeleton, Copy, Dash, EmptyRow, F, LoadError, MomentLink, TableSkeleton, assetBrandColor } from './ui'
import { DashboardSectionTitle as SecTitle } from './DashboardPrimitives'
import { useWormholeBridge } from '../hooks/useExplorerData'
import {
  HYDRATION_UNCAPPED_TOKENS, WORMHOLE_PEER_STATUS, WORMHOLE_STATUS, changeOriginLabel, chainShort, fmtDuration, fmtPct,
  joinChains, loadColor, lockboxChains, peerFuseLeg, wormholeExplorerLink, wormholescanLink, type PeerFuseLeg,
} from '../utils/security'
import { parseUtcTimestamp } from '../utils/time'
import { ChainBadge, HydrationBadge } from './ActivityTable'
import type {
  AssetRef, WormholeAssetRow, WormholeBridgeDetail, WormholeFuse, WormholeInflightOp, WormholePeerRow, WormholeQueuedRelease,
  WormholeTransferRow,
} from '../types'

// Security → Wormhole: does every Wormhole token still have custody behind it?
//
// An NTT asset is one token over several chains. Each chain's manager either
// LOCKS the real token (a lockbox) or MINTS a representation (a spoke), and
// Hydration is one of those chains — WETH is minted here against lockboxes on
// Ethereum and Robinhood, HDX is locked here against a Robinhood
// spoke. One equation per asset, in raw units at the asset's own decimals:
//   Σ lockbox custody (`locked`) = Σ spoke supply (`issuance`) + inflightIn
//                                  + inflightOut + queued + residual
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
  const peers = row.peers ?? []
  // Every chain of the asset, on the side of the equation it sits: Hydration's
  // own leg first, then each peer.
  const sideLines = peers.length
    ? [
      row.hydrationRole === 'lockbox'
        ? `Locked on Hydration  ${amt(row.hydrationLocked ?? null)}`
        : `Minted on Hydration  ${amt(row.hydrationRole === 'spoke' ? (BigInt(row.issuance ?? '0') - peers.filter(p => p.role === 'spoke').reduce((t, p) => t + BigInt(p.balance ?? '0'), 0n)).toString() : row.issuance)}`,
      ...peers.map(p => `${p.role === 'spoke' ? 'Minted' : 'Locked'} on ${p.chainName}  ${p.configured ? amt(p.balance) : 'no endpoint'}`),
    ]
    : [`Minted on Hydration  ${amt(row.issuance)}`, `Locked on ${row.originChainName}  ${amt(row.locked)}`]
  // The exact numbers live in the tooltip; the beam itself carries the shape.
  const title = [
    `${row.symbol} · asset ${row.assetId}`,
    ...sideLines,
    row.burned == null || row.burned === '0' ? '' : `Burned at the dead address  ${amt(row.burned)} (needs no custody)`,
    peers.length > 1 || row.hydrationRole === 'lockbox' ? `Locked in total  ${amt(row.locked)} · minted in total  ${amt(row.issuance)}` : '',
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
        <span className="mono"><Amt raw={row.issuance} dec={row.decimals} /> minted</span>
        {row.burned != null && row.burned !== '0' &&
          <span className="mono muted"><Amt raw={row.burned} dec={row.decimals} /> burned at dEaD</span>}
        <span className="mono muted">{row.locked == null ? 'custody unread' : <><Amt raw={row.locked} dec={row.decimals} /> locked</>}</span>
        {/* An exactly covered asset says nothing more than that; only a real gap
            earns a figure. The token amount is the truth; dollars join it only
            when they round to something ("−$0.00" says less than nothing, and an
            unpriced asset still deserves its number). */}
        {row.residual === '0' && <span className="mono wh-delta muted">exactly covered</span>}
        {row.residual != null && row.residual !== '0' && (
          <span className="mono wh-delta" style={{ color: residualTone(row) }}>
            {row.residual.startsWith('-') ? '' : '+'}<Amt raw={row.residual} dec={row.decimals} /> {row.symbol}
            {row.residualUsd != null && Math.abs(row.residualUsd) >= 0.005 && (
              <span className="muted"> · {row.residualUsd < 0 ? '' : '+'}<Usd v={row.residualUsd} /></span>
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
        Each beam compares one asset against itself: the bar is the supply minted on every chain plus what
        is still moving, and the tick is what every lockbox holds in custody together. A tick at the end
        of the bar means every token is backed; a tick short of it is the state this page exists to catch.
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
// One tile per asset, per PEER CHAIN, per direction: WETH crosses to Ethereum
// and to Robinhood through different limiters (10,000 vs 69 a day), so a
// single per-asset tile could only ever state one of them. Each direction has
// to clear two limiters — the peer manager's and Hydration's own for that
// chain — and the tile draws whichever binds; the tooltip states both.

type FuseDirection = 'in' | 'out'
const FUSE_DIR: Record<FuseDirection, { title: string; noun: string }> = {
  in: { title: 'Into Hydration', noun: 'entry' },
  out: { title: 'Out of Hydration — release leg', noun: 'exit' },
}

// One tile's subject: an asset, one of its peer chains, one direction.
interface FuseLegView {
  row: WormholeAssetRow
  chainId: number
  chainName: string
  /** Whether the plate must name the chain (the asset has more than one peer). */
  multi: boolean
  paused: boolean
  leg: PeerFuseLeg
}

// Every tile of the board, from the per-peer limits. An API from before the
// multi-peer model carries only the primary origin's block, which is read as
// that one chain's legs.
function fuseLegs(rows: readonly WormholeAssetRow[], dir: FuseDirection): FuseLegView[] {
  const out: FuseLegView[] = []
  for (const row of rows) {
    const peers = row.peers ?? []
    if (!peers.length) {
      const l = row.limits
      const peerSide = (dir === 'in' ? l?.in : l?.out) ?? null
      out.push({
        row, chainId: row.originChainId, chainName: row.originChainName, multi: false, paused: row.pausedOrigin === true,
        leg: { dir, peerSide, hydrationSide: (dir === 'in' ? l?.localIn : l?.localOut) ?? null, binding: peerSide, bindingSide: peerSide ? 'peer' : null },
      })
      continue
    }
    for (const peer of peers) {
      out.push({
        row, chainId: peer.chainId, chainName: peer.chainName, multi: peers.length > 1, paused: peer.paused === true,
        leg: peerFuseLeg(peer, dir),
      })
    }
  }
  return out
}

const legKey = (l: FuseLegView) => `${l.row.assetId}:${l.chainId}:${l.leg.dir}`

// Everything about one leg, in the tooltip: both limiters' exact figures, what
// the percentage means, and what actually happens to a transfer that does not fit.
function fuseTitle(view: FuseLegView, now: number): string {
  const { row, leg, chainName } = view
  const head = `${row.symbol} · ${FUSE_DIR[leg.dir].noun} fuse ${leg.dir === 'in' ? `from ${chainName}` : `to ${chainName}`}`
  if (!leg.binding) {
    const unread = leg.peerSide != null ? 'Hydration\'s own rate limiter for this leg' : `${chainName}'s rate limiter`
    return [head, `${unread} could not be read on this deployment`,
      'A limit nobody could read is not a limit of zero.'].join('\n')
  }
  const describe = (fuse: WormholeFuse | null, who: string) => {
    if (!fuse) return `${who}: unread`
    const span = fmtDuration(fuse.durationSec * 1000)
    const uncapped = F.num(fuse.limit, row.decimals) >= HYDRATION_UNCAPPED_TOKENS
    return uncapped
      ? `${who}: uncapped`
      : `${who}: ${F.exact(fuse.capacity, row.decimals)} of ${F.exact(fuse.limit, row.decimals)} ${row.symbol} per ${span} left · ${fmtPct(fuse.utilizationPct)} consumed`
  }
  const fuse = leg.binding
  const span = fmtDuration(fuse.durationSec * 1000)
  const ago = fuse.lastConsumedAt == null ? null : now - parseUtcTimestamp(fuse.lastConsumedAt)
  const peerWho = `${chainName} manager (${leg.dir === 'in' ? 'outbound' : 'inbound'})`
  const hydrationWho = `Hydration manager (${leg.dir === 'in' ? `inbound from ${chainName}` : 'outbound, every chain'})`
  const other = leg.bindingSide === 'hydration' ? describe(leg.peerSide, peerWho) : describe(leg.hydrationSide, hydrationWho)
  return [
    head,
    view.paused ? `The ${chainName} manager is paused — every transfer is refused until it resumes` : '',
    `Limit ${F.exact(fuse.limit, row.decimals)} ${row.symbol} per ${span}`,
    `Available now ${F.exact(fuse.capacity, row.decimals)} ${row.symbol} · ${fmtPct(fuse.utilizationPct)} consumed`,
    `Binding: the ${leg.bindingSide === 'hydration' ? hydrationWho : peerWho} leg`,
    `Other side — ${other}`,
    `Refills fully over ${span}`,
    `A transfer beyond the available headroom is held for ${span}, not lost`,
    ago == null ? 'Never consumed' : ago > 0 ? `Last consumed ${fmtDuration(ago)} ago` : 'Last consumed just now',
  ].filter(Boolean).join('\n')
}

// One leg's gauge, in the Security page's own tile: the body fills from the
// bottom with the share of the window's allowance already spent, and the plate
// underneath names the asset (and the chain, where the asset has several). An
// unread leg renders dormant — never at 0%, which would read as a limiter
// nothing has touched.
function FuseTile({ view, now, plateDir }: {
  view: FuseLegView; now: number
  // On the Security overview the two directions share one grid, so the plate
  // names the leg; the detail page's grids are split by direction and don't.
  plateDir?: boolean
}) {
  const { row, leg } = view
  const fuse = leg.binding
  // A paused peer manager is this board's "locked": the limiter's headroom is
  // moot while every transfer is refused, so the tile reads full and red, the
  // same way a locked deposit fuse does.
  const locked = fuse != null && view.paused
  const pct = locked ? 100 : fuse == null ? 0 : Math.min(100, Math.max(0, fuse.utilizationPct))
  // Below ~2% a proportional fill is a sub-pixel sliver, so any real usage keeps
  // a visible floor; the tooltip stays exact either way.
  const fillPct = pct > 0 ? Math.max(pct, 3) : 0
  const chain = view.multi ? chainShort(view.chainId, view.chainName) : null
  const plate = [row.symbol, chain, plateDir ? leg.dir : null].filter(Boolean).join(' ')
  const subject = `${row.symbol} ${FUSE_DIR[leg.dir].noun} rate limit ${leg.dir === 'in' ? 'from' : 'to'} ${view.chainName}`
  return (
    <Link
      to={paths.asset(Number(row.assetId))}
      className={`fuse${fuse == null ? ' dormant' : ''}${locked ? ' locked' : ''}`}
      title={fuseTitle(view, now)}
      ariaLabel={fuse == null
        ? `${subject}, not configured`
        : locked
          ? `${subject}, ${view.chainName} manager paused`
          : `${subject}, ${fmtPct(fuse.utilizationPct)} consumed`}
    >
      <span className="fuse-body" style={{ color: locked ? 'var(--red)' : loadColor(pct) }}>
        <span className="fuse-fill" style={{ height: `${fillPct}%` }} />
        {/* Past ~70% the fill reaches the label zone, so the number gets a
            backdrop instead of being drawn in its own hue. A locked tile shows
            no number — its 100 is a verdict, not a utilization. */}
        {!locked && pct >= 4 && <span className={`fuse-pct${fillPct >= 70 ? ' on-fill' : ''}`}>{Math.round(pct)}</span>}
      </span>
      <span className="fuse-plate">{plate}</span>
    </Link>
  )
}

// The Security overview's Wormhole strip: only the legs currently carrying
// load, in the same instrument language as the deposit-fuse board above it. A
// quiet bridge renders nothing — the overview stays an exception report, and
// the full boards live on the detail page.
export function WormholeFuseStrip({ now }: { now: number }) {
  const { data: d } = useWormholeBridge()
  if (!d) return null
  const all = [...fuseLegs(d.assets, 'in'), ...fuseLegs(d.assets, 'out')].filter(l => l.leg.binding != null)
  // A paused manager belongs on the strip even at 0% — its fuse is locked,
  // which is the loudest state the board has.
  const legs = all.filter(l => (l.leg.binding?.utilizationPct ?? 0) > 0 || l.paused)
  if (!legs.length) return null
  const rank = (l: FuseLegView) => l.paused ? 101 : l.leg.binding?.utilizationPct ?? 0
  legs.sort((a, b) => rank(b) - rank(a))
  const span = fmtDuration((legs[0].leg.binding?.durationSec ?? 0) * 1000)
  return (
    <>
      <SecTitle title="Wormhole rate limits"
        subtitle={legs.some(l => l.paused)
          ? `showing the ${legs.length} of ${all.length} fuses carrying load or locked · ${span} rolling window`
          : `showing the ${legs.length} carrying load of ${all.length} fuses · ${span} rolling window`} />
      <div className="pf-card">
        <div className="fuse-grid">
          {legs.map(l => <FuseTile key={legKey(l)} view={l} now={now} plateDir />)}
        </div>
        <div className="hdx-note" style={{ marginTop: 12 }}>
          Every chain a bridged asset reaches caps how fast value can enter or leave Hydration through it, and a
          transfer beyond the headroom is held for {span}, not lost.{' '}
          <Link className="sec-inline-link" to={paths.security('wormhole')}>See the Wormhole detail →</Link>
        </div>
      </div>
    </>
  )
}

// What the grids can say about themselves, read off the rows rather than
// assumed: the window every limiter shares, the hottest leg on the board, and
// which legs Hydration's own manager caps (it used to cap none).
interface FuseFacts {
  readable: boolean
  windowSec: number
  hottest: { view: FuseLegView; pct: number } | null
  // Legs where Hydration's own limit is finite — one list entry per asset and chain.
  hydrationCaps: { row: WormholeAssetRow; chainName: string; fuse: WormholeFuse; dir: FuseDirection }[]
}
function fuseFacts(rows: WormholeAssetRow[]): FuseFacts {
  const views = [...fuseLegs(rows, 'in'), ...fuseLegs(rows, 'out')]
  const read = views.filter(v => v.leg.binding != null)
  const hottest = read.filter(v => (v.leg.binding?.utilizationPct ?? 0) > 0)
    .sort((a, b) => (b.leg.binding!.utilizationPct) - (a.leg.binding!.utilizationPct))[0]
  const caps: FuseFacts['hydrationCaps'] = []
  const seen = new Set<string>()
  for (const v of views) {
    const fuse = v.leg.hydrationSide
    if (!fuse || F.num(fuse.limit, v.row.decimals) >= HYDRATION_UNCAPPED_TOKENS) continue
    // Hydration's outbound leg is one limit for every chain: said once.
    const key = v.leg.dir === 'out' ? `${v.row.assetId}:out` : `${v.row.assetId}:${v.chainId}:in`
    if (seen.has(key)) continue
    seen.add(key)
    caps.push({ row: v.row, chainName: v.chainName, fuse, dir: v.leg.dir })
  }
  return {
    readable: read.length > 0,
    windowSec: read[0]?.leg.binding?.durationSec ?? 0,
    hottest: hottest ? { view: hottest, pct: hottest.leg.binding!.utilizationPct } : null,
    hydrationCaps: caps,
  }
}

// How the "hottest fuse" reads in the section subtitle — the one line that says
// whether any limiter on the board is doing anything at all.
function hottestFuseText(facts: Pick<FuseFacts, 'hottest'>): string | null {
  const h = facts.hottest
  if (!h) return null
  const chain = h.view.multi ? ` ${h.view.leg.dir === 'in' ? 'from' : 'to'} ${h.view.chainName}` : ''
  return `${h.view.row.symbol}${chain} ${FUSE_DIR[h.view.leg.dir].noun} fuse at ${fmtPct(h.pct, 1)}`
}

function RateLimits({ d, facts, now }: { d: WormholeBridgeDetail; facts: FuseFacts; now: number }) {
  const span = fmtDuration(facts.windowSec * 1000)
  return (
    <div className="pf-card">
      {(['in', 'out'] as const).map(dir => (
        <div key={dir}>
          <div className="sec-sub">{FUSE_DIR[dir].title}</div>
          <div className="fuse-grid">
            {fuseLegs(d.assets, dir).map(view => <FuseTile key={legKey(view)} view={view} now={now} />)}
          </div>
        </div>
      ))}
      {/* No legend: the deposit-fuse board above already teaches the colour
          scale, and these tiles speak it identically (locked = paused manager). */}
      <div className="hdx-note" style={{ marginTop: 12 }}>
        Each tile is one asset on one chain; where an asset reaches several chains the plate names the chain.
        A transfer has to clear the far chain's limiter and Hydration's own for that chain, and the tile draws whichever has less left.{' '}
        {facts.hydrationCaps.length
          ? <>Hydration's own manager caps {facts.hydrationCaps.map((c, i) => (
            <span key={`${c.row.assetId}:${c.chainName}:${c.dir}`}>
              {i > 0 && (i === facts.hydrationCaps.length - 1 ? ' and ' : ', ')}
              {c.row.symbol} {c.dir === 'in' ? `from ${c.chainName}` : 'out'} at <Amt raw={c.fuse.limit} dec={c.row.decimals} /> per {fmtDuration(c.fuse.durationSec * 1000)}
            </span>
          ))}; every other Hydration leg is uncapped.{' '}</>
          : <>Hydration's own managers are uncapped, so the far chains' limiters are the only fuses that can bind.{' '}</>}
        A transfer larger than the headroom left is held for {span} rather than lost: inbound always, and outbound when the
        sender asked to be queued instead of reverted.
      </div>
    </div>
  )
}

/* ---------- lockboxes & peers ---------- */

// Who holds what, chain by chain. A lockbox is custody — what a holder can
// still be paid out of on that chain — and a spoke is supply minted against
// custody elsewhere. The payout figure is a lockbox's own balance less the
// exits already burned toward it; where the far chain's limiter lets more
// through per window than the lockbox holds, the column says so plainly: a
// small lockbox is a fact about where the backing sits, not a fault.

function PeerChain({ peer }: { peer: WormholePeerRow }) {
  const custody = wormholeExplorerLink(peer.chainId, peer.manager)
  return (
    <span className="wh-peer-chain">
      <ChainBadge chain={peer.chainName} />
      <span className={`wh-role ${peer.role ?? 'unknown'}`} title={peer.mode ? `${peer.chainName} manager mode: ${peer.mode}` : 'mode unread'}>
        {peer.role === 'lockbox' ? 'lockbox' : peer.role === 'spoke' ? 'mints' : '—'}
      </span>
      {peer.primary && <span className="wh-tag" title="The asset's registered origin">origin</span>}
      {peer.layer && peer.layer !== 'l1' && peer.riskNote && <span className="wh-tag warn" title={peer.riskNote}>{peer.layer === 'l2' ? 'L2' : 'own chain'}</span>}
      {custody && <a className="wh-out mono" href={custody.href} target="_blank" rel="noreferrer noopener" title={`${peer.chainName} NTT manager ${peer.manager} on ${custody.kind}`}>manager ↗</a>}
    </span>
  )
}

function PeerToken({ peer }: { peer: WormholePeerRow }) {
  const t = peer.token
  if (!t) return <Dash />
  const link = peer.family === 'evm' ? wormholeExplorerLink(peer.chainId, t.address) : null
  return (
    <span className="wh-token" title={`${t.name ?? t.symbol ?? 'token'} on ${peer.chainName}\n${t.address}`}>
      {t.symbol && <span className="wh-token-sym">{t.symbol}</span>}
      {link
        ? <a className="hash mono wh-mgr" href={link.href} target="_blank" rel="noreferrer noopener">{F.shortAddr(t.address)} ↗</a>
        : <span className="mono muted wh-mgr">{F.shortAddr(t.address)}</span>}
    </span>
  )
}

// The two limits that bind each direction, short; every leg in the tooltip.
function PeerLimits({ row, peer }: { row: WormholeAssetRow; peer: WormholePeerRow }) {
  if (!peer.limits) return <Dash />
  const both = (['in', 'out'] as const).map(dir => ({ dir, leg: peerFuseLeg(peer, dir) }))
  const said = (fuse: WormholeFuse | null) => fuse == null ? 'unread'
    : F.num(fuse.limit, row.decimals) >= HYDRATION_UNCAPPED_TOKENS ? 'uncapped'
      : `${F.exact(fuse.capacity, row.decimals)} of ${F.exact(fuse.limit, row.decimals)} left`
  const title = [
    `${row.symbol} between Hydration and ${peer.chainName}, per ${fmtDuration((both[0].leg.binding?.durationSec ?? 86_400) * 1000)}`,
    `${peer.chainName} outbound (into Hydration): ${said(peer.limits.peerOut)}`,
    `Hydration inbound from ${peer.chainName}: ${said(peer.limits.hydrationIn)}`,
    `Hydration outbound (every chain): ${said(peer.limits.hydrationOut)}`,
    `${peer.chainName} inbound from Hydration (release leg): ${said(peer.limits.peerIn)}`,
  ].join('\n')
  return (
    <span className="wh-limits" title={title}>
      {both.map(({ dir, leg }) => (
        <span key={dir} className="wh-limit">
          <span className="muted">{dir}</span>{' '}
          {leg.binding == null ? <Dash />
            : F.num(leg.binding.limit, row.decimals) >= HYDRATION_UNCAPPED_TOKENS ? <span className="muted">uncapped</span>
              : <span className="mono"><Amt raw={leg.binding.limit} dec={row.decimals} /></span>}
        </span>
      ))}
    </span>
  )
}

function PeersTable({ d, now }: { d: WormholeBridgeDetail; now: number }) {
  const rows = d.assets.flatMap(row => (row.peers ?? []).map(peer => ({ row, peer })))
  // Hydration's own custody, where Hydration is the lockbox, is a row too: it
  // is the only thing backing the supply minted on its peers.
  const hydrationLockboxes = d.assets.filter(r => r.hydrationRole === 'lockbox')
  const riskNotes = [...new Map(rows.filter(r => r.peer.riskNote).map(r => [r.peer.chainId, r.peer])).values()]
  return (
    <>
      <div className="panel">
        <table className="tbl sec-tbl wh-peers">
          <thead>
            <tr>
              <th>Asset</th><th>Chain</th><th>Token there</th><th className="r">Holds</th>
              <th className="r">Limits / 24 h</th><th className="r">Can pay out</th><th>Peer since</th><th className="r">Status</th>
            </tr>
          </thead>
          <tbody>
            {!rows.length && !hydrationLockboxes.length ? <EmptyRow cols={8}>No peer chain could be read</EmptyRow> : <>
              {hydrationLockboxes.map(r => (
                <tr key={`${r.assetId}:hydration`}>
                  <td data-label="Asset"><AssetChip asset={assetRef(r)} /></td>
                  <td data-label="Chain"><span className="wh-peer-chain"><HydrationBadge /><span className="wh-role lockbox">lockbox</span><span className="wh-tag" title="The token is native to Hydration">origin</span></span></td>
                  <td data-label="Token there">
                    <span className="wh-token"><span className="wh-token-sym">{r.symbol}</span>
                      {r.hydrationToken && <Link className="hash mono wh-mgr" to={paths.account(r.manager)} title={`Locked by Hydration's NTT manager ${r.manager}`}>{F.shortAddr(r.manager)}</Link>}
                    </span>
                  </td>
                  <td data-label="Holds" className={`r${r.hydrationLocked == null ? ' cell-empty' : ''}`}>
                    {r.hydrationLocked == null ? <Dash /> : <span className="mono"><Amt raw={r.hydrationLocked} dec={r.decimals} /></span>}
                  </td>
                  <td data-label="Limits / 24 h" className="r"><Dash /></td>
                  <td data-label="Can pay out" className="r muted">backs every spoke</td>
                  <td data-label="Peer since"><Dash /></td>
                  <td data-label="Status" className="r"><span className={`badge ${WORMHOLE_STATUS[r.status].badge}`} title={r.statusDetail}>{WORMHOLE_STATUS[r.status].label}</span></td>
                </tr>
              ))}
              {rows.map(({ row, peer }) => {
                const meta = WORMHOLE_PEER_STATUS[peer.status]
                const payout = peer.payout
                return (
                  <tr key={`${row.assetId}:${peer.chainId}`} className={peer.status === 'unconfigured' ? 'dim' : undefined}>
                    <td data-label="Asset"><AssetChip asset={assetRef(row)} /></td>
                    <td data-label="Chain"><PeerChain peer={peer} /></td>
                    <td data-label="Token there"><PeerToken peer={peer} /></td>
                    <td data-label="Holds" className={`r${peer.balance == null ? ' cell-empty' : ''}`}>
                      {peer.balance == null ? <Dash /> : <>
                        <span className="mono"><Amt raw={peer.balance} dec={row.decimals} /></span>
                        <span className="muted mono sec-usd">{peer.role === 'spoke' ? 'minted' : peer.balanceUsd != null ? <Usd v={peer.balanceUsd} /> : 'locked'}</span>
                      </>}
                    </td>
                    <td data-label="Limits / 24 h" className="r"><PeerLimits row={row} peer={peer} /></td>
                    <td data-label="Can pay out" className={`r${payout?.capacity == null ? ' cell-empty' : ''}`}
                        title={payout?.baseline != null && BigInt(payout.baseline) !== 0n
                          ? `${F.exact(payout.baseline, row.decimals)} ${row.symbol} of it was funded outside Wormhole (custody the transfers through Hydration do not explain)`
                          : undefined}>
                      {payout?.capacity == null ? <Dash /> : <>
                        <span className="mono"><Amt raw={payout.capacity} dec={row.decimals} /></span>
                        {payout.coversPotential === false && payout.potential != null && (
                          <span className="muted mono sec-usd">of up to <Amt raw={payout.potential} dec={row.decimals} /> sendable</span>
                        )}
                      </>}
                    </td>
                    <td data-label="Peer since" className={peer.since ? undefined : 'cell-empty'}>
                      {peer.since ? (
                        <span className="wh-since">
                          <MomentLink at={{ blockHeight: peer.since.blockHeight, extrinsicIndex: peer.since.extrinsicIndex, timestamp: peer.since.timestamp }} now={now} />
                          <span className="muted wh-origin-by" title={peer.since.origin.kind === 'technical-committee' ? `Proposal ${peer.since.origin.proposalHash}` : undefined}>{changeOriginLabel(peer.since.origin)}</span>
                        </span>
                      ) : <Dash />}
                    </td>
                    <td data-label="Status" className="r">
                      <span className={`badge ${meta.badge}`} title={peer.statusDetail}>{meta.label}</span>
                    </td>
                  </tr>
                )
              })}
            </>}
          </tbody>
        </table>
      </div>
      {riskNotes.length > 0 && (
        <div className="hdx-note wh-risk">
          {riskNotes.map(p => <span key={p.chainId}>{p.riskNote}. </span>)}
          A lockbox holds only what was deposited on its own chain, so an exit toward a small lockbox can wait for
          deposits there even while the asset as a whole is fully backed.
        </div>
      )}
    </>
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
            <th>Asset</th><th>Lockboxes</th><th className="r">Locked</th><th className="r">Minted</th>
            <th className="r">In flight</th><th className="r">Difference</th><th className="r">Status</th>
          </tr>
        </thead>
        <tbody>
          {!d.assets.length ? <EmptyRow cols={7}>No Wormhole asset is registered on this chain</EmptyRow> : d.assets.map(r => {
            const meta = WORMHOLE_STATUS[r.status]
            const paused = r.pausedLocal === true || r.pausedOrigin === true
            // Every chain holding custody, Hydration included where it locks.
            const boxes = lockboxChains(r, d.hydrationChainId)
            const spokes = (r.peers ?? []).filter(p => p.role === 'spoke')
            const custody = (r.peers ?? []).length ? null : wormholeExplorerLink(r.originChainId, r.peer)
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
                <td data-label="Lockboxes">
                  <span className="wh-origin" title={boxes.length > 1 ? `${boxes.length} lockboxes: ${joinChains(boxes.map(b => b.name))}` : undefined}>
                    {boxes.map(b => {
                      const peer = (r.peers ?? []).find(p => p.chainId === b.chainId)
                      const link = peer ? wormholeExplorerLink(peer.chainId, peer.manager) : custody
                      return (
                        <span key={b.chainId} className="wh-box">
                          <span className="wh-chain">{b.name}</span>
                          {link && (
                            <a className="wh-out mono" href={link.href} target="_blank" rel="noreferrer noopener"
                               title={`Custody ${peer?.manager ?? r.peer} on ${link.kind}`}>custody ↗</a>
                          )}
                        </span>
                      )
                    })}
                    {spokes.length > 0 && <span className="muted wh-spokes">minted on {joinChains(spokes.map(p => p.chainName))}</span>}
                    {paused && <span className="badge pending" title={r.pausedOrigin === true ? 'A peer manager is paused' : 'The Hydration manager is paused'}>Paused</span>}
                  </span>
                </td>
                <td data-label="Locked" className={`r${r.locked == null ? ' cell-empty' : ''}`}>
                  {r.locked == null ? <Dash /> : <>
                    <span className="mono"><Amt raw={r.locked} dec={r.decimals} /></span>
                    {r.lockedUsd != null && <span className="muted mono sec-usd"><Usd v={r.lockedUsd} /></span>}
                  </>}
                </td>
                <td data-label="Minted" className={`r${r.issuance == null ? ' cell-empty' : ''}`}>
                  {r.issuance == null ? <Dash /> : <>
                    <span className="mono"><Amt raw={r.issuance} dec={r.decimals} /></span>
                    {/* Why custody can sit below what was minted: a burn at the dead
                        address retires supply the bridge no longer has to back. The
                        figure was a tooltip; it is a line now, because the amount
                        beside it owns the hover. */}
                    {r.burned != null && r.burned !== '0' &&
                      <span className="muted mono sec-usd"><Amt raw={r.burned} dec={r.decimals} /> burned at dEaD</span>}
                    {r.issuanceUsd != null && <span className="muted mono sec-usd"><Usd v={r.issuanceUsd} /></span>}
                  </>}
                </td>
                <td data-label="In flight" className={`r mono muted${pending == null || pending === 0n ? ' cell-empty' : ''}`}
                    title={pendingTitle}>
                  {pending == null || pending === 0n ? <Dash /> : <>
                    <Amt raw={pending.toString()} dec={r.decimals} />
                    {pendingCount ? <span className="wh-count"> · {F.int(pendingCount)}</span> : null}
                  </>}
                </td>
                {/* The signed gap between custody and what the chain owes. It is
                    coloured only when it is the row's verdict, and dollars join
                    the token figure only when they round to something. */}
                <td data-label="Difference" className={`r mono${r.residual == null ? ' cell-empty' : ''}`}
                    style={{ color: residualTone(r) }}>
                  {r.residual == null ? <Dash /> : r.residual === '0' ? <span className="muted">0</span> : <>
                    {r.residual.startsWith('-') ? '' : '+'}<Amt raw={r.residual} dec={r.decimals} />
                    {r.residualUsd != null && Math.abs(r.residualUsd) >= 0.005 &&
                      <span className="sec-usd">{r.residualUsd < 0 ? '' : '+'}<Usd v={r.residualUsd} /></span>}
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
    return <span className="mono"><Amt raw={op.amount} dec={dec} /></span>
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
                    {op.amountUsd != null && <span className="muted mono sec-usd"><Usd v={op.amountUsd} /></span>}
                  </td>
                  <td data-label="Sent" className={`r${op.sentAt == null ? ' cell-empty' : ''}`}>
                    {op.sentAt == null ? <Dash /> : <Ago ts={op.sentAt} now={now} />}
                  </td>
                  <td data-label="Sequence" className="r mono muted">{op.sequence}</td>
                </tr>
              ))}
              {queued.map(q => {
                const dec = decimals.get(q.assetId) ?? 0
                const arrival = q.direction === 'in'
                return (
                  <tr key={q.digest} className="wh-queued-row">
                    <td data-label="Route" className="wh-route">
                      <span className="wh-hop" title={arrival
                        ? `Sent from ${name(q.fromChainId ?? q.chainId)}, received on Hydration, and held by Hydration's own inbound rate limiter for that chain`
                        : 'Sent from Hydration, redeemed on the far chain, and held by its inbound rate limiter'}>
                        {arrival
                          ? <>{name(q.fromChainId ?? q.chainId)} <span className="wh-arrow">→</span> {name(d.hydrationChainId)}</>
                          : <>{name(d.hydrationChainId)} <span className="wh-arrow">→</span> {name(q.chainId)}</>}
                      </span>
                    </td>
                    <td data-label="Asset"><AssetChip asset={assetRef({ assetId: q.assetId, symbol: q.symbol, decimals: dec })} /></td>
                    <td data-label="Amount" className="r">
                      <span className="mono"><Amt raw={q.amount} dec={dec} /></span>
                      {q.amountUsd != null && <span className="muted mono sec-usd"><Usd v={q.amountUsd} /></span>}
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
  const locking = new Set(d.assets.filter(a => a.hydrationRole === 'lockbox').map(a => a.assetId))
  const dec = (row: WormholeTransferRow) => decimals.get(row.assetId) ?? 0
  // A locking manager releases and locks; a minting one mints and burns.
  const verb = (row: WormholeTransferRow) => locking.has(row.assetId)
    ? row.direction === 'in' ? 'released in' : 'locked out'
    : row.direction === 'in' ? 'minted in' : 'burned out'
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
                {verb(r)}
              </td>
              <td data-label="Asset"><AssetChip asset={assetRef({ assetId: r.assetId, symbol: r.symbol, decimals: dec(r) })} /></td>
              <td data-label="Amount" className="r">
                <span className="mono"><Amt raw={r.amount} dec={dec(r)} /></span>
                {r.amountUsd != null && <span className="muted mono sec-usd"><Usd v={r.amountUsd} /></span>}
              </td>
              <td data-label="Account" className={r.accountRef ? undefined : 'cell-empty'}>
                {r.accountRef ? <AddrPill account={r.accountRef} /> : <Dash />}
              </td>
              <td data-label="Counterparty">
                <span className="wh-counterparty">
                  <span className="mono muted">{name(r.counterpartyChainId)}</span>
                  {/* The far chain's own token — Robinhood's WETH is not Ethereum's. */}
                  {r.counterpartyToken && (() => {
                    const link = wormholeExplorerLink(r.counterpartyChainId, r.counterpartyToken.address)
                    const label = `${r.counterpartyToken.symbol ?? 'token'} ${F.shortAddr(r.counterpartyToken.address)}`
                    return link
                      ? <a className="hash mono wh-mgr" href={link.href} target="_blank" rel="noreferrer noopener" title={`${r.counterpartyToken.name ?? r.counterpartyToken.symbol ?? 'Token'} on ${name(r.counterpartyChainId)}: ${r.counterpartyToken.address}`}>{label} ↗</a>
                      : <span className="mono muted wh-mgr" title={r.counterpartyToken.address}>{label}</span>
                  })()}
                </span>
              </td>
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
  const lockboxes = d.lockboxes ?? null
  return (
    <div className="hdx-cards">
      <Card label="Locked in lockboxes" value={t.lockedUsd == null ? <Dash /> : <Usd v={t.lockedUsd} />}
        sub={lockboxes
          ? `${F.int(lockboxes.length)} lockboxes · ${F.int(chainsRead)} of ${F.int(d.chains.length)} chains read`
          : `custody across ${F.int(chainsRead)} of ${F.int(d.chains.length)} chains`} />
      <Card label="Bridged supply" value={t.issuanceUsd == null ? <Dash /> : <Usd v={t.issuanceUsd} />}
        sub={`minted against it · ${F.int(d.assets.length)} assets`} />
      <Card label="In flight"
        value={inflightUnchecked ? <Dash /> : F.int(d.inflight.length)}
        sub={inflightUnchecked
          ? 'transfers in transit are not checked'
          : t.inflightUsd != null && d.inflight.length ? <><Usd v={t.inflightUsd} /> between chains</> : 'every transfer is settled'} />
      {/* The number this page exists to keep at zero. */}
      <Card label="Backing deficit"
        value={unpricedShortfall || deficit == null ? <Dash /> : deficit > 0 ? <Usd v={deficit} /> : '$0'}
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
      {d.indexBehind && <>
        The index was {d.indexLagSec != null ? <>{F.int(Math.round(d.indexLagSec / 60))} min</> : 'too far'} behind the chain when supply was read, so supply is older than custody and any shortfall is held as unverified until indexing catches up.{' '}
      </>}
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
      <SecTitle title="Lockboxes & peers" />
      <div className="panel"><table className="tbl sec-tbl"><tbody><TableSkeleton cols={8} rows={6} /></tbody></table></div>
      <SecTitle title="Rate limits" />
      <ChartSkeleton h={190} />
      <SecTitle title="In flight" />
      <div className="panel"><table className="tbl sec-tbl"><tbody><TableSkeleton cols={5} rows={2} /></tbody></table></div>
    </>
  )
}

export function WormholeSection({ now }: { now: number }) {
  const { data: d, isError, refetch } = useWormholeBridge()
  if (isError) {
    return (
      <>
        <SecTitle title="Wormhole backing" />
        <LoadError card="pf-card" title="Couldn’t load the Wormhole backing snapshot" onRetry={() => { void refetch() }} />
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

      {/* Every chain of every asset: which hold custody, which mint, the token
          on each, the limits on both sides and what each lockbox can pay out. */}
      <SecTitle title="Lockboxes & peers"
        subtitle={`${F.int((d.lockboxes ?? []).length)} lockboxes · ${F.int(d.assets.reduce((n, a) => n + (a.peers?.length ?? 0), 0))} peer chains`} />
      <PeersTable d={d} now={now} />

      {/* The window comes from the limiters themselves, so the subtitle never
          promises a period the chain has stopped using. */}
      <SecTitle title="Rate limits"
        subtitle={[
          'per asset and chain',
          fuses.windowSec > 0 ? `${fmtDuration(fuses.windowSec * 1000)} rolling window` : null,
          hottestFuseText(fuses),
        ].filter(Boolean).join(' · ')} />
      {fuses.readable
        ? <RateLimits d={d} facts={fuses} now={now} />
        : <div className="pf-card"><div className="hdx-note">
          No peer chain's rate limiter could be read, so how much of each transfer allowance is left is unknown.
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
