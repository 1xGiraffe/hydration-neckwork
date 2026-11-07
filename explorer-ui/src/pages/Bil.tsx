import { useEffect, type ReactNode } from 'react'
import { useAccountActivity, useActivity, useActivityCount, useBilDashboard } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useNow } from '../hooks/useNow'
import { Link, paths, setQuery, useQueryValue, usePageParam } from '../router'
import { AddrPill, Ago, AssetAmount, AssetChip, ChartSkeleton, Crumbs, EmptyRow, F, LoadError, Pager, TableSkeleton, Usd, compactAmount } from '../components/ui'
import { ActivityTable } from '../components/ActivityTable'
import { BIL_ACTION_FILTERS, CAT } from '../components/activityColors'
import { offeredPages, PAGE_SIZE } from '../utils/activityPaging'
import { ChartLegend, MultiLineChart, ShareBar, StackedColumnChart } from '../components/HdxCharts'
import type { AreaSeries, ShareSegment, StackColumn } from '../components/HdxCharts'
import { ChartTooltipRow as TipRow, DashboardSectionTitle } from '../components/DashboardPrimitives'
import { monthDayLabel as mdLabel } from '../utils/dashboardDates'
import { fmtDuration } from '../utils/dca'
import type { BilDashboard, BilWait } from '../types'
import { BIL_STATUS_LABEL, BIL_STATUS_TONE } from '../components/positions/bilStatus'
import { BilWaitText } from '../components/positions/BilPositions'

// Section titles are the page outline's h2s under its h1.
const SecTitle = (p: { title: string; subtitle?: ReactNode }) => <DashboardSectionTitle {...p} as="h2" />

// Brazilian Invoice Loans: Hydration's HOLLAR strategy (app.hydration.net/strategies/bil-vault).
// A deposit of HOLLAR is lent to a fixed-rate, fixed-term Decentral position financing
// Brazilian invoice receivables, and the depositor holds BIL, whose value (the vault's
// NAV) grows as the positions accrue. The way out is the redemption queue,
// paid FIFO as positions mature, or a sale into the BIL/HOLLAR stableswap pool. The page
// states the vault as the official app does — TVL, capacity, APY, the redemption terms
// (the API's pinned read of the contracts) — then what the indexed history adds: the NAV
// every deposit and settlement executed at, the maturity ladder, the queue and how long
// it really takes, the pool's premium or discount, who holds it and every act.

const APP_URL = 'https://app.hydration.net/strategies/bil-vault'
const NARROW = '(max-width: 720px)'
const ACTIVITY_PAGE = 25
const ACTIVITY_PAGE_NARROW = 10
const HOLDERS_SHOWN = 10
const REQUESTS_SHOWN = 10
// Fewer days than this read as a table, not a chart (as on the Juicer page).
const FLOWS_CHART_MIN_DAYS = 14
const MUTED_SUB = { color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 } as const
const DEPOSIT_COLOR = CAT.bil
const EXIT_COLOR = CAT.bilExit
const CLAIM_COLOR = CAT.bilClaim
const KEEPER_COLOR = CAT.bilKeeper
const YIELD_COLOR = CAT.bilYield
const POOL_COLOR = 'var(--cat-liquidity)'
const STATED_COLOR = CAT.bilYield
const BORROW_COLOR = 'var(--cat-borrow)'
/** The processing the app states after maturity, before the HOLLAR is paid. */
const APP_PROCESSING_HOURS = 48
const WAD = 10n ** 18n
const num = (raw: string | null | undefined, dec = 18): number => raw == null ? 0 : Number(BigInt(raw) * 1_000_000n / 10n ** BigInt(dec)) / 1e6
const wad = (raw: string | null | undefined): number | null => raw == null ? null : Number(BigInt(raw) * 1_000_000_000n / WAD) / 1e9
const pct = (v: number | null | undefined, digits = 2): string => v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}%`
const signed = (v: number | null | undefined, digits = 2): string => v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}%`
const hollarTick = (v: number): string => v === 0 ? '0' : compactAmount(v)
/** A moment to the minute: "Thu 01 Jan 2099 · 18:00 UTC". */
const dt = (iso: string) => F.datetime(iso).replace(/:\d\d UTC$/, ' UTC')
/** A premium (+) or discount (−) to NAV, worded, never coloured as good or bad. */
const premium = (v: number | null | undefined, digits = 3): string => v == null || !Number.isFinite(v) ? '—' : `${signed(v, digits)} ${v >= 0 ? 'premium' : 'discount'}`
/** Round gridlines for a percentage series around 0: a step of 0.05/0.1/0.25/0.5/1… covering the data, 0 included. */
function pctTicks(values: (number | null)[]): number[] {
  const vs = values.filter((v): v is number => v != null && Number.isFinite(v))
  const lo = Math.min(0, ...vs), hi = Math.max(0, ...vs)
  const span = Math.max(hi - lo, 0.05)
  const step = [0.05, 0.1, 0.25, 0.5, 1, 2, 5].find(st => span / st <= 4) ?? 10
  const out: number[] = []
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) out.push(Math.round(v * 1000) / 1000)
  return out
}
/** Every day from the first to the last, inclusive (YYYY-MM-DD). */
function dayGrid(first: string, last: string): string[] {
  const out: string[] = []
  for (let t = Date.parse(first + 'T00:00:00Z'); t <= Date.parse(last + 'T00:00:00Z'); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}
/** A fresh deposit's lockup as the app words it: its term plus up to 48 h of processing. */
const lockupDays = (termDays: number | null): number | null => termDays == null ? null : Math.round(termDays + APP_PROCESSING_HOURS / 24)

function Card({ k, v, s, dot }: { k: string; v: ReactNode; s?: ReactNode; dot?: string }) {
  return (
    <div className="hdx-card">
      <div className="hk">{dot && <i style={{ background: dot }} />}{k}</div>
      <div className="hv">{v}</div>
      {s && <div className="hs">{s}</div>}
    </div>
  )
}
function Hollar({ d, raw }: { d: BilDashboard; raw: string | null | undefined }) {
  return raw == null ? <>—</> : <AssetAmount asset={d.hollarAsset} raw={raw} />
}

const STATUS: Record<BilDashboard['status'], { label: string; tone: string }> = {
  open: { label: 'Open for deposits', tone: 'ok' },
  full: { label: 'Vault is full', tone: 'pending' },
  paused: { label: 'Deposits paused', tone: 'fail' },
  unavailable: { label: 'State unavailable', tone: '' },
}

// 0. what this is — the official app's own explanation, its terms and its caveats
function Intro({ narrow, d }: { narrow: boolean; d: BilDashboard | undefined }) {
  const terms = d?.apyPct != null && d.termDays != null ? <>a fixed <b>{pct(d.apyPct, 0)} APY over {d.termDays}-day terms</b></> : <>a fixed rate over a fixed term</>
  const lockup = lockupDays(d?.termDays ?? null)
  const body = (
    <>
      <p className="ice-lede">
        BIL (Brazilian Invoice Loans) is a yield-bearing token built on <b>Decentral</b>, a fixed-rate lending protocol that finances Brazilian invoice receivables — short-term, real-world trade credit. Lenders fund fixed-term Decentral positions, currently at {terms}; the strategy pools these positions into one liquid token that appreciates against HOLLAR as yield accrues, and reinvests matured positions.
      </p>
      <ol className="juicer-steps bil-steps" aria-label="How Brazilian Invoice Loans works">
        <li>
          <b>Deposit</b>
          <span>Your HOLLAR goes into the BIL vault, which mints vault shares (uBIL) and lends the HOLLAR to a new fixed-rate Decentral position. In the same transaction the shares are supplied to a dedicated BIL money market, so the token you hold is simply BIL.</span>
        </li>
        <li>
          <b>Earn</b>
          <span>Each position accrues its fixed rate until maturity, so BIL’s exchange rate against HOLLAR (its NAV) rises every block. Matured positions pay their interest and principal back to the vault, which reinvests them or pays the redemption queue.</span>
        </li>
        <li>
          <b>Withdraw</b>
          <span>Request a redemption: your uBIL enters the queue and keeps earning until it is settled, FIFO, as positions mature. Settlement locks the HOLLAR it is owed at that moment’s rate; the uBIL is burned when you (or auto-claim) claim it. The unsettled part can be cancelled. Or swap BIL for HOLLAR instantly in the BIL/HOLLAR pool, at its price.</span>
        </li>
      </ol>
      <p className="juicer-risk">
        BIL returns come from the underlying invoice receivables and depend on their repayment: the Decentral borrower draws the pool’s HOLLAR to finance them and repays it as they are paid, so a default or late repayment lowers or delays what the vault receives. A redemption through the queue can take {lockup != null ? <>about {lockup} days</> : 'a full term'} — {d?.termDays != null ? `the ${d.termDays}-day term` : 'the term'} of the position that covers it plus up to {APP_PROCESSING_HOURS} hours of processing; the pool is faster, subject to its liquidity and price impact. BIL can also back a HOLLAR loan in its money market; a looped position is liquidated if its LTV reaches the threshold.
      </p>
      <details className="ice-gloss">
        <summary>Terms on this page</summary>
        <dl>
          <dt>NAV · exchange rate</dt><dd>HOLLAR per uBIL (= per BIL): the vault’s assets — principal at work, interest accrued, idle HOLLAR — over its active shares. BIL and uBIL are valued at it everywhere on this explorer.</dd>
          <dt>BIL · uBIL</dt><dd>uBIL is the vault share. BIL is the BIL money market’s token for uBIL supplied to it, minted 1:1 — what the app hands depositors, and what can back a HOLLAR loan in that market.</dd>
          <dt>Decentral position</dt><dd>A fixed-term loan to the Decentral pool, held by the vault as an NFT: principal plus fixed simple interest at its own rate, paid back after maturity.</dd>
          <dt>Stated · realized APY</dt><dd>Stated is the vault’s fixed rate. Realized is how fast the NAV actually grew, annualised simply, from the exact rate deposits and settlements executed at — lower while HOLLAR sits idle or awaits processing.</dd>
          <dt>Maturity ladder</dt><dd>When the open positions mature and what each day pays back. The queue is paid from these payouts in order.</dd>
          <dt>Settle · claim</dt><dd>A settlement locks the HOLLAR queued uBIL is owed at that moment’s rate (it stops earning); a claim pays that HOLLAR out and burns the uBIL. A request settles in parts when one maturity does not cover it.</dd>
          <dt>Processing</dt><dd>Decentral approves each matured position’s withdrawal by hand; the app says up to {APP_PROCESSING_HOURS} hours. This page measures it from the logs.</dd>
          <dt>Pool premium · discount</dt><dd>The BIL/HOLLAR stableswap pool’s price against NAV. Its BIL leg is pegged to the vault rate through the BIL / USD oracle, so it trades near NAV; an imbalance moves it off.</dd>
          <dt>Max LTV · liquidation threshold</dt><dd>How much HOLLAR a BIL deposit in its money market can borrow, and the loan-to-value at which the position is liquidated.</dd>
          <dt>Draw · repayment</dt><dd>The Decentral borrower taking the pool’s HOLLAR to finance receivables, and paying it back.</dd>
        </dl>
      </details>
    </>
  )
  if (narrow) return <details className="ice-gloss juicer-intro"><summary>What BIL is and how it works</summary>{body}</details>
  return body
}

// 1. headline strip
function Ribbon({ d }: { d: BilDashboard }) {
  const nav = wad(d.exchangeRate)
  const cells: { k: string; v: ReactNode; s?: ReactNode }[] = [
    { k: 'TVL', v: <Usd v={d.tvlUsd} />, s: d.tvl != null ? <><span className="mono">{F.amount(d.tvl, d.hollarAsset.decimals)}</span> HOLLAR</> : 'state unavailable' },
    { k: 'APY', v: pct(d.apyPct), s: <>fixed · realized <span style={{ color: 'var(--text-high)' }}>{pct(d.realized.d30Pct)}</span> over the last {d.realized.d30Days ?? '—'} days</> },
    { k: 'NAV', v: nav != null ? <span className="mono">{nav.toFixed(4)}</span> : '—', s: <>HOLLAR per BIL · {d.navUsd != null ? F.priceUsd(d.navUsd) : '—'}</> },
    { k: 'Capacity', v: d.status === 'full' ? 'Full' : d.remaining != null ? <><span className="mono">{F.amount(d.remaining, d.hollarAsset.decimals)}</span> HOLLAR</> : '—', s: d.cap != null ? <>of a <span className="mono">{F.amount(d.cap, d.hollarAsset.decimals)}</span> HOLLAR cap</> : undefined },
    { k: 'Holders', v: d.holders != null ? F.int(d.holders) : '—', s: <>{F.int(d.depositors)} ever deposited</> },
    { k: 'Pool vs NAV', v: premium(d.pool?.premiumVsNavPct, 2), s: d.pool?.mid != null ? <>BIL/HOLLAR mid <span className="mono">{d.pool.mid.toFixed(4)}</span></> : 'pool state unavailable' },
  ]
  return (
    <div className="ribbon standalone">
      {cells.map((c, i) => (
        <span key={c.k} style={{ display: 'contents' }}>
          {i > 0 && <span className="rs" />}
          <span className="cell"><span className="k">{c.k}</span><span className="v">{c.v}</span>{c.s && <span className="s">{c.s}</span>}</span>
        </span>
      ))}
    </div>
  )
}

// 2. the vault — capacity, NAV, where the money is, the terms
function VaultSection({ d }: { d: BilDashboard }) {
  const st = STATUS[d.status]
  const tvl = num(d.tvl), cap = num(d.cap)
  const capSegs: ShareSegment[] = d.tvl != null && d.cap != null ? [
    { key: 'tvl', label: 'Deposited', color: DEPOSIT_COLOR, value: Math.min(tvl, cap), tip: <><span className="t-d">In the vault</span><TipRow label="HOLLAR" value={F.exact(d.tvl, d.hollarAsset.decimals)} /></> },
    { key: 'room', label: 'Room left', color: 'var(--separator)', value: Math.max(0, cap - tvl), tip: <><span className="t-d">Room left</span><TipRow label="HOLLAR" value={F.exact(d.remaining, d.hollarAsset.decimals)} /></> },
  ] : []
  const nav = wad(d.exchangeRate)
  return (
    <>
      <SecTitle title="The vault" subtitle={<>deposit HOLLAR, hold <AssetChip asset={d.bilAsset} /> · <span className={`badge ${st.tone}`}>{st.label}</span></>} />
      <div className="pf-card">
        {capSegs.length > 0 && <>
          <ChartLegend items={[{ label: `In the vault ${F.amount(d.tvl, d.hollarAsset.decimals)} HOLLAR`, color: DEPOSIT_COLOR }, { label: tvl > cap ? `Over the ${F.amount(d.cap, d.hollarAsset.decimals)} cap by accrued interest` : `Room ${F.amount(d.remaining, d.hollarAsset.decimals)} HOLLAR`, color: 'var(--separator)' }]} />
          <ShareBar segments={capSegs} h={18} />
        </>}
        <div className="hdx-cards">
          <Card k="TVL" dot={DEPOSIT_COLOR} v={<Usd v={d.tvlUsd} />} s={<><Hollar d={d} raw={d.tvl} /> — principal at work, interest accrued and idle HOLLAR</>} />
          <Card k="NAV" v={nav != null ? <span className="mono">{nav.toFixed(6)}</span> : '—'} s={<>HOLLAR per BIL (= per uBIL), on {d.sharesOutstanding != null ? <><span className="mono">{F.amount(d.sharesOutstanding, d.ubilAsset.decimals)}</span> uBIL</> : '—'} outstanding</>} />
          <Card k="Stated APY" v={pct(d.apyPct)} s={<>fixed on each position over a {d.termDays ?? '—'}-day Decentral term, simple interest</>} />
          <Card k="Realized APY" v={pct(d.realized.sinceLaunchPct)} s={<>over the {d.realized.launchDays ?? '—'} days since launch · {pct(d.realized.d30Pct)} over the last {d.realized.d30Days ?? '—'} days · {pct(d.realized.d7Pct)} over the last {d.realized.d7Days ?? '—'} days (the nearest exact reading at or before a week ago)</>} />
          <Card k="In Decentral positions" v={<Hollar d={d} raw={d.investedPrincipal} />} s={<>principal; {d.pendingInterest != null && d.pendingInterest !== '0' ? <><Hollar d={d} raw={d.pendingInterest} /> matured interest awaiting payout</> : 'no matured interest awaiting payout'}</>} />
          <Card k="Idle · reserved" v={<Hollar d={d} raw={d.idleHollar} />} s={<>idle; <Hollar d={d} raw={d.reservedHollar} /> reserved for settled redemptions until claimed</>} />
        </div>
        {d.status === 'full' && <div className="hdx-note">The vault is full{d.remainingBinding === 'pool' ? ' (the BIL market’s supply cap binds first)' : ''}: new deposits are not accepted until capacity becomes available, and its assets keep growing past the cap as interest accrues.</div>}
      </div>
    </>
  )
}

// 3. NAV over time — the exact rate each deposit and settlement executed at
function NavSection({ d, narrow }: { d: BilDashboard; narrow: boolean }) {
  const pts = d.rateHistory
  const first = pts[0], last = pts[pts.length - 1]
  // A full daily grid: a day without a deposit or settlement has no exact reading (null).
  const days = first && last ? dayGrid(first.day, last.day) : []
  const byDay = new Map(pts.map(p => [p.day, p.rate]))
  const stated = d.apyPct
  const statedLabel = `Stated ${pct(stated, 0)}, simple, from the first deposit`
  const series: AreaSeries[] = [
    { key: 'nav', label: 'NAV', color: DEPOSIT_COLOR, values: days.map(day => byDay.get(day) ?? null) },
    ...(first && stated != null ? [{ key: 'stated', label: statedLabel, color: STATED_COLOR, dashed: true,
      values: days.map(day => first.rate * (1 + stated / 100 * (Date.parse(day) - Date.parse(first.day)) / (365 * 86_400_000))) }] : []),
  ]
  return (
    <>
      <SecTitle title="NAV" subtitle="HOLLAR per BIL at every deposit and settlement — the vault’s own exchange rate, exact at those moments" />
      <div className="pf-card">
        {pts.length < 2 ? <div className="hdx-note" style={{ marginTop: 0 }}>Not enough observations yet.</div> : <>
          <ChartLegend items={[{ label: 'NAV — the rate a deposit minted or a settlement fixed, the day’s last', color: DEPOSIT_COLOR }, { label: statedLabel, color: STATED_COLOR, dashed: true }]} />
          <MultiLineChart buckets={days} series={series} h={narrow ? 300 : 190} yFmt={v => v.toFixed(4)} refLine={null} markLast />
        </>}
        <div className="hdx-note">A deposit mints at the vault’s rate and a settlement fixes the HOLLAR owed at it, so each is an exact reading of NAV; a day without one has no point (a gap), and the last point is the vault’s live rate. Realized APY compares the live rate with the reading nearest at or before 7 and 30 days ago, and with the first deposit — each with its real span.</div>
      </div>
    </>
  )
}

// 4. the maturity ladder
function LadderSection({ d, narrow }: { d: BilDashboard; narrow: boolean }) {
  const l = d.ladder
  const now = useNow()
  if (!l) {
    return (<><SecTitle title="Maturity ladder" /><div className="pf-card"><div className="hdx-note" style={{ marginTop: 0 }}>{d.asOfBlock == null ? 'The vault’s current state is unavailable right now.' : 'The indexed positions do not match the vault’s invested principal at this block, so the ladder is withheld rather than shown wrong.'}</div></div></>)
  }
  const every = Math.max(1, Math.ceil(l.buckets.length / (narrow ? 5 : 10)))
  const columns: StackColumn[] = l.buckets.map((b, i) => {
    const principal = num(b.principal), payout = num(b.payout)
    return {
      key: b.day, label: i % every === 0 ? mdLabel(b.day) : '',
      segments: [
        { key: 'principal', label: 'Principal', color: KEEPER_COLOR, value: principal },
        { key: 'interest', label: 'Interest', color: YIELD_COLOR, value: Math.max(0, payout - principal) },
      ],
      tip: (
        <>
          <span className="t-d">{mdLabel(b.day)} · {F.int(b.positions)} position{b.positions === 1 ? '' : 's'}</span>
          <TipRow color={KEEPER_COLOR} label="Principal" value={`${F.amount(b.principal, 18)} HOLLAR`} />
          <TipRow color={YIELD_COLOR} label="Interest" value={`${compactAmount(Math.max(0, payout - principal))} HOLLAR`} />
          <TipRow label="Paid out by then" value={`${F.amount(b.cumulative, 18)} HOLLAR`} />
        </>
      ),
    }
  })
  const nextIn = l.next ? (Date.parse(l.next.at) - now) / 1000 : null
  return (
    <>
      <SecTitle title="Maturity ladder" subtitle="the open Decentral positions by the day they mature — what pays the queue, in order" />
      <div className="pf-card">
        <ChartLegend items={[{ label: 'Principal', color: KEEPER_COLOR }, { label: 'Fixed interest', color: YIELD_COLOR }]} />
        <StackedColumnChart columns={columns} h={narrow ? 300 : 180} yFmt={hollarTick} />
        <div className="hdx-cards">
          <Card k="Open positions" v={F.int(l.positions)} s={<>each a {d.termDays ?? '—'}-day fixed-rate loan to the Decentral pool, at its own rate</>} />
          <Card k="Principal" dot={KEEPER_COLOR} v={<Hollar d={d} raw={l.principal} />} s={<><Hollar d={d} raw={l.payout} /> due at maturity with interest</>} />
          <Card k="Next maturity" v={l.next ? dt(l.next.at) : '—'} s={l.next ? <>{nextIn != null && nextIn > 0 ? `in ${fmtDuration(nextIn)}` : 'now'} · <Hollar d={d} raw={l.next.payout} /> that day</> : 'no open position'} />
          <Card k="Last maturity" v={l.buckets.length ? mdLabel(l.buckets[l.buckets.length - 1].day) : '—'} s="the latest a queued redemption waits on today’s positions" />
        </div>
      </div>
    </>
  )
}

// 5. the redemption queue
/** A queued redemption's wait as a card value: a range from now, or its state. */
function waitValue(w: BilWait | null, fromIdle: boolean, covered: boolean, now: number): string {
  if (!covered) return 'beyond the ladder'
  if (fromIdle) return 'next settlement'
  if (!w) return '—'
  if (w.matured) return 'matured, awaiting processing'
  const a = (Date.parse(w.from) - now) / 1000, b = (Date.parse(w.to) - now) / 1000
  return `${fmtDuration(a)} – ${fmtDuration(b)}`
}
/** The request a link names (#bil-request-N), if any. */
const linkedRequest = (): number | null => {
  const m = /^#bil-request-(\d+)$/.exec(typeof window === 'undefined' ? '' : window.location.hash)
  return m ? Number(m[1]) : null
}
function QueueSection({ d }: { d: BilDashboard }) {
  const now = useNow()
  const q = d.queue
  const rpage = useQueryValue('rpage', '')
  if (!q) return (<><SecTitle title="Redemption queue" /><div className="pf-card"><div className="hdx-note" style={{ marginTop: 0 }}>The vault’s current state is unavailable right now.</div></div></>)
  // A linked request opens on its own page; an explicit rpage wins.
  const linked = linkedRequest()
  const linkedIdx = linked != null ? q.requests.findIndex(r => r.requestId === linked) : -1
  const page = rpage !== '' ? Number(rpage) || 0 : linkedIdx >= 0 ? Math.floor(linkedIdx / REQUESTS_SHOWN) : 0
  const pages = Math.max(1, Math.ceil(q.requests.length / REQUESTS_SHOWN))
  const shown = q.requests.slice(page * REQUESTS_SHOWN, (page + 1) * REQUESTS_SHOWN)
  const lockup = lockupDays(d.termDays)
  return (
    <>
      <SecTitle title="Redemption queue" subtitle="FIFO, paid as positions mature · every request, newest first" />
      <div className="pf-card">
        <div className="hdx-cards" style={{ marginTop: 0 }}>
          <Card k="Queued" dot={EXIT_COLOR} v={<AssetAmount asset={d.ubilAsset} raw={q.pendingShares} />} s="uBIL waiting in the queue, still earning" />
          <Card k="Settled, claimable" dot={CLAIM_COLOR} v={<Hollar d={d} raw={q.claimableHollar} />} s="HOLLAR locked at settlement, waiting for a claim" />
          <Card k={`A new ${F.amount(q.quoteHollar, 18)} HOLLAR request`} v={waitValue(q.quoteWait, q.quoteFromIdle, q.quoteCovered, now)}
            s={q.quoteWait && !q.quoteFromIdle ? <>covered by the positions maturing {dt(q.quoteWait.maturesAt)}, behind everything queued{q.quoteWait.matured ? '' : <> · expected {dt(q.quoteWait.from)} – {dt(q.quoteWait.to)}</>}</> : q.quoteFromIdle ? 'idle HOLLAR covers it' : 'more than the open positions pay'} />
          <Card k="Processing after maturity" v={q.processing ? `${q.processing.medianHours} – ${q.processing.p90Hours} h` : '—'} s={q.processing ? <>median to 90th percentile, measured over {F.int(q.processing.samples)} repaid positions · slowest {q.processing.maxHours} h (the app says up to {APP_PROCESSING_HOURS} h)</> : 'no repaid position yet'} />
          <Card k="Lockup of a fresh deposit" v={lockup != null ? `~${lockup} days` : '—'} s={<>its own {d.termDays ?? '—'}-day term plus up to {APP_PROCESSING_HOURS} h of processing, when the queue has nothing else to pay from</>} />
        </div>
        <div className="panel" style={{ marginTop: 12 }}>
          <table className="tbl ice-rank">
            <thead><tr><th>Request</th><th>Owner</th><th className="r">uBIL</th><th className="r">Worth</th><th>State</th></tr></thead>
            <tbody>
              {!shown.length ? <EmptyRow cols={5}>No redemption requests</EmptyRow> : shown.map(r => (
                <tr key={r.requestId} id={`bil-request-${r.requestId}`}>
                  <td data-label="Request" className="mono"><a href={`#bil-request-${r.requestId}`} className="hash">#{r.requestId}</a><div className="muted" style={{ fontSize: 11 }}><Ago ts={r.requestedAt} now={now} /></div></td>
                  <td data-label="Owner"><AddrPill account={r.owner} noCopy /></td>
                  <td data-label="uBIL" className="r mono">
                    <AssetAmount asset={d.ubilAsset} raw={r.shares} />
                    {r.cancelledShares !== '0' && r.settledShares !== '0' && <div className="muted" style={{ fontSize: 11 }}>{F.amount(r.cancelledShares, 18)} cancelled</div>}
                  </td>
                  <td data-label="Worth" className="r mono">
                    {r.status === 'claimed' ? <span className="muted"><Hollar d={d} raw={r.hollarOwed} /> paid</span> : r.status === 'cancelled' ? '—' : <Hollar d={d} raw={r.worthHollar} />}
                  </td>
                  <td data-label="State">
                    <span className={`badge ${BIL_STATUS_TONE[r.status]}`}>{BIL_STATUS_LABEL[r.status]}</span>
                    {r.pendingShares !== '0' && <div><BilWaitText wait={r.wait} fromIdle={r.paidFromIdle} now={now} /></div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pages > 1 && <Pager page={page} totalPages={pages} onPage={p => setQuery({ rpage: String(p) })} />}
        <div className="hdx-note">The queue’s wait is the vault’s own rule: idle HOLLAR first, then each open position’s payout in order until it covers everything queued ahead plus the request. That maturity plus the measured processing (median to 90th percentile) is the window shown; once the maturity has passed the request is awaiting processing. A request keeps earning until it settles; the settled HOLLAR is fixed at that moment’s rate.</div>
      </div>
    </>
  )
}

// 5b. borrowing HOLLAR against BIL — the money market's terms, as the app states them
function BorrowSection({ d }: { d: BilDashboard }) {
  const b = d.borrowing
  if (!b) return null
  const used = b.utilization != null ? b.utilization * 100 : null
  const segs: ShareSegment[] = b.borrowedHollar != null && b.bucketCap != null ? [
    { key: 'borrowed', label: 'Borrowed', color: BORROW_COLOR, value: num(b.borrowedHollar), tip: <><span className="t-d">HOLLAR borrowed against BIL</span><TipRow label="HOLLAR" value={F.exact(b.borrowedHollar, 18)} /></> },
    { key: 'room', label: 'Room left', color: 'var(--separator)', value: Math.max(0, num(b.bucketCap) - num(b.borrowedHollar)), tip: <><span className="t-d">Room under the borrow cap</span></> },
  ] : []
  return (
    <>
      <SecTitle title="Borrowing against BIL" subtitle="HOLLAR loans backed by BIL in its isolated money market, as the app states them" />
      <div className="pf-card">
        {segs.length > 0 && <>
          <ChartLegend items={[{ label: `Borrowed ${F.amount(b.borrowedHollar, 18)} HOLLAR`, color: BORROW_COLOR }, { label: `Borrow cap ${F.amount(b.bucketCap, 18)} HOLLAR`, color: 'var(--separator)' }]} />
          <ShareBar segments={segs} h={14} />
        </>}
        <div className="hdx-cards">
          <Card k="HOLLAR borrowed" dot={BORROW_COLOR} v={<Hollar d={d} raw={b.borrowedHollar} />} s={<>{pct(used, 2)} of the <Hollar d={d} raw={b.bucketCap} /> borrow cap</>} />
          <Card k="Max LTV · liquidation" v={<>{pct(b.maxLtvPct, 0)} · {pct(b.liquidationThresholdPct, 0)}</>} s="borrow up to the max LTV; at the liquidation threshold the position is liquidated" />
          <Card k="Borrow APY" v={pct(b.borrowApyPct)} s="HOLLAR’s variable rate in this market — it floats" />
          <Card k="Max Net APY" v={pct(b.maxNetApyPct)} s={<>looped at max LTV ({b.maxLeverage != null ? `${b.maxLeverage.toFixed(1)}×` : '—'}): {pct(d.apyPct, 0)} on the whole position less the borrow APY on the loan</>} />
        </div>
        <div className="hdx-note">Looping: supply BIL, borrow HOLLAR against it, deposit that HOLLAR for more BIL and repeat — at {pct(b.maxLtvPct, 0)} LTV that is up to {b.maxLeverage != null ? `${b.maxLeverage.toFixed(1)}×` : '—'} the deposit earning the vault’s APY while the loan pays the borrow APY. The leverage cuts both ways: a rising borrow rate can push the net below the vault’s own APY, and a position whose LTV reaches {pct(b.liquidationThresholdPct, 0)} — through accrued interest, or BIL’s price falling in the market — is liquidated. Max Net APY is the app’s figure at today’s rates, not a promise.</div>
      </div>
    </>
  )
}

// 6. the instant way out — the BIL/HOLLAR pool against NAV
function PoolSection({ d, narrow }: { d: BilDashboard; narrow: boolean }) {
  const p = d.pool
  if (!p) return null
  // One series: the mid against NAV (interpolated between NAV's exact readings) — against
  // its peg it reads the same, since the peg relays the vault rate.
  const hist = p.history.filter(h => h.premiumVsNavPct != null)
  const values = hist.map(h => h.premiumVsNavPct)
  const series: AreaSeries[] = [{ key: 'nav', label: 'Mid vs NAV', color: POOL_COLOR, values }]
  const fee = p.feePct
  return (
    <>
      <SecTitle title="BIL/HOLLAR pool" subtitle={<><Link to={paths.pool(p.poolId)}>pool {p.poolId}</Link> — the instant way out, and where it trades against NAV</>} />
      <div className="pf-card">
        <div className="hdx-cards" style={{ marginTop: 0 }}>
          <Card k="Mid vs NAV" dot={POOL_COLOR} v={premium(p.premiumVsNavPct)} s={p.mid != null ? <>mid <span className="mono">{p.mid.toFixed(6)}</span> HOLLAR per BIL · peg <span className="mono">{p.peg?.toFixed(6) ?? '—'}</span></> : '—'} />
          <Card k="Sell 1,000 BIL now" v={p.sellQuote ? <Hollar d={d} raw={p.sellQuote.hollar} /> : '—'} s={p.sellQuote ? <>{p.sellQuote.price.toFixed(6)} per BIL · {premium(p.sellQuote.vsNavPct)} to NAV, the {pct(fee, 2)} fee and price impact included</> : 'no quote'} />
          <Card k="Reserves" v={<><AssetAmount asset={d.bilAsset} raw={p.bilReserve} /></>} s={<>+ <Hollar d={d} raw={p.hollarReserve} /> · amplification {F.int(p.amplification)}</>} />
        </div>
        {hist.length >= 2 && <>
          <ChartLegend items={[{ label: 'Mid vs NAV, daily (above 0: premium, below: discount)', color: POOL_COLOR }, { label: `Within the ${pct(fee, 2)} fee`, color: 'var(--text-low)' }]} />
          <MultiLineChart buckets={hist.map(h => h.day)} series={series} h={narrow ? 260 : 170} yFmt={v => `${v.toFixed(2)}%`}
            refLine={0} refLabel="NAV" yTicks={pctTicks(values)} zones={[{ from: -fee, to: fee }]} markLast />
        </>}
        <div className="hdx-note">The pool’s BIL leg is pegged to the vault rate through the BIL / USD oracle, moved toward it a bounded step per block, so the pool trades near NAV and a sale or purchase pushes it off. NAV on a day without an exact reading is interpolated between the readings around it. Selling at a discount is the cost of not waiting for the queue; buying at a discount and redeeming through the queue earns the gap.</div>
      </div>
    </>
  )
}

// 7. what flowed — per day since launch
function FlowsSection({ d, narrow }: { d: BilDashboard; narrow: boolean }) {
  const rows = d.perDay
  const t = d.totals
  const every = Math.max(1, Math.ceil(rows.length / (narrow ? 5 : 10)))
  const columns: StackColumn[] = rows.map((x, i) => ({
    key: x.day, label: i % every === 0 ? mdLabel(x.day) : '',
    segments: [
      { key: 'deposits', label: 'Deposited', color: DEPOSIT_COLOR, value: num(x.depositsHollar) },
      { key: 'settled', label: 'Redemptions settled', color: EXIT_COLOR, value: num(x.settledHollar) },
    ],
    tip: (
      <>
        <span className="t-d">{mdLabel(x.day)}</span>
        <TipRow color={DEPOSIT_COLOR} label="Deposited" value={`${F.amount(x.depositsHollar, 18)} HOLLAR · ${F.int(x.deposits)}`} />
        <TipRow color={EXIT_COLOR} label="Redemptions settled" value={`${F.amount(x.settledHollar, 18)} HOLLAR`} />
        <TipRow color={CLAIM_COLOR} label="Claimed" value={`${F.amount(x.claimedHollar, 18)} HOLLAR`} />
        <TipRow label="Redemption requests" value={F.int(x.redeems)} />
        <TipRow color={YIELD_COLOR} label="Decentral interest" value={`${F.amount(x.interestHollar, 18)} HOLLAR`} />
        <TipRow color={KEEPER_COLOR} label="Decentral principal" value={`${F.amount(x.principalHollar, 18)} HOLLAR`} />
        <TipRow label="Borrower drew · repaid" value={`${F.amount(x.drawsHollar, 18)} · ${F.amount(x.repaysHollar, 18)}`} />
      </>
    ),
  }))
  return (
    <>
      <SecTitle title="Flows" subtitle="per day since launch, in HOLLAR" />
      <div className="pf-card">
        {!rows.length ? <div className="hdx-note" style={{ marginTop: 0 }}>No BIL activity has been indexed yet.</div>
          : rows.length < FLOWS_CHART_MIN_DAYS ? (
            <div className="panel" style={{ marginTop: 0 }}>
              <table className="tbl">
                <thead><tr><th>Day</th><th className="r">Deposited</th><th className="r">Redemptions settled</th><th className="r">Claimed</th></tr></thead>
                <tbody>{[...rows].reverse().map(x => (
                  <tr key={x.day}><td data-label="Day">{mdLabel(x.day)}</td><td data-label="Deposited" className="r mono">{F.amount(x.depositsHollar, 18)}</td><td data-label="Redemptions settled" className="r mono">{F.amount(x.settledHollar, 18)}</td><td data-label="Claimed" className="r mono">{F.amount(x.claimedHollar, 18)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          ) : <>
            <ChartLegend items={[{ label: 'Deposited', color: DEPOSIT_COLOR }, { label: 'Redemptions settled', color: EXIT_COLOR }]} />
            <StackedColumnChart columns={columns} h={narrow ? 300 : 180} yFmt={hollarTick} />
          </>}
        <div className="hdx-cards">
          <Card k="Deposits" dot={DEPOSIT_COLOR} v={<Hollar d={d} raw={t.depositsHollar} />} s={<>{F.int(t.deposits)} deposits by {F.int(d.depositors)} accounts · <Usd v={t.depositsUsd} /> when made</>} />
          <Card k="Redemptions settled" dot={EXIT_COLOR} v={<Hollar d={d} raw={t.settledHollar} />} s={<>over {F.int(t.redeems)} requests · {F.int(t.cancels)} cancelled · {F.int(t.claims)} claims paid <Hollar d={d} raw={t.claimedHollar} /></>} />
          <Card k="Decentral interest" dot={YIELD_COLOR} v={<Hollar d={d} raw={t.interestHollar} />} s="the fixed interest matured positions paid the vault" />
          <Card k="Decentral principal" dot={KEEPER_COLOR} v={<Hollar d={d} raw={t.principalHollar} />} s={<>returned by matured positions · {F.int(t.reinvests)} reinvestments of <Hollar d={d} raw={t.reinvestedHollar} /></>} />
        </div>
        {t.unpricedRows > 0 && <div className="hdx-note">{F.int(t.unpricedRows)} {t.unpricedRows === 1 ? 'deposit has' : 'deposits have'} no price when made and {t.unpricedRows === 1 ? 'is' : 'are'} left out of the dollar figure.</div>}
      </div>
    </>
  )
}

// 7b. where the payouts come from — the borrower's draws and repayments against the vault's flows
function RolloverSection({ d }: { d: BilDashboard }) {
  const r = d.rollover
  const drawn = BigInt(r.drawnHollar), repaid = BigInt(r.repaidHollar)
  return (
    <>
      <SecTitle title="Where payouts come from" subtitle="since the vault’s first investment, from the indexed transfers" />
      <div className="pf-card">
        <div className="hdx-cards" style={{ marginTop: 0 }}>
          <Card k="Borrower drew" v={<Hollar d={d} raw={r.drawnHollar} />} s="HOLLAR the Decentral borrower took from the pool to finance receivables" />
          <Card k="Borrower repaid" v={<Hollar d={d} raw={r.repaidHollar} />} s={<>into the pool · <Hollar d={d} raw={(drawn > repaid ? drawn - repaid : 0n).toString()} /> drawn net of repayments</>} />
          <Card k="Pool paid the vault" dot={KEEPER_COLOR} v={<Hollar d={d} raw={r.paidToVaultHollar} />} s="principal and interest of matured positions" />
          <Card k="Vault invested" dot={DEPOSIT_COLOR} v={<Hollar d={d} raw={r.investedByVaultHollar} />} s="in the pool: new deposits and reinvested payouts" />
        </div>
        <div className="hdx-note">So far the borrower has repaid less than the pool has paid the vault: maturities have been paid partly out of new deposits and reinvestment flowing into the pool, not only out of repaid receivables. Payouts on schedule therefore also depend on the pool staying funded — through new deposits and reinvestment, or the borrower’s repayments.</div>
      </div>
    </>
  )
}

// 8. who holds it
function HoldersSection({ d }: { d: BilDashboard }) {
  const page = Number(useQueryValue('hpage', '0')) || 0
  const pages = Math.max(1, Math.ceil(d.positions.length / HOLDERS_SHOWN))
  const shown = d.positions.slice(page * HOLDERS_SHOWN, (page + 1) * HOLDERS_SHOWN)
  return (
    <>
      <SecTitle title="Holders" subtitle={<>largest first · BIL, uBIL, queued redemptions and settled HOLLAR to claim · <Link to={paths.holders(d.bilAsset.assetId)}>all BIL holders</Link></>} />
      <div className="panel">
        <table className="tbl ice-rank">
          <thead><tr><th>Holder</th><th className="r">Position</th><th className="r">Holding</th><th className="r">Share</th></tr></thead>
          <tbody>
            {!shown.length ? <EmptyRow cols={4}>{d.asOfBlock == null ? 'The vault’s current state is unavailable right now' : 'No holders'}</EmptyRow> : shown.map(p => (
              <tr key={p.account.accountId}>
                <td data-label="Holder"><AddrPill account={p.account} noCopy /></td>
                <td data-label="Position" className="r mono"><Usd v={p.totalUsd} />{p.totalHollar != null && <div className="muted" style={{ fontSize: 11 }}>{F.amount(p.totalHollar, 18)} HOLLAR</div>}</td>
                <td data-label="Holding" className="r mono">
                  {p.bil !== '0' && <div><AssetAmount asset={d.bilAsset} raw={p.bil} /></div>}
                  {p.ubil !== '0' && <div><AssetAmount asset={d.ubilAsset} raw={p.ubil} /></div>}
                  {p.queuedShares !== '0' && <div className="muted" style={{ fontSize: 11 }}>{F.amount(p.queuedShares, 18)} uBIL queued</div>}
                  {p.claimableHollar !== '0' && <div className="muted" style={{ fontSize: 11 }}>{F.amount(p.claimableHollar, 18)} HOLLAR to claim</div>}
                </td>
                <td data-label="Share" className="r mono muted">{F.share(p.share)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && <Pager page={page} totalPages={pages} onPage={p => setQuery({ hpage: p > 0 ? String(p) : null })} />}
    </>
  )
}

// 9. every act — the strategy's rows, or the pool's trades
function ActivitySection({ d, narrow }: { d: BilDashboard; narrow: boolean }) {
  const size = narrow ? ACTIVITY_PAGE_NARROW : ACTIVITY_PAGE
  const page = usePageParam()
  const requested = useQueryValue('action', '')
  const feed = useQueryValue('feed', '') === 'pool' && d.pool ? 'pool' : 'strategy'
  const action = BIL_ACTION_FILTERS.some(a => a.v === requested) ? requested : ''
  const now = useNow()
  const strategy = useActivity(size, undefined, undefined, page * size, 'bil', undefined, action || undefined)
  const { data: count } = useActivityCount('bil', undefined, undefined, undefined, action || undefined)
  const pool = useAccountActivity(feed === 'pool' ? d.pool?.account.address ?? null : null, 'trade', page * PAGE_SIZE)
  const src = feed === 'pool' ? pool : strategy
  const rows = src.data ?? []
  const pages = feed === 'pool'
    ? { totalPages: page + (rows.length >= PAGE_SIZE ? 2 : 1), hasNext: rows.length >= PAGE_SIZE, note: undefined }
    : offeredPages({ page, rowsOnPage: rows.length, rowCount: count?.total, maxOffset: count?.maxOffset, pageSize: size })
  return (
    <>
      <div className="sec-title-row">
        <h2 className="sec-title">BIL activity <span style={MUTED_SUB}>· newest first</span></h2>
        <div className="bil-feed-controls">
          <select className="activity-action" value={feed} onChange={e => setQuery({ feed: e.target.value === 'pool' ? 'pool' : null, action: null, page: null })} aria-label="BIL feed">
            <option value="strategy">Strategy acts</option>
            <option value="pool">Pool {d.pool?.poolId ?? ''} trades</option>
          </select>
          {feed === 'strategy' && (
            <select className="activity-action" value={action} onChange={e => setQuery({ action: e.target.value || null, page: null })} aria-label="BIL action">
              <option value="">All actions</option>
              {BIL_ACTION_FILTERS.map(a => <option key={a.v} value={a.v}>{a.label}</option>)}
            </select>
          )}
        </div>
      </div>
      <ActivityTable rows={rows} now={now} live={page === 0} anchorRef={src.anchorRef} loading={src.isFetching && rows.length === 0} pending={src.isPlaceholderData} pageSize={feed === 'pool' ? PAGE_SIZE : size} error={src.error} onRetry={() => { void src.refetch() }} />
      <Pager page={page} totalPages={pages.totalPages} hasNext={pages.hasNext} note={pages.note} onPage={p => setQuery({ page: p > 0 ? String(p) : null })} />
    </>
  )
}

// 10. the contracts behind it
function ContractsSection({ d }: { d: BilDashboard }) {
  return (
    <>
      <SecTitle title="Contracts" subtitle={<>the strategy and the venues it runs through{d.launchBlock ? <> · first deposit at <Link to={paths.block(d.launchBlock)} className="hash mono">block {F.int(d.launchBlock)}</Link></> : null}</>} />
      <div className="panel">
        <table className="tbl">
          <thead><tr><th>Role</th><th>Account</th></tr></thead>
          <tbody>
            {d.contracts.map(c => (
              <tr key={c.account.accountId}>
                <td data-label="Role">{c.role}</td>
                <td data-label="Account"><AddrPill account={c.account} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function BilSkeleton() {
  return (
    <>
      <ChartSkeleton h={78} />
      <SecTitle title="The vault" /><ChartSkeleton h={220} />
      <SecTitle title="Maturity ladder" /><ChartSkeleton h={220} />
      <SecTitle title="Redemption queue" />
      <div className="panel"><table className="tbl"><tbody><TableSkeleton cols={5} rows={6} mobileCols={2} /></tbody></table></div>
    </>
  )
}

export function Bil() {
  const { data, isError, refetch } = useBilDashboard()
  const narrow = useMediaQuery(NARROW)
  const now = useNow()
  useDocumentTitle('Brazilian Invoice Loans')
  // A request linked from its activity page or a Strategies card (#bil-request-N) is
  // scrolled to once its row exists — the queue opens on that request's page.
  useEffect(() => {
    const id = window.location.hash.slice(1)
    if (data && id.startsWith('bil-request-')) document.getElementById(id)?.scrollIntoView({ block: 'center' })
  }, [data])
  const ready = data
  return (
    <div className="wrap ice-page juicer-page bil-page">
      <div className="ext-link-row">
        <a className="ext-link" href={APP_URL} target="_blank" rel="noopener noreferrer">Open in the Hydration app</a>
      </div>
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Assets', to: paths.assets() }, { label: 'Brazilian Invoice Loans' }]} />
        <h1 className="page-title">Brazilian Invoice Loans <span className="sub">fixed-rate yield from Brazilian invoice receivables, in HOLLAR</span></h1>
      </div>
      {!narrow && <Intro narrow={false} d={data} />}
      {isError
        ? <LoadError title="Couldn’t load the Brazilian Invoice Loans dashboard" onRetry={() => { void refetch() }} />
        : !ready ? <BilSkeleton /> : (
          <>
            <Ribbon d={ready} />
            {narrow && <Intro narrow d={ready} />}
            <div className="ice-asof">
              {ready.asOfBlock != null
                ? <>Vault state at <Link to={paths.block(ready.asOfBlock)} className="hash">block {F.int(ready.asOfBlock)}</Link> · <Ago ts={ready.generatedAt} now={now} /></>
                : 'The vault’s current state is unavailable right now; its history below still holds.'}
              {' · '}<AssetChip asset={ready.bilAsset} /> over <AssetChip asset={ready.ubilAsset} /> over <AssetChip asset={ready.hollarAsset} />
            </div>
            <VaultSection d={ready} />
            <NavSection d={ready} narrow={narrow} />
            <LadderSection d={ready} narrow={narrow} />
            <QueueSection d={ready} />
            <PoolSection d={ready} narrow={narrow} />
            <BorrowSection d={ready} />
            <FlowsSection d={ready} narrow={narrow} />
            <RolloverSection d={ready} />
            <HoldersSection d={ready} />
            <ActivitySection d={ready} narrow={narrow} />
            <ContractsSection d={ready} />
          </>
        )}
    </div>
  )
}
