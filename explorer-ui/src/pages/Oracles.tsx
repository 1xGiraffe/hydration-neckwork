import { useMemo, useState, type ReactNode } from 'react'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useNow } from '../hooks/useNow'
import { Link, paths, setQuery, useQueryValue } from '../router'
import { AddrPill, ChartSkeleton, Crumbs, EmptyRow, F, LoadError, Pager, rowNav, TableSkeleton } from '../components/ui'
import { DashboardSectionTitle as SecTitle } from '../components/DashboardPrimitives'
import {
  Age, AssetMini, ConsumerList, DeviationCell, Dur, FeedValue, isUsdPair, KIND_LABEL, MiniBars, SourceCell, sourceHref, StatusDot, ageNow,
} from '../components/OracleParts'
import { useOraclesOverview, type EmaSourceRow, type OracleChange, type OracleFeedRow, type OraclesOverview } from '../api/oracles'
import { fmtDuration } from '../utils/dca'

// /oracles — which prices Hydration takes from outside or from its own oracles,
// who delivers them, whether they are fresh, and whether they agree with the
// market. Grouped by what CONSUMES a price (a money-market reserve, a stableswap
// peg), because that is what a price is for; each feed's delivery mechanics are
// one click away on /oracle/:feed. Every figure is the API's (oracleService.ts):
// the live read is one pinned block every five minutes, the histories are the
// chain's own logs and EmaOracle events.

const MARKET_LABEL = (key: string, label: string) => (key === 'core' ? 'Core' : label)

function Card({ k, v, s }: { k: string; v: ReactNode; s?: ReactNode }) {
  return (
    <div className="hdx-card">
      <div className="hk">{k}</div>
      <div className="hv">{v}</div>
      {s && <div className="hs">{s}</div>}
    </div>
  )
}

/** The feed list shows what is live or read by something; the rest folds behind one line. */
export function splitFeeds(feeds: OracleFeedRow[]): { shown: OracleFeedRow[]; folded: OracleFeedRow[] } {
  const shown: OracleFeedRow[] = [], folded: OracleFeedRow[] = []
  for (const f of feeds) (f.status === 'live' || (f.status === 'stale' && f.consumers.length > 0) ? shown : folded).push(f)
  return { shown, folded }
}

function MarketsSection({ d, now }: { d: OraclesOverview; now: number }) {
  const markets = d.markets.filter(m => m.reserves.length > 0)
  const picked = useQueryValue('market', 'core')
  const market = markets.find(m => m.key === picked) ?? markets[0]
  return (
    <>
      <SecTitle title="Money market prices" subtitle="what each market's AaveOracle prices its reserves at, against the explorer's market price" />
      {markets.length > 1 && (
        <div className="liq-filter">
          <div className="seg-bar" role="group" aria-label="Market">
            {markets.map(m => (
              <button key={m.key} type="button" aria-pressed={market?.key === m.key} className={`seg-btn${market?.key === m.key ? ' active' : ''}`}
                onClick={() => setQuery({ market: m.key === 'core' ? null : m.key })}>{MARKET_LABEL(m.key, m.label)}</button>
            ))}
          </div>
        </div>
      )}
      <div className="panel">
        <table className="tbl orc-tbl">
          <thead><tr><th>Asset</th><th className="r">Oracle price</th><th className="r">Market price</th><th className="r">Deviation</th><th>Source</th><th className="r">Updated</th></tr></thead>
          <tbody>
            {!market ? <EmptyRow cols={6}>The live oracle read is not available yet</EmptyRow> : market.reserves.map(r => (
              <tr key={r.reserve}>
                <td data-label="Asset"><Link to={paths.asset(r.asset.assetId)} className="orc-asset-link"><AssetMini asset={r.asset} size={20} /></Link></td>
                <td data-label="Oracle price" className="r mono"><FeedValue value={r.oraclePrice} usd /></td>
                <td data-label="Market price" className="r mono" title={r.marketNote ?? undefined}>{r.marketPrice != null ? <FeedValue value={String(r.marketPrice)} usd /> : <span className="mono muted">{r.marketNote?.startsWith('No venue') ? 'oracle only' : '—'}</span>}</td>
                <td data-label="Deviation" className="r mono"><DeviationCell pct={r.deviationPct} /></td>
                <td data-label="Source"><SourceCell s={r.source} /></td>
                <td data-label="Updated" className="r mono orc-updated" title={r.source.note ?? undefined}>
                  <StatusDot status={r.source.status} />
                  {r.source.kind === 'fixed' && r.source.status === 'fixed' ? <span className="muted">constant</span>
                    : r.source.status === 'static' ? <span className="muted">never</span>
                      : r.source.updatedAt ? <Age sec={ageNow(r.source.ageSec, d.asOf.now, now)} at={r.source.updatedAt} /> : <span className="muted">on call</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {market && (
        <div className="orc-sub muted">
          AaveOracle <Link to={paths.account(market.oracle ?? '')} className="hash">{F.shortAddr(market.oracle)}</Link>
          {market.fallbackOracle ? <> · fallback <Link to={paths.account(market.fallbackOracle)} className="hash">{F.shortAddr(market.fallbackOracle)}</Link></> : ' · no fallback oracle'}
          {d.asOf.liveBlock != null && <> · read at block <Link to={paths.block(d.asOf.liveBlock)} className="hash">{F.int(d.asOf.liveBlock)}</Link></>}
        </div>
      )}
    </>
  )
}

function PegsSection({ d, now }: { d: OraclesOverview; now: number }) {
  if (!d.pegs.length) return null
  return (
    <>
      <SecTitle title="Stableswap pegs" subtitle="pools whose peg multiplier is read from an oracle" />
      <div className="panel">
        <table className="tbl orc-tbl">
          <thead><tr><th>Pool</th><th>Pegged asset</th><th className="r">Peg now</th><th>Source</th><th className="r">Source value</th><th className="r">Updated</th></tr></thead>
          <tbody>
            {d.pegs.map(p => (
              <tr key={`${p.pool.assetId}:${p.asset.assetId}`} {...rowNav(paths.pool(p.pool.assetId))}>
                <td data-label="Pool"><span className="orc-pool">{p.poolAssets.slice(0, 3).map(a => <AssetMini key={a.assetId} asset={a} size={16} />)}<span className="muted">{p.pool.symbol}</span></span></td>
                <td data-label="Pegged asset"><AssetMini asset={p.asset} /></td>
                <td data-label="Peg now" className="r mono"><FeedValue value={p.peg} usd={false} /></td>
                <td data-label="Source"><SourceCell s={p.source} /></td>
                <td data-label="Source value" className="r mono"><FeedValue value={p.source.value} usd={isUsdPair(p.source.label)} /></td>
                <td data-label="Updated" className="r mono orc-updated" title={p.source.note ?? undefined}>
                  <StatusDot status={p.source.status} />
                  {p.source.status === 'static' ? <span className="muted">never</span> : p.source.updatedAt ? <Age sec={ageNow(p.source.ageSec, d.asOf.now, now)} at={p.source.updatedAt} /> : <span className="muted">on call</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function FeedRowView({ f, builtAt, now }: { f: OracleFeedRow; builtAt: string; now: number }) {
  const usd = isUsdPair(f.pair)
  return (
    <tr {...rowNav(paths.oracle(f.feedId))} className={`clickable${f.status === 'stale' ? ' orc-stale' : ''}`}>
      <td data-label="Feed">
        <span className="orc-feed">
          <StatusDot status={f.status} />
          <span className="orc-feed-name">
            <Link to={paths.oracle(f.feedId)} className="hash">{f.pair}</Link>
            <span className="muted mono orc-feed-addr">{F.shortAddr(f.contract)}</span>
          </span>
        </span>
      </td>
      <td data-label="Provider" className="mono">{f.provider}</td>
      <td data-label="Latest" className="r mono"><FeedValue value={f.latestValue} usd={usd} /></td>
      <td data-label="Updated" className="r mono">{f.status === 'static' ? <span className="muted">once, {f.updatedAt?.slice(0, 10)}</span> : <Age sec={ageNow(f.ageSec, builtAt, now)} at={f.updatedAt} />}</td>
      <td data-label="24H" className="r mono">{F.int(f.cadence.updates24h)}</td>
      <td data-label="Median interval" className="r mono"><Dur sec={f.cadence.medianIntervalSec} /></td>
      <td data-label="Longest gap" className="r mono"><Dur sec={f.cadence.longestGapSec} /></td>
      <td data-label="Pusher">{f.pushers[0] ? <AddrPill account={f.pushers[0].account} noCopy /> : <span className="mono muted">{f.provider === 'XCM / scheduled call' ? 'runtime' : '—'}</span>}</td>
      <td data-label="Used by"><ConsumerList consumers={f.consumers} /></td>
    </tr>
  )
}

function FeedsSection({ d, now }: { d: OraclesOverview; now: number }) {
  const [showFolded, setShowFolded] = useState(false)
  const { shown, folded } = useMemo(() => splitFeeds(d.feeds), [d.feeds])
  const rows = showFolded ? [...shown, ...folded] : shown
  return (
    <>
      <SecTitle title="Push feeds" subtitle="every price delivered to Hydration by a transaction: DIA keys and Chainlink-style aggregators" />
      <div className="panel">
        <table className="tbl orc-tbl orc-feeds-tbl">
          <thead><tr>
            <th>Feed</th><th>Provider</th><th className="r">Latest</th><th className="r">Updated</th><th className="r">24H</th>
            <th className="r" title="Median interval between updates over the feed's last 30 days of updates">Median interval</th>
            <th className="r" title="Longest interval between two updates over the same 30 days">Longest gap</th>
            <th>Pusher</th><th>Used by</th>
          </tr></thead>
          <tbody>
            {!rows.length ? <EmptyRow cols={9}>No feed has published yet</EmptyRow> : rows.map(f => <FeedRowView key={f.feedId} f={f} builtAt={d.asOf.now} now={now} />)}
          </tbody>
        </table>
      </div>
      {folded.length > 0 && (
        <div className="liq-dust">
          <span>{folded.length} retired, never-updated or unused feeds</span>
          <button type="button" className="liq-dust-toggle" onClick={() => setShowFolded(v => !v)} aria-expanded={showFolded}>{showFolded ? 'hide them' : 'show them'}</button>
        </div>
      )}
    </>
  )
}

function EmaSourceRows({ s, days, open, onToggle, builtAt, now }: { s: EmaSourceRow; days: number; open: boolean; onToggle: () => void; builtAt: string; now: number }) {
  return (
    <>
      <tr className="clickable" role="button" onClick={onToggle} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }} aria-expanded={open}>
        <td data-label="Source"><span className="orc-feed"><span className="orc-caret mono">{open ? '▾' : '▸'}</span><span className="orc-ema-name">{s.label}</span></span></td>
        <td data-label="Updates 24H" className="r mono">{F.int(s.updates24h)}</td>
        <td data-label="Pairs updated 24H" className="r mono">{F.int(s.pairs24h)} <span className="muted">of {F.int(s.pairs)}</span></td>
        <td data-label="Newest" className="r mono"><Age sec={ageNow(s.newestAgeSec, builtAt, now)} at={s.newestAt} /></td>
        <td data-label={`Daily · ${days}D`} className="r orc-bars-cell"><MiniBars data={s.daily.slice(-days)} /></td>
      </tr>
      {open && (
        <tr className="orc-pairs-row">
          <td colSpan={5}>
            <table className="tbl orc-pairs-tbl">
              <thead><tr><th>Pair</th><th className="r">Price (Short)</th><th className="r">Updated</th><th className="r">Updates 24H</th><th>Used by</th></tr></thead>
              <tbody>
                {s.pairRows.map(p => (
                  <tr key={p.feedId} {...rowNav(paths.oracle(p.feedId))}>
                    <td data-label="Pair"><span className="orc-pool"><AssetMini asset={p.assetB} size={16} /><span className="muted">/</span><AssetMini asset={p.assetA} size={16} /></span></td>
                    <td data-label="Price (Short)" className="r mono">{p.price != null ? <>1 {p.assetB.symbol} = <FeedValue value={p.price} usd={false} /> {p.assetA.symbol}</> : '—'}</td>
                    <td data-label="Updated" className="r mono"><Age sec={ageNow(p.ageSec, builtAt, now)} at={p.updatedAt} /></td>
                    <td data-label="Updates 24H" className="r mono">{F.int(p.updates24h)}</td>
                    <td data-label="Used by"><ConsumerList consumers={p.consumers} empty="—" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  )
}

function EmaSection({ d, now }: { d: OraclesOverview; now: number }) {
  const [days, setDays] = useState<7 | 30>(30)
  const [open, setOpen] = useState<string | null>(null)
  const covered = d.history.emaCoveredFrom
  return (
    <>
      <div className="sec-title-row">
        <SecTitle title="On-chain EMA oracle" subtitle="EmaOracle updates per source — the venues' own prices, and Bifrost's vDOT rate pushed over XCM" />
        <div className="tabs" role="tablist" aria-label="Daily bars">
          {([7, 30] as const).map(n => <button key={n} role="tab" aria-selected={days === n} className={days === n ? 'tab active' : 'tab'} onClick={() => setDays(n)}>{n}D</button>)}
        </div>
      </div>
      <div className="panel">
        <table className="tbl orc-tbl orc-ema-tbl">
          <thead><tr><th>Source</th><th className="r">Updates 24H</th><th className="r">Pairs updated 24H</th><th className="r">Newest</th><th className="r">Daily · {days}D</th></tr></thead>
          <tbody>
            {!d.ema.length ? <EmptyRow cols={5}>{d.history.emaComplete ? 'No EMA updates in the window' : 'Loading the EMA history…'}</EmptyRow>
              : d.ema.map(s => <EmaSourceRows key={s.source} s={s} days={days} open={open === s.source} onToggle={() => setOpen(o => (o === s.source ? null : s.source))} builtAt={d.asOf.now} now={now} />)}
          </tbody>
        </table>
      </div>
      {!d.history.emaComplete && covered && <div className="orc-sub muted">History still loading: counts cover {covered.slice(0, 16).replace('T', ' ')} UTC onwards.</div>}
    </>
  )
}

const CHANGES_PER_PAGE = 12

function ChangeTarget({ c }: { c: OracleChange }) {
  if (c.kind === 'dia-updater') return <span className="orc-pool"><span className="muted">DIA</span><Link to={paths.account(c.contract)} className="hash">{F.shortAddr(c.contract)}</Link></span>
  if (c.kind === 'peg-source') return <span className="orc-pool"><Link to={paths.pool(c.pool.assetId)} className="hash">{c.pool.symbol}</Link><span className="muted">peg</span><AssetMini asset={c.asset} size={16} /></span>
  return <span className="orc-pool"><span className="muted">{c.marketLabel ? MARKET_LABEL(c.market ?? '', c.marketLabel) : 'Oracle'}</span>{c.asset ? <AssetMini asset={c.asset} size={16} /> : <span className="hash">{F.shortAddr(c.assetAddress)}</span>}</span>
}
function LinkLabel({ l }: { l: { address: string; label: string; feedId: string | null } | null }) {
  if (!l) return <span className="muted">—</span>
  const to = sourceHref(l)
  // Two feeds can share a label (a PRIME/USD replaced by another PRIME/USD), so the contract rides beside it.
  const addr = /^0x[0-9a-f]{40}$/.test(l.address) && !l.label.startsWith('0x') ? <span className="muted mono orc-feed-addr"> {F.shortAddr(l.address)}</span> : null
  return <span>{to ? <Link to={to} className="hash">{l.label}</Link> : <span>{l.label}</span>}{addr}</span>
}

function ChangesSection({ d, now }: { d: OraclesOverview; now: number }) {
  const [page, setPage] = useState(0)
  const rows = d.changes.slice(page * CHANGES_PER_PAGE, (page + 1) * CHANGES_PER_PAGE)
  return (
    <>
      <SecTitle title="Source changes" subtitle="every AaveOracle source set, stableswap peg source change and DIA updater change, newest first" />
      <div className="panel">
        <table className="tbl orc-tbl">
          <thead><tr><th>When</th><th>What</th><th>From</th><th>To</th><th className="r">Block</th></tr></thead>
          <tbody>
            {!rows.length ? <EmptyRow cols={5}>No source changes</EmptyRow> : rows.map((c, i) => (
              <tr key={`${c.kind}:${c.blockHeight}:${i}`}>
                <td data-label="When" className="mono"><span title={F.datetime(c.timestamp)}>{F.ago(c.timestamp, now)}</span></td>
                <td data-label="What"><ChangeTarget c={c} /></td>
                <td data-label="From">{c.kind === 'dia-updater' ? <span className="muted">—</span> : <LinkLabel l={c.from} />}</td>
                <td data-label="To">{c.kind === 'dia-updater' ? <AddrPill account={c.to} noCopy /> : <LinkLabel l={c.to} />}</td>
                <td data-label="Block" className="r mono">
                  <Link to={'extrinsicIndex' in c && c.extrinsicIndex != null ? paths.extrinsic(`${c.blockHeight}-${c.extrinsicIndex}`) : paths.block(c.blockHeight)} className="hash">{F.int(c.blockHeight)}</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.changes.length > CHANGES_PER_PAGE && <Pager page={page} totalPages={Math.ceil(d.changes.length / CHANGES_PER_PAGE)} onPage={setPage} />}
    </>
  )
}

export function Oracles() {
  useDocumentTitle('Oracles')
  const { data: d, isError, refetch } = useOraclesOverview()
  const now = useNow(15_000)
  const k = d?.kpis
  const staleNames = k?.stale.filter(s => s.consumed).map(s => s.pair) ?? []
  const dev = k?.largestDeviation
  const diaUpdates = d?.feeds.filter(f => f.kind === 'dia').reduce((s, f) => s + f.cadence.updates24h, 0) ?? 0

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Oracles' }]} />
        <div className="page-title">Oracles <span className="sub">
          {k ? `${F.int(k.liveFeeds)} feeds live · ${F.int(k.staleFeeds)} stale in use · ${F.int(k.updates24h)} updates in the last 24H` : 'the prices Hydration reads, who delivers them, and how fresh they are'}
        </span></div>
      </div>

      {isError && <LoadError title="Couldn’t load the oracles" onRetry={() => { void refetch() }} />}

      <div className="hdx-cards" style={{ marginTop: 0 }}>
        {d && k ? <>
          <Card k="Live feeds" v={F.int(k.liveFeeds)} s="published inside their own cadence" />
          <Card k="Stale feeds" v={<span style={k.staleFeeds ? { color: 'var(--amber)' } : undefined}>{F.int(k.staleFeeds)}</span>}
            s={<>{staleNames.length ? `read by a market or pool: ${staleNames.join(', ')}` : 'none that a market or pool reads'}{k.staleUnused ? ` · ${k.staleUnused} more nothing reads` : ''}</>} />
          <Card k="Updates · 24H" v={F.int(k.updates24h)} s={`${F.int(diaUpdates)} DIA · ${F.int(k.updates24h - diaUpdates)} push feed`} />
          <Card k="Largest deviation" v={dev ? <span style={Math.abs(dev.deviationPct) > 3 ? { color: 'var(--red)' } : Math.abs(dev.deviationPct) > 1 ? { color: 'var(--amber)' } : undefined}>{dev.asset.symbol} {(dev.deviationPct >= 0 ? '+' : '') + dev.deviationPct.toFixed(2)}%</span> : '—'}
            s={dev ? `oracle vs market, ${d.markets.find(m => m.key === dev.market) ? MARKET_LABEL(dev.market, d.markets.find(m => m.key === dev.market)!.label) : dev.market} market` : 'no reserve has both prices'} />
        </> : [0, 1, 2, 3].map(i => <div key={i} className="hdx-card"><ChartSkeleton h={56} /></div>)}
      </div>

      {!d ? <><div style={{ height: 24 }} /><div className="panel"><table className="tbl"><tbody><TableSkeleton cols={6} rows={10} /></tbody></table></div></> : <>
        <MarketsSection d={d} now={now} />
        <PegsSection d={d} now={now} />
        <FeedsSection d={d} now={now} />
        <EmaSection d={d} now={now} />
        <ChangesSection d={d} now={now} />
      </>}

      <div className="liq-foot muted orc-foot">
        <p>
          <strong>Oracle price</strong> is what the market's AaveOracle returns now (getAssetPrice, read with every source at one pinned block every five minutes).
          {' '}<strong>Market price</strong> is the explorer's own price from Hydration's venues; a reserve no venue prices (WBTC) has none, because the explorer values it at this oracle.
        </p>
        <p>
          <strong>DIA adapters</strong> read their key on every call, so their round is the current block and their updatedAt the key's last DIA update — freshness here is that update.
          {' '}<strong>Composite</strong> adapters ({KIND_LABEL.composite.toLowerCase()}: vDOT, GDOT, GETH, 3-Pool, GSOL, HEURC, stHDX) have no rounds; they answer the product of a ratio source and a USD source, re-checked at the read block, and age with their older input.
          {' '}<strong>Computed on call</strong> adapters (uBIL's BIL / USD) answer from inputs they do not name, with the current block as their round: always current, never with a history to judge.
          {' '}The vDOT peg oracle answers Bifrost's EMA rate times a discount feed; its own updatedAt is frozen by design, so its freshness is the Bifrost EMA's XCM pushes.
        </p>
        <p>
          <strong>Stale</strong> means older than the feed's heartbeat + grace: the heartbeat is the longest gap it showed over its last 30 days of updates (24H for a heartbeat feed like USDC/USD), the grace 10 % of it, at least 15 min;
          below three updates it is judged against a 24H heartbeat. <strong>Retired</strong>: no update for {d ? fmtDuration(d.rules.retiredAfterSec) : '30 days'}. <strong>Never updated</strong>: a feed that has published fewer than three values in its life — set by hand, not streamed.
          {' '}EMA counts cover the last 30 days{d?.history.emaCoveredFrom ? ` (from ${d.history.emaCoveredFrom.slice(0, 10)})` : ''}.
        </p>
      </div>
    </div>
  )
}
