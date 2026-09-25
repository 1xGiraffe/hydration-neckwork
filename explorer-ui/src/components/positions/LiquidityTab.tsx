import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { FarmRewardsSummary, LiquidityHistory, LpPosition, PositionScope } from '../../types'
import { F, Amt, Usd, AssetIcon, AreaChart, AddrPill, ChartCardSkeleton, Dash, Pager, rowNav } from '../ui'
import { CAT } from '../activityColors'
import { Link, paths, setQuery, useQueryValue } from '../../router'
import { positionsApi } from '../../api/explorer'
import { useLiquidityHistory, useLiquidityRewards, useYields } from '../../hooks/usePositions'
import { blockRangeForWindow } from '../../utils/chartRefine'
import { tsDate } from '../../utils/time'
import { YieldHover } from './YieldHover'
import { aprText } from './yieldFormat'
import {
  groupPools, historyRows, liquidityKpis, poolAprRows, rewardsEarned,
  type Leg, type PoolGroup, type PositionView, type RewardTally,
} from './liquidityModel'

// Liquidity tab: the holder's positions aggregated by pool (with APR and its
// composition), then the LP history — value over time, rewards earned
// (claimed and unclaimed) and every position ever held. Read-only: the tab
// states what is held and what it earns, it offers no actions.

// Same venue hues as the account's position badges: every LP product stays
// inside the liquidity family's blues.
const VENUE_COLORS: Record<string, string> = {
  Omnipool: CAT.liquidity, 'Omnipool Farm': CAT.liquidityCreate, Stablepool: 'var(--sky-deep)',
  XYK: CAT.liquidityRemove, 'XYK Farm': CAT.liquidityCreate,
  'Uniswap v3': CAT.liquidityClaim, 'Gamma vault': 'var(--sky-deep)',
}
function VenueBadge({ venue }: { venue: string }) {
  const col = VENUE_COLORS[venue] ?? CAT.liquidity
  return <span className="badge" style={{ background: `color-mix(in srgb, ${col} 14%, transparent)`, color: col }}>{venue}</span>
}

const EXPAND_BY_DEFAULT_MAX = 12
const HISTORY_PAGE = 25

const POOL_NOTE = 'Estimated APR of the pool: the last 30 days of fees at current TVL (concentrated liquidity: 7 days, range-wide), live farm rewards at full loyalty, the lending yield of money-market legs and the own yield of yield-bearing legs (vDOT, wstETH, PRIME… at the current APY the Hydration UI shows, else their on-chain rate). Impermanent loss is not considered.'
const POSITION_NOTE = 'This position\'s estimated APR: the pool\'s fee-side yield plus each farm it is in at the entry\'s current loyalty. Impermanent loss is not considered.'
const REWARDS_TITLE = 'What claiming every farm entry now would pay (loyalty applied, already-claimed rewards subtracted), at current prices. Beside the positions\' value, never inside it.'

export function LiquidityTab({ scope, positions, farmRewards, showOwner }: {
  scope: PositionScope
  positions: LpPosition[]
  /** The detail's unclaimed farm rewards; `items` carry each entry's loyalty and yield farm. */
  farmRewards?: FarmRewardsSummary | null
  /** Tags: name the member behind each position where one is known. */
  showOwner?: boolean
}) {
  const yields = useYields(positions.length > 0)
  const claimed = useLiquidityRewards(scope)
  const history = useLiquidityHistory(scope)
  const groups = useMemo(() => groupPools(positions, yields.data, farmRewards), [positions, yields.data, farmRewards])
  const kpis = useMemo(() => liquidityKpis(groups, farmRewards, claimed.data), [groups, farmRewards, claimed.data])
  const earned = useMemo(() => rewardsEarned(claimed.data, farmRewards, positions), [claimed.data, farmRewards, positions])

  return (
    <div className="lpt">
      {positions.length > 0 && <>
        <LiquidityKpiStrip kpis={kpis} claimedLoading={claimed.isLoading} yieldsLoading={yields.isLoading} />
        <PoolsTable groups={groups} showOwner={!!showOwner} yieldsFailed={yields.isError} />
      </>}
      {positions.length === 0 && <div className="sec-title">Liquidity</div>}
      {positions.length === 0 && <div className="panel lpt-empty muted">No liquidity held now. Earlier positions and the rewards they earned are below.</div>}
      <div className="sec-title">LP history</div>
      <LpValueChart scope={scope} history={history.data} loading={history.isLoading} failed={history.isError} />
      <RewardsEarnedTable rows={earned} loading={claimed.isLoading} failed={claimed.isError} />
      <PositionHistoryTable history={history.data} loading={history.isLoading} />
    </div>
  )
}

// ── KPI strip ────────────────────────────────────────────────────────────
function Kpi({ label, children, hint, title }: { label: string; children: ReactNode; hint?: ReactNode; title?: string }) {
  return (
    <div className="lpt-kpi" title={title}>
      <div className="lab">{label}</div>
      <div className="amt">{children}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  )
}

// Counted aloud, never valued: the tile's title says they are not in the figure.
const aloud = (n: number, what: string) => (n > 0 ? `+ ${n} ${what}` : null)

function LiquidityKpiStrip({ kpis, claimedLoading, yieldsLoading }: { kpis: ReturnType<typeof liquidityKpis>; claimedLoading: boolean; yieldsLoading: boolean }) {
  const { apr } = kpis
  const partial = apr.pct != null && apr.coveredUsd < apr.totalUsd - 0.005
  const unclaimedHint = [aloud(kpis.unclaimed.unpriced, 'unpriced'), aloud(kpis.unclaimed.unpayable, 'unpayable')].filter(Boolean).join(' · ')
  return (
    <div className="lpt-kpis" role="group" aria-label="Liquidity summary">
      <Kpi label="LP value" hint={kpis.unpricedPositions > 0 ? `+ ${kpis.unpricedPositions} unpriced` : null} title="Current value of every position at current prices (principal only; unclaimed rewards are beside it).">
        <Usd v={kpis.valueUsd} />
      </Kpi>
      <Kpi label="In farms" hint={kpis.inFarmsUnpriced > 0 ? `+ ${kpis.inFarmsUnpriced} unpriced` : null} title="The part of LP value deposited in liquidity-mining farms."><Usd v={kpis.inFarmsUsd} /></Kpi>
      <Kpi label="Unclaimed" hint={unclaimedHint || null} title={`${REWARDS_TITLE}${unclaimedHint ? ' Unpriced and unpayable rewards (below the existential deposit) are not included.' : ''}`}><Usd v={kpis.unclaimed.usd} /></Kpi>
      <Kpi label="Claimed all-time" hint={kpis.claimedUnpriced > 0 ? `+ ${kpis.claimedUnpriced} unpriced claims` : null} title="Every farm reward claimed over the holder's history, each claim valued at its own time.">
        {claimedLoading ? <span className="muted">…</span> : <Usd v={kpis.claimedUsd} />}
      </Kpi>
      <Kpi label="APR" hint={partial ? <>of <Usd v={apr.coveredUsd} /></> : null}
        title={apr.pct == null ? 'No position has a known rate.' : partial ? `Value-weighted over the positions with a known rate: ${F.usd(apr.coveredUsd)} of ${F.usd(apr.totalUsd)}.` : 'Value-weighted over every position (fees plus farms at each entry\'s loyalty).'}>
        {yieldsLoading ? <span className="muted">…</span> : <span className="mono">{aprText(apr.pct)}</span>}
      </Kpi>
    </div>
  )
}

// ── pools table ──────────────────────────────────────────────────────────
function Legs({ legs }: { legs: Leg[] }) {
  if (!legs.length) return <Dash />
  return (
    <>
      {legs.map((l, i) => (
        <div key={l.asset.assetId} className={i > 0 ? 'lpt-leg2' : undefined}>
          {i > 0 && '+ '}<Amt raw={l.raw.toString()} dec={l.asset.decimals} /> {l.asset.symbol}
        </div>
      ))}
    </>
  )
}

function positionLegs(p: LpPosition): Leg[] {
  const legs: Leg[] = []
  const add = (asset: LpPosition['asset'], raw?: string) => { if (raw) { try { legs.push({ asset, raw: BigInt(raw) }) } catch { /* not an integer */ } } }
  add(p.asset, p.amount)
  if (p.hubAmount) add({ assetId: 1, symbol: 'H2O', name: null, decimals: 12, parachainId: null }, p.hubAmount)
  if (p.assetB) add(p.assetB, p.amountB)
  return legs
}

function Rewards({ tally }: { tally: RewardTally }) {
  if (!tally.held.length) return <Dash />
  const notes = `${tally.unpriced ? ` (+ ${tally.unpriced} unpriced)` : ''}${tally.unpayable ? ` (+ ${tally.unpayable} unpayable)` : ''}`
  const pricedAny = tally.held.some(r => r.valueUsd != null && r.payable !== false)
  return (
    <span title={REWARDS_TITLE}>
      {pricedAny
        ? <><Usd v={tally.usd} />{notes && <span className="lpt-note">{notes}</span>}</>
        : tally.held.map((r, i) => <span key={`${r.depositId}-${r.yieldFarmId}`} className="lpt-leg2">{i > 0 ? ' · ' : ''}<Amt raw={r.amount} dec={r.asset.decimals} /> {r.asset.symbol}{r.payable === false ? ' (unpayable)' : ''}</span>)}
    </span>
  )
}

function positionName(p: LpPosition): string {
  if (p.venue === 'Stablepool') return 'Pool shares'
  if (p.venue === 'Gamma vault') return 'Vault shares'
  if (p.venue === 'XYK') return 'LP shares'
  if (p.venue === 'XYK Farm') return 'Farmed LP shares'
  return `#${p.tokenId ?? p.positionId}`
}

function PoolsTable({ groups, showOwner, yieldsFailed }: { groups: PoolGroup[]; showOwner: boolean; yieldsFailed: boolean }) {
  const total = groups.reduce((s, g) => s + g.positions.length, 0)
  const defaultOpen = total <= EXPAND_BY_DEFAULT_MAX
  // Explicit toggles over the default, so a later refetch keeps the reader's choice.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const isOpen = (id: string) => overrides[id] ?? defaultOpen
  const allOpen = groups.every(g => isOpen(g.id))
  const setAll = (open: boolean) => setOverrides(Object.fromEntries(groups.map(g => [g.id, open])))
  return (
    <>
      <div className="sec-title-row lpt-head">
        <span className="sec-title lpt-title">Pools · {groups.length}<span className="lpt-sub-title">{total} position{total === 1 ? '' : 's'}</span></span>
        {groups.length > 0 && <button type="button" className="lpt-toggle-all" onClick={() => setAll(!allOpen)} aria-expanded={allOpen}>{allOpen ? 'Collapse all' : 'Expand all'}</button>}
      </div>
      {yieldsFailed && <div className="lpt-warn muted">Rates are unavailable right now; APR columns read —.</div>}
      <div className="panel"><table className="tbl assets-tbl lpt-tbl">
        <thead><tr>
          <th>Pool</th>{showOwner && <th>Owner</th>}<th className="r">Positions</th><th className="r">Amounts</th><th className="r">Value</th><th className="r">APR</th><th className="r">Unclaimed</th>
        </tr></thead>
        <tbody>
          {groups.map(g => {
            const open = isOpen(g.id)
            const toggle = () => setOverrides(o => ({ ...o, [g.id]: !open }))
            const farmIcons = g.yield?.farms.map(f => f.rewardAsset).filter((a, i, all) => all.findIndex(b => b.assetId === a.assetId) === i)
            return [
              <tr key={g.id} {...rowNav(g.to)} className="clickable lpt-pool">
                <td data-label="Pool">
                  <div className="asset-row lpt-pool-cell">
                    <button type="button" className={`exp-btn${open ? ' open' : ''}`} aria-expanded={open}
                      aria-label={`${open ? 'Collapse' : 'Expand'} ${g.label} positions`}
                      onClick={e => { e.stopPropagation(); toggle() }}>▸</button>
                    <AssetIcon assetId={g.icon.assetId} iconAssetId={g.icon.iconAssetId} iconAssetIds={g.icon.iconAssetIds} symbol={g.icon.symbol} size={28} parachainId={g.icon.parachainId} origin={g.icon.origin} />
                    <div className="ar-meta">
                      <Link to={g.to} className="ar-sym lpt-pool-link">{g.label}</Link>
                      <span className="lpt-badges">{g.venues.map(v => <VenueBadge key={v} venue={v} />)}</span>
                    </div>
                  </div>
                </td>
                {showOwner && <td data-label="Owner" className="cell-empty" />}
                <td data-label="Positions" className="r mono">{g.positions.length}</td>
                <td data-label="Amounts" className="r mono"><Legs legs={g.legs} /></td>
                <td data-label="Value" className="r mono"><Usd v={g.valueUsd} />{g.unpricedPositions > 0 && <span className="lpt-note"> (+ {g.unpricedPositions} unpriced)</span>}</td>
                <td data-label="APR" className="r">
                  <YieldHover total={g.yield?.totalAprPct ?? null} rows={poolAprRows(g.yield)} icons={farmIcons} title={`${g.label} · pool APR`} note={POOL_NOTE} />
                </td>
                <td data-label="Unclaimed" className="r mono"><Rewards tally={g.rewards} /></td>
              </tr>,
              ...(open ? g.positions.map(v => <PositionRow key={`${g.id}|${v.p.venue}|${v.p.positionId}|${v.p.owner?.accountId ?? ''}`} v={v} showOwner={showOwner} />) : []),
            ]
          })}
        </tbody>
      </table></div>
    </>
  )
}

function PositionRow({ v, showOwner }: { v: PositionView; showOwner: boolean }) {
  const { p } = v
  const icons = v.entries.map(e => e.asset).filter((a, i, all): a is NonNullable<typeof a> => !!a && all.findIndex(b => b?.assetId === a.assetId) === i)
  return (
    <tr className="lpt-pos">
      <td data-label="Position">
        <div className="lpt-pos-name">
          <span className="mono">{positionName(p)}</span>
          <VenueBadge venue={p.venue} />
        </div>
      </td>
      {showOwner && <td data-label="Owner">{p.owner ? <AddrPill account={p.owner} /> : <Dash />}</td>}
      <td data-label="Positions" className="r col-hide-mobile" />
      <td data-label="Amounts" className="r mono"><Legs legs={positionLegs(p)} /></td>
      <td data-label="Value" className="r mono"><Usd v={p.valueUsd} /></td>
      <td data-label="APR" className="r">
        <YieldHover total={v.apr.total} rows={v.apr.rows} icons={icons} title={`${positionName(p)} · position APR`} note={v.apr.note ? `${v.apr.note} ${POSITION_NOTE}` : POSITION_NOTE} />
      </td>
      <td data-label="Unclaimed" className="r mono"><Rewards tally={v.rewards} /></td>
    </tr>
  )
}

// ── LP history: value chart ──────────────────────────────────────────────
function LpValueChart({ scope, history, loading, failed }: { scope: PositionScope; history?: LiquidityHistory; loading: boolean; failed: boolean }) {
  if (loading) return <ChartCardSkeleton metrics={0} legend />
  if (failed) return <div className="panel lpt-empty muted">The LP value history could not be loaded.</div>
  const series = history?.valueUsd ?? []
  if (!history || series.length <= 1) return <div className="panel lpt-empty muted">No LP value history.</div>
  const withRewards = series.map((v, i) => v + (history.unclaimedRewardsUsd[i] ?? 0))
  const hasRewards = history.unclaimedRewardsUsd.some(v => v > 0)
  const overlay = hasRewards ? { data: withRewards, label: 'Incl. unclaimed rewards', color: 'var(--sky)' } : undefined
  const unpricedBuckets = history.unpriced.filter(n => n > 0).length
  const incompleteBuckets = history.rewardsIncomplete.filter(n => n > 0).length
  const last = series.length - 1
  const refine = async (fromSec: number, toSec: number) => {
    const range = blockRangeForWindow(history.dates, history.blocks, fromSec, toSec)
    if (!range) return null
    const w = await positionsApi.liquidityHistoryWindow(scope, range.fromBlock, range.toBlock)
    if (w.valueUsd.length <= 1) return null
    // Both curves refine together or neither does.
    const ov = hasRewards && w.unclaimedRewardsUsd.length === w.valueUsd.length ? w.valueUsd.map((v, i) => v + (w.unclaimedRewardsUsd[i] ?? 0)) : undefined
    return { data: w.valueUsd, dates: w.dates, overlay: ov }
  }
  const up = series[last] >= series[0]
  return (
    <div className="pf-card lpt-chart">
      <div className="pf-head"><div className="pf-now"><Usd v={series[last]} /></div></div>
      {overlay && (
        <div className="pf-legend">
          <span className="pf-key"><i className="pf-swatch" style={{ background: up ? 'var(--green)' : 'var(--red)' }} />Positions</span>
          <span className="pf-key"><i className="pf-swatch" style={{ background: 'var(--sky)' }} />Incl. unclaimed rewards<span className="pf-key-val"><Usd v={withRewards[last]} /></span></span>
        </div>
      )}
      <AreaChart data={series} h={170} dates={history.dates} refine={refine} zoomKey="zlph" label="Positions" overlay={overlay} />
      {(unpricedBuckets > 0 || incompleteBuckets > 0) && (
        <div className="lpt-foot muted">
          {unpricedBuckets > 0 && <span>{unpricedBuckets} of {series.length} points leave out a position with no price at that time.</span>}
          {incompleteBuckets > 0 && <span> {incompleteBuckets} points leave out rewards that could not be stated.</span>}
        </div>
      )}
    </div>
  )
}

// ── LP history: rewards earned ───────────────────────────────────────────
// A long-farming account earned from dozens of (pool × reward) pairs; the
// largest few carry the story, so the rest fold behind one control. The totals
// row always sums every pair.
const EARNED_FOLD = 8
function RewardsEarnedTable({ rows, loading, failed }: { rows: ReturnType<typeof rewardsEarned>; loading: boolean; failed: boolean }) {
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? rows : rows.slice(0, EARNED_FOLD)
  const totals = rows.reduce((t, r) => ({
    claimed: t.claimed + (r.claimedUsd ?? 0), unclaimed: t.unclaimed + r.unclaimedUsd,
    unpriced: t.unpriced + r.claimedUnpriced + r.unclaimedUnpriced, unpayable: t.unpayable + r.unclaimedUnpayable,
  }), { claimed: 0, unclaimed: 0, unpriced: 0, unpayable: 0 })
  return (
    <>
      <div className="sec-title lpt-subsec">Rewards earned<span className="lpt-sub-title">claimed at the time of each claim · unclaimed at current prices</span></div>
      {failed && <div className="lpt-warn muted">Claimed rewards could not be loaded; only what is claimable now is shown.</div>}
      <div className="panel"><table className="tbl assets-tbl lpt-tbl lpt-earned">
        <thead><tr><th>Pool</th><th>Reward</th><th className="r">Claimed</th><th className="r">Unclaimed now</th><th className="r">Total earned</th></tr></thead>
        <tbody>
          {loading && !rows.length && <tr><td colSpan={5} className="muted">Loading…</td></tr>}
          {!loading && !rows.length && <tr><td colSpan={5} className="muted">No farm rewards earned yet.</td></tr>}
          {shown.map(r => {
            const total = r.claimedRaw + r.unclaimedRaw
            const unknown = r.claimedUnpriced + r.unclaimedUnpriced
            return (
              <tr key={r.key}>
                <td data-label="Pool">
                  <div className="asset-row">
                    <AssetIcon assetId={r.pool.assetId} iconAssetId={r.pool.iconAssetId} iconAssetIds={r.pool.iconAssetIds} symbol={r.pool.symbol} size={22} parachainId={r.pool.parachainId} origin={r.pool.origin} />
                    <span className="ar-sym">{r.pool.symbol}</span>
                    <VenueBadge venue={r.pallet === 'xyk' ? 'XYK Farm' : 'Omnipool Farm'} />
                  </div>
                </td>
                <td data-label="Reward">
                  <div className="asset-row">
                    <AssetIcon assetId={r.reward.assetId} iconAssetId={r.reward.iconAssetId} iconAssetIds={r.reward.iconAssetIds} symbol={r.reward.symbol} size={18} parachainId={r.reward.parachainId} origin={r.reward.origin} />
                    <span>{r.reward.symbol}</span>
                  </div>
                </td>
                <td data-label="Claimed" className="r mono">
                  {r.claimedRaw > 0n ? <><Amt raw={r.claimedRaw.toString()} dec={r.reward.decimals} /><div className="lpt-leg2"><Usd v={r.claimedUsd} />{r.claimedUnpriced > 0 && ` (+ ${r.claimedUnpriced} unpriced)`}</div></> : <Dash />}
                </td>
                <td data-label="Unclaimed now" className="r mono">
                  {r.unclaimedRaw > 0n ? <><Amt raw={r.unclaimedRaw.toString()} dec={r.reward.decimals} /><div className="lpt-leg2">{r.unclaimedUsd > 0 || (r.unclaimedUnpriced === 0 && r.unclaimedUnpayable === 0) ? <Usd v={r.unclaimedUsd} /> : null}{r.unclaimedUnpriced > 0 && ` (+ ${r.unclaimedUnpriced} unpriced)`}{r.unclaimedUnpayable > 0 && ` (+ ${r.unclaimedUnpayable} unpayable)`}</div></> : <Dash />}
                </td>
                <td data-label="Total earned" className="r mono">
                  <Amt raw={total.toString()} dec={r.reward.decimals} /> {r.reward.symbol}
                  <div className="lpt-leg2"><Usd v={(r.claimedUsd ?? 0) + r.unclaimedUsd} />{unknown > 0 && ' (partial)'}</div>
                </td>
              </tr>
            )
          })}
          {rows.length > 1 && (
            <tr className="lpt-total">
              <td data-label="Pool"><span className="lpt-total-lab">Total</span></td>
              <td data-label="Reward" className="col-hide-mobile" />
              <td data-label="Claimed" className="r mono"><Usd v={totals.claimed} /></td>
              <td data-label="Unclaimed now" className="r mono"><Usd v={totals.unclaimed} /></td>
              <td data-label="Total earned" className="r mono"><Usd v={totals.claimed + totals.unclaimed} />
                {(totals.unpriced > 0 || totals.unpayable > 0) && <div className="lpt-leg2">{totals.unpriced > 0 && `+ ${totals.unpriced} unpriced`}{totals.unpriced > 0 && totals.unpayable > 0 && ' · '}{totals.unpayable > 0 && `+ ${totals.unpayable} unpayable`}, not included</div>}
              </td>
            </tr>
          )}
        </tbody>
      </table></div>
      {rows.length > EARNED_FOLD && (
        <button type="button" className="hint-link lpt-fold" aria-expanded={showAll} onClick={() => setShowAll(v => !v)}>
          {showAll ? 'Show the largest only' : `Show all ${rows.length} pool × reward pairs`}
        </button>
      )}
    </>
  )
}

// ── LP history: position history ─────────────────────────────────────────
function BlockDate({ block, at }: { block: number | null; at: string | null }) {
  if (block == null) return <Dash />
  return <Link to={paths.block(block)} className="hash" title={at ? F.datetime(at) : `Block ${F.int(block)}`}>{at ? tsDate(at) : `#${F.int(block)}`}</Link>
}

// The history's position handle, named like the pools table's sub-rows.
function historyPositionName(venue: string, positionId: string | null): ReactNode {
  if (venue === 'Gamma vault') return <span className="muted">vault shares</span>
  if (!positionId) return <span className="muted">shares</span>
  // Concentrated-liquidity ids end in the NFT token id (`v3:<manager>:<tokenId>`).
  return `#${positionId.startsWith('v3:') ? positionId.split(':').pop() : positionId}`
}

function PositionHistoryTable({ history, loading }: { history?: LiquidityHistory; loading: boolean }) {
  const rows = useMemo(() => historyRows(history?.positions ?? []), [history])
  const requested = Number.parseInt(useQueryValue('lphpage'), 10)
  const pages = Math.max(1, Math.ceil(rows.length / HISTORY_PAGE))
  const page = Number.isFinite(requested) && requested > 0 ? requested : 0
  const slice = rows.slice(page * HISTORY_PAGE, page * HISTORY_PAGE + HISTORY_PAGE)
  const omitted = history?.positionsOmitted ?? 0
  return (
    <>
      <div className="sec-title lpt-subsec">Position history{rows.length > 0 && ` · ${rows.length}`}
        {omitted > 0 && <span className="lpt-sub-title">{F.int(omitted)} older position{omitted === 1 ? '' : 's'} not listed</span>}
      </div>
      <div className="panel"><table className="tbl assets-tbl lpt-tbl lpt-hist">
        <thead><tr><th>Pool</th><th>Venue</th><th>Position</th><th className="r">Opened</th><th className="r">Closed</th><th className="r">Last value</th></tr></thead>
        <tbody>
          {loading && <tr><td colSpan={6} className="muted">Loading…</td></tr>}
          {!loading && !rows.length && <tr><td colSpan={6} className="muted">No positions in the history.</td></tr>}
          {slice.map(r => (
            <tr key={r.key}>
              <td data-label="Pool">
                <div className="asset-row">
                  {r.pool && <AssetIcon assetId={r.pool.assetId} iconAssetId={r.pool.iconAssetId} iconAssetIds={r.pool.iconAssetIds} symbol={r.pool.symbol} size={22} parachainId={r.pool.parachainId} origin={r.pool.origin} />}
                  <span className="ar-sym">{r.poolLabel}</span>
                </div>
              </td>
              <td data-label="Venue"><VenueBadge venue={r.venue} /></td>
              <td data-label="Position" className="mono">{historyPositionName(r.venue, r.positionId)}</td>
              <td data-label="Opened" className="r mono"><BlockDate block={r.openedBlock} at={r.openedAt} /></td>
              <td data-label="Closed" className="r mono">{r.active ? <span className="lpt-active">active</span> : <BlockDate block={r.closedBlock} at={r.closedAt} />}</td>
              <td data-label="Last value" className="r mono"><Usd v={r.lastValueUsd} /></td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {pages > 1 && <Pager page={page} totalPages={pages} onPage={n => setQuery({ lphpage: n > 0 ? String(n) : null })} />}
    </>
  )
}
