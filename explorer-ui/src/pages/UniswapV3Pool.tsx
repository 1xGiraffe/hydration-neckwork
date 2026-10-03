import { useNow } from '../hooks/useNow'
import { useV3PoolVolume } from '../api/volume'
import { asOfLabel, fmtVolumeTvl } from '../utils/volume'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useV3Pool, useV3PoolActivity, useV3PoolHistory, useV3PoolLiquidity } from '../hooks/useExplorerData'
import { api } from '../api/explorer'
import { windowRefine } from '../utils/chartRefine'
import { distributionSlices, distributionWindow, fmtLiquidity } from '../utils/v3Distribution'
import { Link, paths } from '../router'
import { accountHref, Usd, Amt, AddrPill, Ago, AreaChart, AssetAmount, AssetChip, AssetIcon, ChartSkeleton, Crumbs, Dash, EmptyRow, F, PoolBadge, rowNav } from '../components/ui'
import { ChartLegend, MultiLineChart, ShareBar, StackedColumnChart, type ChartZone, type ShareSegment, type StackColumn } from '../components/HdxCharts'
import { ActivityTable } from '../components/ActivityTable'
import { PoolVolumeHead, TvlSection, VOLUME_BAR_COLOR, VolumeTvlSection } from '../components/VolumeCharts'
import { useAssetColors } from '../utils/iconColor'
import { useYields } from '../hooks/usePositions'
import { PoolApr } from '../components/positions/PoolApr'
import type { UniswapV3PoolDetail, UniswapV3PoolHistory, UniswapV3PositionRow } from '../types'

// One concentrated-liquidity (Uniswap v3) pool, addressed by its contract. Unlike
// a share-token pool, a v3 pool has no single reserve curve: liquidity sits in
// tick ranges, so the page shows the price the last swap left the pool at, the
// in-range liquidity, the positions with their ranges, and — where a Gamma vault
// manages positions for depositors — the vault's totals, fee cut and ranges.
// Balances and fees are what the pool's own logs imply (its aToken side accrues
// yield the pool never books, so they can run a little under the contract's).

const fmtPrice = (v: number) => v.toLocaleString('en-US', { minimumSignificantDigits: 4, maximumSignificantDigits: 6 })

function priceLabel(d: UniswapV3PoolDetail, v: number): string {
  return `${fmtPrice(v)} ${d.token1.symbol}/${d.token0.symbol}`
}

function RangeCell({ d, lower, upper, inRange }: { d: UniswapV3PoolDetail; lower: number; upper: number; inRange: boolean }) {
  return (
    <span className="mono" style={{ whiteSpace: 'nowrap' }}>
      {fmtPrice(lower)} – {fmtPrice(upper)} <span className="muted">{d.token1.symbol}/{d.token0.symbol}</span>
      <span className="badge" style={{ marginLeft: 8, background: inRange ? 'color-mix(in srgb, var(--cat-liquidity) 15%, transparent)' : 'color-mix(in srgb, var(--text-low) 15%, transparent)', color: inRange ? 'var(--cat-liquidity)' : 'var(--text-low)' }}>
        {inRange ? 'in range' : 'out of range'}
      </span>
    </span>
  )
}

function PositionRow({ d, p, now }: { d: UniswapV3PoolDetail; p: UniswapV3PositionRow; now: number }) {
  const open = BigInt(p.liquidity || '0') > 0n
  return (
    <tr {...(p.owner ? rowNav(accountHref(p.owner)) : {})} style={open ? undefined : { opacity: 0.6 }}>
      <td data-label="Position" className="mono">#{p.tokenId}{!open && <span className="muted" style={{ marginLeft: 6 }}>closed</span>}</td>
      <td data-label="Owner">{p.owner ? <AddrPill account={p.owner} noCopy /> : <Dash />}</td>
      <td data-label="Range"><RangeCell d={d} lower={p.priceLower} upper={p.priceUpper} inRange={open && p.inRange} /></td>
      <td data-label="Holdings" className="r">
        <span className="asset-flow"><span className="trade-leg"><AssetAmount asset={d.token0} raw={p.amount0} /></span> + <span className="trade-leg"><AssetAmount asset={d.token1} raw={p.amount1} /></span></span>
      </td>
      <td data-label="Value" className="r mono">{p.usd != null ? <Usd v={p.usd} /> : <Dash />}</td>
      <td data-label="Opened" className="r mono"><Link to={paths.block(p.openedBlock)} className="hash"><Ago ts={p.openedAt} now={now} /></Link></td>
    </tr>
  )
}

// What a liquidity provider wants from a pool's history, and how the page answers it:
//   * where the price went and how far it swung — the close line with the bucket's
//     low/high as an envelope, so "was my range in play" reads off the chart;
//     the vault's live ranges are drawn as flat reference lines for the same reason;
//   * what traded and what it paid — volume and gross swap fees per bucket in USD;
//   * how deep the pool was — active liquidity after the last swap, and what it held.
// The default view is the pool's whole life at the coarsest ladder grain that fits
// ~180 points (daily, weekly, … as it ages); dragging on a chart refetches the window
// on the finest grain that fits, down to the swaps themselves for a short window.
// Every chart shares one zoom key so a selection on one moves them all.
const grainLabel = (g: UniswapV3PoolHistory['grain']): string => {
  if (g.kind === 'swap') return 'swap by swap'
  const s = g.stepSec
  if (s % 86_400 === 0) { const d = s / 86_400; return d === 1 ? 'daily' : d === 7 ? 'weekly' : d === 30 ? 'monthly' : `${d}-day buckets` }
  const h = s / 3_600
  return h === 1 ? 'hourly' : `${h}-hour buckets`
}

// Where the liquidity sits: the API's segments (liquidity between consecutive
// initialised ticks) sliced into equal columns around the vault's ranges (or the
// price), coloured by the side of the price — the token the pool would sell there.
const DISTRIBUTION_COLUMNS = 40
function LiquidityDistribution({ d }: { d: UniswapV3PoolDetail }) {
  const colorFor = useAssetColors([d.token0, d.token1])
  const q = useV3PoolLiquidity(d.address)
  const dist = q.data
  if (q.isLoading) return <><div className="sec-title">Liquidity distribution</div><div className="pf-card"><ChartSkeleton h={190} /></div></>
  if (!dist || dist.segments.length === 0) return null
  const vaultRanges = dist.ranges.filter(r => r.ownerKind === 'vault')
  const win = distributionWindow(dist.segments, dist.tick, vaultRanges)
  const slices = distributionSlices(dist.segments, dist.tick, win, DISTRIBUTION_COLUMNS)
  const priceAt = (tick: number) => 1.0001 ** tick * 10 ** (d.token0.decimals - d.token1.decimals)
  // Each side wears its own token's colour — the same colours the composition bar
  // and every asset chip on the page use, so a column reads as "this is the HOLLAR
  // the pool would sell here". The column holding the price holds both, so it is
  // the two mixed, which also marks where the price stands.
  const c0 = colorFor(d.token0), c1 = colorFor(d.token1)
  const bothColor = `color-mix(in srgb, ${c0} 50%, ${c1})`
  const colorOf = (side: 'token0' | 'token1' | 'both', current: boolean) =>
    current || side === 'both' ? bothColor : side === 'token1' ? c1 : c0
  const labelEvery = Math.max(1, Math.round(DISTRIBUTION_COLUMNS / 5))
  const columns: StackColumn[] = slices.map((s, i) => ({
    key: String(i),
    label: i % labelEvery === 0 ? fmtPrice(priceAt(s.tickFrom)) : '',
    segments: [{ key: 'L', label: 'Liquidity', color: colorOf(s.side, s.current), value: s.liquidity }],
    tip: <>
      <span className="t-d">{fmtPrice(priceAt(s.tickFrom))} – {fmtPrice(priceAt(s.tickTo))} {d.token1.symbol}/{d.token0.symbol}</span>
      <span className="t-row">L = {s.liquidity > 0 ? fmtLiquidity(s.liquidity) : 'none'}</span>
      {s.segment && <span className="t-row">range holds {F.amount(s.segment.amount0, d.token0.decimals)} {d.token0.symbol} + {F.amount(s.segment.amount1, d.token1.decimals)} {d.token1.symbol}</span>}
      {s.current && dist.price != null && <span className="t-row">current price {priceLabel(d, dist.price)}</span>}
    </>,
  }))
  const legend = [
    { label: `${d.token1.symbol} side · below the price`, color: c1 },
    { label: `${d.token0.symbol} side · above the price`, color: c0 },
    { label: 'Both · the band the price sits in', color: bothColor },
  ]
  return (
    <>
      <div className="sec-title">Liquidity distribution
        <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}> · active L per price band{dist.liquidity ? ` · L = ${fmtLiquidity(Number(dist.liquidity))} at the current tick` : ''}
          {vaultRanges.length > 0 && <> · vault {vaultRanges.length === 1 ? 'range' : 'ranges'} {vaultRanges.map(r => `${fmtPrice(r.priceLower)}–${fmtPrice(r.priceUpper)}`).join(', ')}</>}</span>
      </div>
      <div className="pf-card">
        <ChartLegend items={legend} />
        <StackedColumnChart columns={columns} h={200} yFmt={fmtLiquidity} />
      </div>
    </>
  )
}

function PoolCharts({ d }: { d: UniswapV3PoolDetail }) {
  const history = useV3PoolHistory(d.address)
  // The window figures (24H … 12M totals, TVL ago, volume/TVL) from the hourly
  // volume model every pool page reads; the charts keep this pool's own history.
  const week = useV3PoolVolume(d.address).data
  const h = history.data
  if (history.isLoading) return <><div className="sec-title">Price</div><div className="pf-card"><ChartSkeleton h={190} /></div></>
  if (!h || h.points.length < 2) return null
  const buckets = h.points.map(p => p.bucket)
  // The axis gutter fits a number; the pair is named in the section title and the
  // series label, so repeating it per gridline only clipped the labels.
  const priceFmt = (val: number) => fmtPrice(val)
  const priceSeries = [
    { key: 'close', label: `Price (${d.token1.symbol}/${d.token0.symbol})`, color: 'var(--cat-liquidity)', values: h.points.map(p => p.close) },
    { key: 'low', label: 'Low', color: 'color-mix(in srgb, var(--cat-liquidity) 45%, transparent)', values: h.points.map(p => p.low) },
    { key: 'high', label: 'High', color: 'color-mix(in srgb, var(--cat-liquidity) 45%, transparent)', values: h.points.map(p => p.high) },
  ]
  // The vault's ranges are DRAWN, not measured: as constant series they dragged the
  // y-domain across the whole band — a 22 % span — and flattened the price inside it.
  const zones: ChartZone[] = h.vaultRanges
    .slice()
    .sort((a, b) => (b.priceUpper - b.priceLower) - (a.priceUpper - a.priceLower))
    .map((r, i) => ({ from: r.priceLower, to: r.priceUpper, label: i === 0 ? 'vault band' : 'limit range', color: 'var(--lavender-deep)' }))
  // Zoom refetch: the same shapes on the window's finer grain (or its swaps).
  const refineGrid = (pick: (hh: UniswapV3PoolHistory) => { key: string; label: string; color: string; values: (number | null)[] }[]) =>
    async (fromTs: number, toTs: number, points: number) => {
      if (!(toTs > fromTs)) return null
      const w = await api.v3PoolHistoryWindow(d.address, fromTs, toTs, points)
      if (w.points.length < 2) return null
      return { buckets: w.points.map(p => p.bucket), series: pick(w) }
    }
  const priceFrom = (hh: UniswapV3PoolHistory) => [
    { key: 'close', label: priceSeries[0].label, color: priceSeries[0].color, values: hh.points.map(p => p.close) },
    { key: 'low', label: 'Low', color: priceSeries[1].color, values: hh.points.map(p => p.low) },
    { key: 'high', label: 'High', color: priceSeries[2].color, values: hh.points.map(p => p.high) },
  ]
  const usdPoints = (pick: (p: UniswapV3HistoryPointLike) => number | null) => h.points.map(p => ({ b: p.bucket, v: pick(p) }))
  const refineArea = (pick: (p: UniswapV3HistoryPointLike) => number | null) =>
    windowRefine((f, t, n) => api.v3PoolHistoryWindow(d.address, f, t, n), r => r.points.map(p => ({ b: p.bucket, v: pick(p) })))
  const swaps = h.points.reduce((s, p) => s + p.swaps, 0)
  const sub = `${grainLabel(h.grain)} · ${swaps} ${swaps === 1 ? 'swap' : 'swaps'} · drag to zoom`
  const volume = usdPoints(p => p.volumeUsd)
  const tvl = usdPoints(p => p.tvlUsd)
  // Turnover per bucket: the bucket's volume over what the pool held at its end.
  const turnoverOf = (p: UniswapV3HistoryPointLike) => (p.volumeUsd != null && p.tvlUsd != null && p.tvlUsd > 0 ? p.volumeUsd / p.tvlUsd : null)
  const turnover = usdPoints(turnoverOf)
  // Fees are the swap fee on exactly this volume, so their curve is this curve
  // rescaled: the caption names the fee and the LPs' cut of it, not a chart of its own.
  const lpShare = d.protocolFee.sharePct != null ? 1 - d.protocolFee.sharePct / 100 : 1
  // Active liquidity moved into this caption for the same reason: between rebalances
  // it is one flat line, and the distribution above shows where it sits.
  const lastLiquidity = [...h.points].reverse().find(p => p.liquidity != null)?.liquidity ?? null
  // The one thing an LP checks on this chart: is the price still where the vault's
  // liquidity is? Null when the pool has no vault or no price yet.
  const lastClose = [...h.points].reverse().find(p => p.close != null)?.close ?? null
  const inBand = lastClose == null || !h.vaultRanges.length
    ? null
    : h.vaultRanges.some(r => lastClose >= r.priceLower && lastClose <= r.priceUpper)
  return (
    <>
      <div className="sec-title">Price
        <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}> · {d.token1.symbol} per {d.token0.symbol} · {sub}
          {inBand != null && <> · <span style={{ color: inBand ? 'var(--green-deep)' : 'var(--amber)' }}>{inBand ? 'price inside the vault band' : 'price outside the vault band'}</span></>}</span>
      </div>
      <div className="pf-card">
        <ChartLegend items={[{ label: priceSeries[0].label, color: priceSeries[0].color }, { label: 'Low–high in bucket', color: priceSeries[1].color }, ...(zones.length ? [{ label: 'Vault band · liquidity is active inside it', color: 'var(--lavender-deep)' }] : [])]} />
        <MultiLineChart buckets={buckets} series={priceSeries} yFmt={priceFmt} zoomKey="zv3" band={{ lo: 'low', hi: 'high', label: 'Traded range' }}
          zones={zones} markLast h={220} refine={refineGrid(priceFrom)} />
      </div>

      {tvl.some(p => (p.v ?? 0) > 0) && (
        <TvlSection zoomKey="zv3" nowUsd={d.tvlUsd} points={tvl.map(p => ({ b: p.b, v: p.v ?? 0 }))} ago={week?.tvlAgo} refine={refineArea(p => p.tvlUsd)}
          sub={<>what the pool's mints, swaps and collects imply it held, USD at the bucket's prices
            {lastLiquidity != null && <> · L = {fmtLiquidity(Number(lastLiquidity))} active at the last bucket's tick</>}</>} />
      )}

      {volume.some(p => (p.v ?? 0) > 0) && (
        <>
          <div className="sec-title">Volume
            <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}> · {d.feeTier} swap fee
              {d.protocolFee.sharePct != null
                ? <>, {F.share(lpShare)} of it to the LPs</>
                : ', all of it to the LPs'}</span>
          </div>
          <div className="pf-card">
            <PoolVolumeHead allTimeUsd={week?.allTime.volumeUsd ?? d.volume.allUsd ?? 0} kpis={week?.kpis} />
            <AreaChart bars data={volume.map(p => p.v ?? 0)} dates={volume.map(p => p.b)} h={180} color={VOLUME_BAR_COLOR} floor={0} zoomKey="zv3" refine={refineArea(p => p.volumeUsd)} />
          </div>
        </>
      )}

      <VolumeTvlSection zoomKey="zv3" d={week} points={turnover} refine={refineArea(turnoverOf)} />
    </>
  )
}
type UniswapV3HistoryPointLike = UniswapV3PoolHistory['points'][number]

function PoolBody({ d }: { d: UniswapV3PoolDetail }) {
  const now = useNow()
  // The 7-day window and volume/TVL, from the same hourly volume model as every pool page.
  const week = useV3PoolVolume(d.address).data
  // One 24h definition per row: the hourly model's windows (ending at its cut,
  // like every pool page's "through HH:00 UTC"), with the pool history's own
  // head-anchored 24h only while the model has not answered.
  const through = asOfLabel(week?.asOf)
  const colorFor = useAssetColors([d.token0, d.token1])
  const activity = useV3PoolActivity(d.address, 12)
  const activityRows = activity.data ?? []
  const segments: ShareSegment[] = d.tvlUsd != null
    ? d.assets.map((a, i) => ({
        key: `${a.asset.assetId}:${i}`, label: a.asset.symbol, color: colorFor(a.asset), value: a.usd ?? 0,
        tip: <><span className="t-d">{a.asset.symbol}</span><span className="t-row">{F.amount(a.amount, a.asset.decimals)} {a.asset.symbol}</span><span className="t-row">{F.usd(a.usd)}</span></>,
      }))
    : []
  const p10 = d.price.token1PerToken0
  const v = d.vault
  // The pool APR the positions' Liquidity tab shows (7D fees to LPs over the 7D time-weighted TVL,
  // annualised over the pool's age while it is younger than a week) — one source.
  const apr = useYields().data?.uniswapV3?.[d.address.toLowerCase()]?.totalAprPct ?? null
  // A vault depositor earns the LP fee less the vault's own cut, compounded by the
  // vault (hundreds of times so far), so its yield is an APY: daily compounding is
  // within a rounding of the vault's actual cadence.
  const vaultApy = apr != null && v?.feeDivisor ? (Math.pow(1 + apr / 100 * (1 - 1 / v.feeDivisor) / 365, 365) - 1) * 100 : null

  return (
    <>
      <div className="detail-card"><div className="dl">
        <div className="dt">Venue</div><div className="dd">Uniswap v3 <span className="muted">· concentrated liquidity · {d.feeTier} fee tier</span></div>
        <div className="dt">Pool contract</div><div className="dd"><AddrPill account={d.account} /></div>
        <div className="dt">Pair</div><div className="dd"><AssetChip asset={d.token0} /> <span className="muted">/</span> <AssetChip asset={d.token1} /></div>
        <div className="dt">TVL</div><div className="dd mono">{d.tvlUsd != null ? <Usd v={d.tvlUsd} /> : <Dash />}</div>
        <div className="dt">Price</div>
        <div className="dd mono">{p10 != null
          ? <>{priceLabel(d, p10)}{d.price.token0PerToken1 != null && <span className="muted" style={{ marginLeft: 8 }}>({fmtPrice(d.price.token0PerToken1)} {d.token0.symbol}/{d.token1.symbol})</span>}</>
          : <Dash />}</div>
        <div className="dt">Tick</div><div className="dd mono">{d.price.tick != null ? F.int(d.price.tick) : <Dash />} <span className="muted">· spacing {d.tickSpacing}</span></div>
        {/* L is a raw uint128 — 20-30 digits, which overflows the card on a
            phone. Compacted like every other L on this page; the exact integer
            stays one hover away. */}
        <div className="dt">In-range liquidity</div><div className="dd mono">{d.liquidity ? <span title={d.liquidity}>L = {fmtLiquidity(Number(d.liquidity))}</span> : <span className="muted">not initialised</span>}</div>
        <div className="dt">Protocol fee</div>
        <div className="dd mono">{d.protocolFee.sharePct != null
          ? <>{d.protocolFee.sharePct.toLocaleString('en-US', { maximumFractionDigits: 2 })}% <span className="muted">of every swap fee, collected by the factory owner</span></>
          : <span className="muted">off — every swap fee goes to the LPs</span>}</div>
        <div className="dt">Volume</div>
        <div className="dd mono">{week
          ? <><Usd v={week.kpis.d1.volumeUsd} /> <span className="muted">24H{through && <> · through {through}</>}</span>
            <span style={{ marginLeft: 12 }}><Usd v={week.kpis.d7.volumeUsd} /> <span className="muted">7D</span></span></>
          : <>{d.volume.dayUsd != null ? <Usd v={d.volume.dayUsd} /> : '—'} <span className="muted">24H</span></>}
          <span style={{ marginLeft: 12 }}>{d.volume.allUsd != null ? <Usd v={d.volume.allUsd} /> : '—'} <span className="muted">all time · {F.int(d.swaps)} {d.swaps === 1 ? 'swap' : 'swaps'}</span></span>
        </div>
        {week && <>
          <div className="dt">Volume / TVL</div>
          <div className="dd mono">{fmtVolumeTvl(week.volumeTvl.d1)} <span className="muted">24H</span>
            <span style={{ marginLeft: 12 }}>{fmtVolumeTvl(week.volumeTvl.d7)} <span className="muted">7D</span></span>
          </div>
        </>}
        <div className="dt">APR</div>
        <div className="dd"><PoolApr family="uniswapV3" poolKey={d.address} label={d.name} /> <span className="muted">· 7D fees to LPs over the 7D time-weighted TVL, annualised</span></div>
        <div className="dt">Fees to LPs</div>
        <div className="dd mono">{week
          ? <><Usd v={week.fees.d1.lpUsd} /> <span className="muted">24H</span>
            <span style={{ marginLeft: 12 }}><Usd v={week.fees.d7.lpUsd} /> <span className="muted">7D</span></span></>
          : <>{d.volume.feesDayUsd != null ? <Usd v={d.volume.feesDayUsd} /> : '—'} <span className="muted">24H</span></>}
          <span style={{ marginLeft: 12 }}>{d.volume.feesAllUsd != null ? <Usd v={d.volume.feesAllUsd} /> : '—'} <span className="muted">all time · {d.feesCollected.usd != null ? <><Usd v={d.feesCollected.usd} /> collected</> : 'nothing collected yet'}</span></span>
        </div>
        {d.lastSwapAt && <>
          <div className="dt">Last swap</div>
          <div className="dd mono">{d.lastSwapBlock != null ? <Link to={paths.block(d.lastSwapBlock)} className="hash"><Ago ts={d.lastSwapAt} now={now} /></Link> : <Ago ts={d.lastSwapAt} now={now} />}</div>
        </>}
        <div className="dt">Created</div>
        <div className="dd mono"><Link to={paths.block(d.createdBlock)} className="hash"><Ago ts={d.createdAt} now={now} /></Link> <span className="muted">· factory {d.factory.slice(0, 10)}…</span></div>
      </div></div>

      <div className="sec-title">Composition
        <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}> · what the pool's mints, swaps and collects imply it holds</span>
      </div>
      <div className="pf-card">
        {segments.length > 0 && <ShareBar segments={segments} h={30} />}
        <div className="panel" style={{ marginTop: segments.length ? 14 : 0 }}><table className="tbl">
          <thead><tr><th>Asset</th><th className="r">Balance</th><th className="r">Value</th><th className="r">Share</th></tr></thead>
          <tbody>
            {d.assets.map((a, i) => (
              <tr key={`${a.asset.assetId}:${i}`} {...rowNav(paths.asset(a.asset.assetId))}>
                <td data-label="Asset"><AssetChip asset={a.asset} /></td>
                <td data-label="Balance" className="r"><AssetAmount asset={a.asset} raw={a.amount} /></td>
                <td data-label="Value" className="r mono">{a.usd != null ? <Usd v={a.usd} /> : <Dash />}</td>
                <td data-label="Share" className="r mono muted">{a.sharePct != null ? `${a.sharePct.toFixed(1)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>

      <LiquidityDistribution d={d} />
      <PoolCharts d={d} />

      {v && (
        <>
          <div className="sec-title">Vault
            <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}> · a Gamma Strategies Hypervisor manages a base and a limit range for its depositors</span>
          </div>
          <div className="detail-card"><div className="dl">
            <div className="dt">Vault contract</div><div className="dd"><AddrPill account={v.account} /></div>
            <div className="dt">Holdings</div>
            <div className="dd"><span className="asset-flow"><span className="trade-leg"><AssetAmount asset={d.token0} raw={v.total0} link={false} /></span> + <span className="trade-leg"><AssetAmount asset={d.token1} raw={v.total1} link={false} /></span></span>
              <span className="mono muted" style={{ marginLeft: 8 }}>{v.tvlUsd != null ? <Usd v={v.tvlUsd} /> : ''}</span></div>
            <div className="dt">Shares</div><div className="dd mono"><Amt raw={v.shares} dec={18} /> <span className="muted">· {F.int(v.depositors)} {v.depositors === 1 ? 'depositor' : 'depositors'} · {F.int(v.deposits)} deposits · {F.int(v.withdrawals)} withdrawals</span></div>
            <div className="dt">Fees earned</div>
            <div className="dd"><span className="asset-flow"><span className="trade-leg"><AssetAmount asset={d.token0} raw={v.fees0} link={false} /></span> + <span className="trade-leg"><AssetAmount asset={d.token1} raw={v.fees1} link={false} /></span></span>
              <span className="mono muted" style={{ marginLeft: 8 }}>{v.feesUsd != null ? <Usd v={v.feesUsd} /> : ''}</span></div>
            {vaultApy != null && <>
              <div className="dt">Depositor APY</div>
              <div className="dd mono">{vaultApy.toFixed(1)}% <span className="muted">· the pool APR less the vault fee, compounded</span></div>
            </>}
            <div className="dt">Vault fee</div>
            <div className="dd mono">{v.feeSharePct != null ? <>{v.feeDivisor ? `1/${v.feeDivisor} · ` : ''}{v.feeSharePct.toLocaleString('en-US', { maximumFractionDigits: 2 })}% of earned fees</> : <Dash />} <span className="muted">· the vault's own cut, paid to the Treasury on every compound — separate from the pool's protocol fee</span></div>
            <div className="dt">Rebalances</div>
            <div className="dd mono">{F.int(v.rebalances)}{v.lastRebalanceAt && v.lastRebalanceBlock != null && <span className="muted" style={{ marginLeft: 8 }}>· last <Link to={paths.block(v.lastRebalanceBlock)} className="hash"><Ago ts={v.lastRebalanceAt} now={now} /></Link></span>}</div>
            {v.compounds != null && <>
              <div className="dt">Compounds</div>
              <div className="dd mono">{F.int(v.compounds)}{v.lastCompoundAt && v.lastCompoundBlock != null && <span className="muted" style={{ marginLeft: 8 }}>· last <Link to={paths.block(v.lastCompoundBlock)} className="hash"><Ago ts={v.lastCompoundAt} now={now} /></Link></span>}</div>
            </>}
            {v.ranges.map((r, i) => (
              <div key={`${r.tickLower}:${r.tickUpper}`} style={{ display: 'contents' }}>
                <div className="dt">{i === 0 ? 'Ranges' : ''}</div>
                <div className="dd"><RangeCell d={d} lower={r.priceLower} upper={r.priceUpper} inRange={r.inRange} /> <span className="mono muted" style={{ marginLeft: 8 }} title={r.liquidity}>L = {fmtLiquidity(Number(r.liquidity))}</span></div>
              </div>
            ))}
          </div></div>
        </>
      )}

      <div className="sec-title">Positions
        <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}> · opened through the position manager, with what is left in them</span>
      </div>
      <div className="panel"><table className="tbl">
        <thead><tr><th>Position</th><th>Owner</th><th>Range</th><th className="r">Holdings</th><th className="r">Value</th><th className="r">Opened</th></tr></thead>
        <tbody>
          {d.positions.length ? d.positions.map(p => <PositionRow key={`${p.manager}:${p.tokenId}`} d={d} p={p} now={now} />) : <EmptyRow cols={6}>No positions opened through the manager{v ? ' — liquidity here is the vault’s' : ''}</EmptyRow>}
        </tbody>
      </table></div>

      <div className="sec-title">Activity</div>
      {activityRows.length || activity.isLoading
        ? <ActivityTable rows={activityRows} now={now} loading={activity.isLoading && !activityRows.length} pageSize={12} error={activity.error} onRetry={() => { void activity.refetch() }} />
        : <div className="panel"><table className="tbl"><tbody><EmptyRow cols={5}>No activity yet</EmptyRow></tbody></table></div>}
    </>
  )
}

export function UniswapV3Pool({ address }: { address: string }) {
  const { data, isLoading, isError } = useV3Pool(address)
  useDocumentTitle(data ? `${data.name} pool` : undefined)
  const short = `${address.slice(0, 8)}…${address.slice(-4)}`
  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Liquidity', to: paths.liquidity() }, { label: data?.name ?? short }]} />
        <div className="detail-header">
          <div className="page-title">
            {data && <span className="icon-stack">
              <AssetIcon assetId={data.token0.assetId} iconAssetId={data.token0.iconAssetId} iconAssetIds={data.token0.iconAssetIds} symbol={data.token0.symbol} size={30} parachainId={data.token0.parachainId} origin={data.token0.origin} />
              <AssetIcon assetId={data.token1.assetId} iconAssetId={data.token1.iconAssetId} iconAssetIds={data.token1.iconAssetIds} symbol={data.token1.symbol} size={30} parachainId={data.token1.parachainId} origin={data.token1.origin} />
            </span>}
            {' '}{data?.name ?? short}
            <span className="sub muted" style={{ marginLeft: 8 }}><PoolBadge pool="Uniswap v3" /></span>
          </div>
        </div>
      </div>
      {isError
        ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Pool not found</div>
        : isLoading || !data
          ? <><div className="detail-card"><ChartSkeleton h={120} /></div><div className="pf-card" style={{ marginTop: 14 }}><ChartSkeleton h={220} /></div></>
          : <PoolBody d={data} />}
    </div>
  )
}
