import { type ReactNode } from 'react'
import { useAssetActivity, useBondDashboard } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useNow } from '../hooks/useNow'
import { Link, paths, setQuery, useQueryValue, usePageParam } from '../router'
import { AddrPill, Ago, AssetAmount, AssetChip, ChartSkeleton, Crumbs, EmptyRow, F, LoadError, Pager, TableSkeleton, TagGroupPill, Usd, compactAmount } from '../components/ui'
import { ActivityTable } from '../components/ActivityTable'
import { ChartLegend, MultiLineChart, ShareBar, StackedColumnChart } from '../components/HdxCharts'
import type { AreaSeries, ShareSegment, StackColumn } from '../components/HdxCharts'
import { ChartTooltipRow as TipRow, DashboardSectionTitle } from '../components/DashboardPrimitives'
import { monthDayLabel as mdLabel } from '../utils/dashboardDates'
import { fmtDuration } from '../utils/dca'
import type { BondDashboard, BondRound, BondSale } from '../types'
import { BOND_STATUS_LABEL, BOND_STATUS_TONE, bondDate, bondPct as pct } from '../components/positions/bondStatus'
import { bondFamilyUi } from '../bondFamilies'

// Section titles are the page outline's h2s under its h1.
const SecTitle = (p: { title: string; subtitle?: ReactNode }) => <DashboardSectionTitle {...p} as="h2" />

// A bond family's page — the HOLLAR bonds today (app.hydration.net/strategies/hollar-bonds).
// The Treasury issues a bond against HOLLAR it locks in the Bonds pallet pot and sells it
// below face through its own offers for USDT and USDC; the discount is the fixed yield.
// From maturity any holder redeems it 1:1 for HOLLAR. The page states every round the
// way the app does — fixed yield, APR, capacity, maturity — then what the index adds: the
// yield purchases locked in day by day, how each sale went, the rollover, how quickly the
// matured bonds came back, who holds them and every act on them.

const NARROW = '(max-width: 720px)'
const ACTIVITY_PAGE = 40
const ACTIVITY_PAGE_NARROW = 10
const HOLDERS_SHOWN = 10
const DAY_MS = 86_400_000
const YEAR_MS = 365 * DAY_MS
const MUTED_SUB = { color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 } as const
/** One distinct colour per round, newest first — the newest in the bond family's teal; a rollover has its own. */
const ROUND_COLORS = ['var(--cat-bond)', 'var(--cat-liquidity)', 'var(--cat-stake)', 'var(--cat-borrow)', 'var(--cat-intent)']
const ROLLOVER_COLOR = 'var(--cat-bil-yield)'
const roundColor = (d: BondDashboard, bondId: number): string => {
  const i = d.rounds.findIndex(r => r.bondId === bondId)
  return ROUND_COLORS[Math.max(0, d.rounds.length - 1 - i) % ROUND_COLORS.length]
}
const UNSOLD_COLOR = 'var(--separator)'
const num = (raw: string | null | undefined, dec = 18): number => raw == null ? 0 : Number(BigInt(raw) * 1_000_000n / 10n ** BigInt(dec)) / 1e6
const tick = (v: number): string => v === 0 ? '0' : compactAmount(v)
/** Every day from the first to the last, inclusive (YYYY-MM-DD). */
function dayGrid(first: string, last: string): string[] {
  const out: string[] = []
  for (let t = Date.parse(first + 'T00:00:00Z'); t <= Date.parse(last + 'T00:00:00Z'); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}
const roundName = (r: Pick<BondRound, 'round'>) => `Round ${r.round}`
const saleName = (s: BondSale): ReactNode => s.kind === 'rollover'
  ? <>Rollover from {s.fromRound != null ? <a href={`#round-${s.fromRound}`}>Round {s.fromRound}</a> : <AssetChip asset={s.paymentAsset} />}</>
  : <>Sale for <AssetChip asset={s.paymentAsset} /></>
const venueName = (s: BondSale) => s.venue === 'otc' ? `OTC #${s.id}` : `LBP ${s.id.slice(0, 8)}…`

function Card({ k, v, s, dot }: { k: string; v: ReactNode; s?: ReactNode; dot?: string }) {
  return (
    <div className="hdx-card">
      <div className="hk">{dot && <i style={{ background: dot }} />}{k}</div>
      <div className="hv">{v}</div>
      {s && <div className="hs">{s}</div>}
    </div>
  )
}
function Face({ d, raw }: { d: BondDashboard; raw: string | null | undefined }) {
  return raw == null ? <>—</> : <AssetAmount asset={d.underlying} raw={raw} />
}
/** The round a page-level `round` parameter names, else the newest. */
function useSelectedRound(d: BondDashboard): BondRound | undefined {
  const requested = useQueryValue('round', '')
  return d.rounds.find(x => String(x.round) === requested) ?? d.rounds[d.rounds.length - 1]
}

// 0. what this is — the official app's own explanation, the mechanics and the caveats
function Intro({ narrow, d }: { narrow: boolean; d: BondDashboard | undefined }) {
  const sym = d?.underlying.symbol ?? 'HOLLAR'
  const body = (
    <>
      <p className="ice-lede">
        {sym} Bonds are fixed-yield bonds the Hydration <b>Treasury</b> sells below face. Each bond redeems 1:1 for {sym} on its maturity date, so the discount you buy at is your fixed yield — the app also quotes it as an APR. The {sym} that pays them back is locked in the Bonds pallet’s pot the moment a round is issued, and the yield is funded by the Treasury’s own strategies on Hydration rather than by external incentives.
      </p>
      <ol className="juicer-steps bond-steps" aria-label={`How ${sym} Bonds work`}>
        <li>
          <b>Buy</b>
          <span>Governance issues a round — a new bond token with a fixed maturity — and the Treasury offers it through OTC orders priced in USDT and USDC. Buying fills that order: you pay the stablecoin and receive the bonds, less the OTC fee of 0.1%.</span>
        </li>
        <li>
          <b>Hold</b>
          <span>The price is fixed for the whole sale, so the fixed yield is the same for every buyer while the APR it works out to rises as maturity approaches. Bonds are ordinary tokens: they can be transferred, but there is no early redemption and no pool to sell them into.</span>
        </li>
        <li>
          <b>Redeem</b>
          <span>From maturity, redeem any amount 1:1 for {sym} out of the pot — or, while a new round offers it, roll the bonds over into the next one at its rollover rate instead.</span>
        </li>
      </ol>
      <p className="juicer-risk">
        The yield is fixed and there is no liquidation, but a bond pays out in {sym}, not in the stablecoin you paid with: what it is worth at maturity follows {sym}’s own price. The {sym} behind the bonds is already locked in the Bonds pot (this page checks that it equals the bonds outstanding), and the Treasury raised it by borrowing {sym} in the money market — the protocol, not the bond holder, carries that debt. Your money is locked until maturity: the only way out before it is a private transfer of the bonds.
      </p>
      <details className="ice-gloss">
        <summary>Terms on this page</summary>
        <dl>
          <dt>Round</dt><dd>One bond token with one maturity, issued by governance. A later issue on the same maturity tops the round up; a new maturity is a new round.</dd>
          <dt>Face</dt><dd>What a bond redeems for at maturity: one {sym}. Amounts of bonds on this page are stated in face.</dd>
          <dt>Sale · rollover</dt><dd>One of the Treasury’s offers selling the round: a <i>sale</i> takes USDT or USDC, a <i>rollover</i> takes the previous round’s bonds.</dd>
          <dt>Fixed yield</dt><dd>What holding to maturity returns on the price paid, net of the 0.1% fee — the same for every buyer of a sale, as the app quotes it.</dd>
          <dt>APR</dt><dd>The fixed yield annualised, simple, over the time a purchase waits for maturity — quoted from when the sale opened, and higher for every later purchase at the same price. A rollover earns from the old bond’s maturity to the new one’s.</dd>
          <dt>Worth now</dt><dd>What a bond is valued at on this explorer: its sale’s price while the sale stands, then that price accreting to face by maturity (simple interest), and face from maturity.</dd>
          <dt>Owed to holders · the Treasury’s own</dt><dd>Bonds issued and not yet redeemed, split between holders outside the Treasury and the Treasury’s own accounts (what its offers did not sell and the OTC fees).</dd>
          <dt>Bonds pot</dt><dd>The Bonds pallet’s account. It holds the {sym} of every outstanding bond until it is redeemed.</dd>
        </dl>
      </details>
    </>
  )
  if (narrow) return <details className="ice-gloss juicer-intro"><summary>What {sym} Bonds are and how they work</summary>{body}</details>
  return body
}

// 1. headline strip — five cells, one line at desktop width
function Ribbon({ d }: { d: BondDashboard }) {
  const now = useNow()
  const live = [...d.rounds].reverse().find(r => r.status === 'selling' || r.status === 'active') ?? d.rounds[d.rounds.length - 1]
  const left = live ? (Date.parse(live.maturityAt) - now) / 1000 : null
  const t = d.totals
  const cells: { k: string; v: ReactNode; s?: ReactNode }[] = [
    { k: 'Owed to holders', v: <><span className="mono">{F.amount(t.publicOutstanding ?? t.outstanding, d.underlying.decimals)}</span> {d.underlying.symbol}</>, s: <>face · worth <Usd v={t.publicUsd} /> · {t.holders != null ? F.int(t.holders) : '—'} holders</> },
    { k: live ? `${roundName(live)} · fixed yield` : 'Fixed yield', v: pct(live?.fixedYieldPct ?? null, 4), s: live ? <>{pct(live.aprAtOpenPct)} APR from opening, net of fee</> : undefined },
    { k: 'Status', v: live ? <span className={`badge ${BOND_STATUS_TONE[live.status]}`}>{BOND_STATUS_LABEL[live.status]}</span> : '—', s: live ? <>matures {bondDate(live.maturityAt)}{left != null && left > 0 ? ` · ${Math.ceil(left / 86_400)}d` : ''}</> : undefined },
    { k: 'Sold', v: <span className="mono">{F.amount(t.soldForMoney, d.underlying.decimals)}</span>, s: <>for USDT / USDC · +{F.amount(t.rolledOver, d.underlying.decimals)} rolled</> },
    { k: 'Redeemed', v: <span className="mono">{F.amount(t.redeemed, d.underlying.decimals)}</span>, s: <>{d.underlying.symbol} paid back</> },
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

// 2. the rounds — terms, each sale's progress, what is owed and to whom
function SaleProgress({ d, r, s }: { d: BondDashboard; r: BondRound; s: BondSale }) {
  const dec = r.asset.decimals
  const offered = num(s.offered, dec)
  const sold = num(s.sold, dec), left = num(s.remaining, dec), unsold = num(s.unsold, dec)
  const color = s.kind === 'rollover' ? ROLLOVER_COLOR : roundColor(d, r.bondId)
  const segs: ShareSegment[] = [
    { key: 'sold', label: 'Sold', color, value: sold, tip: <><span className="t-d">Sold to {F.int(s.buyers)} buyer{s.buyers === 1 ? '' : 's'} in {F.int(s.fills)} fill{s.fills === 1 ? '' : 's'}</span><TipRow label="Bonds (face)" value={F.exact(s.sold, dec)} /><TipRow label={`Paid (${s.paymentAsset.symbol})`} value={F.exact(s.paid, s.paymentAsset.decimals)} /></> },
    { key: 'left', label: 'On offer', color: 'var(--text-low)', value: left, tip: <><span className="t-d">Still on offer</span><TipRow label="Bonds (face)" value={F.exact(s.remaining, dec)} /></> },
    { key: 'unsold', label: 'Unsold', color: UNSOLD_COLOR, value: unsold, tip: <><span className="t-d">Not sold — back with the Treasury when the sale closed</span><TipRow label="Bonds (face)" value={F.exact(s.unsold, dec)} /></> },
  ]
  const share = offered > 0 ? sold / offered * 100 : null
  return (
    <div className="bond-offer">
      <div className="bond-offer-head">
        <span><b>{saleName(s)}</b> <span className="muted mono">{venueName(s)}</span></span>
        <span className="muted">{s.kind === 'rollover'
          ? <>{s.price != null ? <>{s.price.toFixed(4)} old per new</> : '—'} · {pct(s.fixedYieldPct, 4)} more face · {pct(s.aprAtOpenPct)} APR</>
          : <>{s.price != null ? <>{s.price.toFixed(4)} {s.paymentAsset.symbol} per bond</> : '—'} · {pct(s.fixedYieldPct, 4)} fixed · {pct(s.aprAtOpenPct)} APR at opening</>}</span>
        <span className="mono">{share != null ? `${share.toFixed(share >= 99.95 || share === 0 ? 0 : 1)}% sold · ` : ''}{s.state === 'open' ? 'open' : s.state === 'filled' ? `sold out ${s.endedAt ? bondDate(s.endedAt) : ''}` : `closed ${s.endedAt ? bondDate(s.endedAt) : ''}`}</span>
      </div>
      <ShareBar segments={segs} h={12} />
    </div>
  )
}

function RoundCard({ d, r }: { d: BondDashboard; r: BondRound }) {
  const now = useNow()
  const left = (Date.parse(r.maturityAt) - now) / 1000
  const dec = r.asset.decimals
  const redeemedPct = num(r.issued, dec) > 0 ? num(r.redeemed, dec) / num(r.issued, dec) * 100 : null
  return (
    <div className="pf-card bond-round" id={`round-${r.round}`}>
      <div className="sec-title-row" style={{ marginTop: 0 }}>
        <h3 className="sec-title" style={{ margin: 0 }}>
          <i className="bond-dot" style={{ background: roundColor(d, r.bondId) }} />{roundName(r)} <AssetChip asset={r.asset} />
          {' '}<span style={MUTED_SUB}>· issued {bondDate(r.createdAt)} · matures {bondDate(r.maturityAt)}{left > 0 ? ` (in ${fmtDuration(left)})` : ''}</span>
        </h3>
        <span className={`badge ${BOND_STATUS_TONE[r.status]}`}>{BOND_STATUS_LABEL[r.status]}</span>
      </div>
      <div className="hdx-cards" style={{ marginTop: 10 }}>
        <Card k="Fixed yield" v={pct(r.fixedYieldPct, 4)} s={r.fixedYieldPct != null ? <>to maturity, net of the 0.1% fee · {pct(r.aprAtOpenPct)} APR counted from when the sale opened{r.salePrice != null ? <> · {r.salePrice.toFixed(4)} paid per bond</> : null}</> : 'no sale in stablecoins'} />
        <Card k="Issued" v={<Face d={d} raw={r.issued} />} s={<>by <AddrPill account={r.issuer} noCopy /> into the Bonds pot</>} />
        <Card k="Sold for money" dot={roundColor(d, r.bondId)} v={<Face d={d} raw={r.soldForMoney} />} s={<>{r.proceeds.length ? <>raised {r.proceeds.map((p, i) => <span key={p.asset.assetId}>{i > 0 && ' + '}<AssetAmount asset={p.asset} raw={p.raw} /></span>)}</> : 'nothing raised yet'}{r.rolledOver !== '0' ? <> · <Face d={d} raw={r.rolledOver} /> rolled over</> : null} · {F.int(r.buyers)} buyers</>} />
        <Card k="Redeemed" v={<Face d={d} raw={r.redeemed} />} s={r.redemptions ? <>{redeemedPct != null ? `${redeemedPct.toFixed(redeemedPct > 99.9 ? 2 : 1)}% of the issue` : ''} in {F.int(r.redemptions)} redemptions{r.lastRedemptionAt ? <>, the last {bondDate(r.lastRedemptionAt)}</> : null}</> : left > 0 ? 'redeemable from maturity' : 'none yet'} />
        <Card k="Owed to holders" v={<Face d={d} raw={r.publicOutstanding ?? r.outstanding} />} s={r.publicOutstanding != null ? <>face held outside the Treasury · worth <Usd v={r.publicUsd} /> now</> : <>issued less redeemed — the holders do not reconcile at this block, so the split is withheld</>} />
        <Card k="The Treasury’s own" v={<Face d={d} raw={r.issuerHeld} />} s={r.issuerHeld != null ? <>face: unsold bonds and OTC fees{r.rolledOver !== '0' ? ', bonds taken back by a rollover' : ''} · worth <Usd v={r.issuerUsd} />{r.valueFactor != null ? <> · {r.valueFactor >= 1 ? 'at face (matured)' : `${r.valueFactor.toFixed(4)} ${d.underlying.symbol} per bond`}</> : null}</> : 'withheld with the split'} />
      </div>
      {r.sales.length > 0 && <div className="bond-offers">{r.sales.map(s => <SaleProgress key={`${s.venue}:${s.id}`} d={d} r={r} s={s} />)}</div>}
    </div>
  )
}

function RoundsSection({ d }: { d: BondDashboard }) {
  return (
    <>
      <SecTitle title="Rounds" subtitle="every bond the Treasury issued, newest first — its terms, how each sale went and what is still owed" />
      {[...d.rounds].reverse().map(r => <RoundCard key={r.bondId} d={d} r={r} />)}
    </>
  )
}

// 3. the yield a purchase locked in, day by day, at each sale's fixed price
interface YieldLine { key: string; label: string; color: string; dashed: boolean; aprOn: (dayEndMs: number) => number | null; from: string; to: string }
function yieldLines(d: BondDashboard, now: number): YieldLine[] {
  const out: YieldLine[] = []
  for (const r of d.rounds) {
    const maturity = Date.parse(r.maturityAt)
    // Sales of one round on the same terms (USDT and USDC at one price) are one line.
    const groups = new Map<string, BondSale[]>()
    for (const s of r.sales) if (s.fixedYieldPct != null) {
      const k = `${s.kind}:${s.price?.toFixed(9)}`
      ;(groups.get(k) ?? groups.set(k, []).get(k)!).push(s)
    }
    for (const [k, list] of groups) {
      const s = list[0]
      const opened = Math.min(...list.map(x => Date.parse(x.openedAt)))
      const ended = Math.max(...list.map(x => x.endedAt ? Date.parse(x.endedAt) : now))
      const oldMaturity = s.fromRound != null ? Date.parse(d.rounds.find(x => x.round === s.fromRound)?.maturityAt ?? '') : NaN
      const pays = list.map(x => x.paymentAsset.symbol).join(' / ')
      out.push({
        key: `${r.bondId}:${k}`,
        label: s.kind === 'rollover' ? `${roundName(r)} rollover` : `${roundName(r)} · ${pays}`,
        color: s.kind === 'rollover' ? ROLLOVER_COLOR : roundColor(d, r.bondId), dashed: s.kind === 'rollover',
        aprOn: dayEnd => {
          const at = Math.min(dayEnd, ended)
          const from = Number.isFinite(oldMaturity) ? Math.max(at, oldMaturity) : at
          return maturity > from ? s.fixedYieldPct! * YEAR_MS / (maturity - from) : null
        },
        from: new Date(opened).toISOString().slice(0, 10), to: new Date(ended).toISOString().slice(0, 10),
      })
    }
  }
  return out
}
function YieldSection({ d, narrow }: { d: BondDashboard; narrow: boolean }) {
  const now = useNow()
  const lines = yieldLines(d, now)
  if (!lines.length) return null
  const first = lines.map(l => l.from).sort()[0], last = lines.map(l => l.to).sort().reverse()[0]
  const days = dayGrid(first, last)
  const series: AreaSeries[] = lines.map(l => ({
    key: l.key, label: l.label, color: l.color, dashed: l.dashed,
    values: days.map(day => day >= l.from && day <= l.to ? l.aprOn(Date.parse(day + 'T00:00:00Z') + DAY_MS) : null),
  }))
  const vals = series.flatMap(s => s.values).filter((v): v is number => v != null)
  const hi = Math.max(0, ...vals)
  const step = hi > 20 ? 5 : 2
  const ticks: number[] = []
  for (let v = 0; v <= Math.ceil(hi / step) * step; v += step) ticks.push(v)
  const bought = new Map(d.rounds.map(r => [r.bondId, d.fillDays.filter(f => f.bondId === r.bondId && f.kind === 'sale')]))
  return (
    <>
      <SecTitle title="Implied yield" subtitle="the APR a purchase at each sale’s fixed price locked in, on each day the sale stood" />
      <div className="pf-card">
        <ChartLegend items={series.map(s => ({ label: s.label, color: s.color, dashed: s.dashed }))} />
        <MultiLineChart buckets={days} series={series} h={narrow ? 320 : 200} yFmt={v => `${v.toFixed(1)}%`} refLine={null} yTicks={ticks} markLast />
        <div className="hdx-cards">
          {d.rounds.map(r => {
            const fills = bought.get(r.bondId) ?? []
            const w = fills.reduce((s, f) => s + num(f.bonds), 0)
            const avg = w > 0 ? fills.reduce((s, f) => s + (f.aprPct ?? 0) * num(f.bonds), 0) / w : null
            return <Card key={r.bondId} k={roundName(r)} dot={roundColor(d, r.bondId)} v={pct(r.fixedYieldPct, 4)}
              s={<>fixed · {pct(r.aprAtOpenPct)} APR at the sale’s opening{avg != null ? <>, {pct(avg)} on average as bought</> : null}{r.sales.some(s => s.kind === 'rollover') ? <> · rollover {r.sales.filter(s => s.kind === 'rollover').map(s => pct(s.aprAtOpenPct)).join(' / ')} APR</> : null}</>} />
          })}
        </div>
        <div className="hdx-note">A sale’s price never changes, so its fixed yield is the same for every buyer, while the time left to maturity shrinks: the APR a purchase locked in climbs day by day until the sale closes — the app’s “APR +”. The rollover (dashed) paid in the previous round’s bonds and earns from that round’s maturity on. Yields are on the sales’ own units, one USDT or USDC per {d.underlying.symbol} of face, the way the issuer prices them.</div>
      </div>
    </>
  )
}

// 4. sale progress over time and the redemption timeline
function FlowSection({ d, narrow, kind }: { d: BondDashboard; narrow: boolean; kind: 'sold' | 'redeemed' }) {
  const now = useNow()
  const dec = d.underlying.decimals
  const firstIdx = d.days.findIndex(x => Object.keys(x[kind]).length > 0)
  let lastIdx = -1
  d.days.forEach((x, i) => { if (Object.keys(x[kind]).length > 0) lastIdx = i })
  const title = kind === 'sold' ? 'Sales per day' : 'Redemption timeline'
  if (firstIdx < 0) return kind === 'redeemed' ? (<><SecTitle title={title} /><div className="pf-card"><div className="hdx-note" style={{ marginTop: 0 }}>No bond has been redeemed yet — the first round to mature opens redemptions.</div></div></>) : null
  const from = Math.max(0, firstIdx - (kind === 'redeemed' ? 2 : 0))
  const to = Math.min(d.days.length - 1, lastIdx + 3)
  const rows = d.days.slice(from, to + 1)
  const every = Math.max(1, Math.ceil(rows.length / (narrow ? 4 : 10)))
  const shown = d.rounds.filter(r => kind === 'sold' || Date.parse(r.maturityAt) <= now)
  const totals = new Map(d.rounds.map(r => [r.bondId, num(kind === 'sold' ? r.offered : r.issued, dec)]))
  const running = new Map<number, number>()
  for (const x of d.days.slice(0, from)) for (const [id, raw] of Object.entries(x[kind])) running.set(Number(id), (running.get(Number(id)) ?? 0) + num(raw, dec))
  const columns: StackColumn[] = rows.map((x, i) => {
    for (const [id, raw] of Object.entries(x[kind])) running.set(Number(id), (running.get(Number(id)) ?? 0) + num(raw, dec))
    const snap = new Map(running)
    return {
      key: x.day, label: i % every === 0 ? mdLabel(x.day) : '',
      segments: shown.map(r => ({ key: String(r.bondId), label: roundName(r), color: roundColor(d, r.bondId), value: num(x[kind][String(r.bondId)] ?? '0', dec) })),
      tip: (
        <>
          <span className="t-d">{mdLabel(x.day)}</span>
          {shown.filter(r => x[kind][String(r.bondId)] || (snap.get(r.bondId) ?? 0) > 0).map(r => {
            const tot = totals.get(r.bondId) ?? 0, cum = snap.get(r.bondId) ?? 0
            return <TipRow key={r.bondId} color={roundColor(d, r.bondId)} label={roundName(r)} value={`${F.amount(x[kind][String(r.bondId)] ?? '0', dec)} · ${tot > 0 ? (cum / tot * 100).toFixed(1) : '—'}% ${kind === 'sold' ? 'of the offers' : 'of the issue'} by then`} />
          })}
        </>
      ),
    }
  })
  return (
    <>
      <SecTitle title={title} subtitle={kind === 'sold' ? `bonds bought in the Treasury’s sales and rollovers, in ${d.underlying.symbol} face` : `bonds redeemed for ${d.underlying.symbol} per day from maturity`} />
      <div className="pf-card">
        <ChartLegend items={shown.map(r => ({ label: `${roundName(r)}${kind === 'redeemed' ? ` · matured ${bondDate(r.maturityAt)}` : ''}`, color: roundColor(d, r.bondId) }))} />
        <StackedColumnChart columns={columns} h={narrow ? 300 : 170} yFmt={tick} />
        {kind === 'redeemed' && (
          <div className="hdx-cards">
            {shown.map(r => {
              const issued = num(r.issued, dec), red = num(r.redeemed, dec)
              const m = Date.parse(r.maturityAt)
              let within = 0
              for (const x of d.days) if (Date.parse(x.day + 'T00:00:00Z') <= m + DAY_MS) within += num(x.redeemed[String(r.bondId)] ?? '0', dec)
              return <Card key={r.bondId} k={roundName(r)} dot={roundColor(d, r.bondId)} v={issued > 0 ? `${(red / issued * 100).toFixed(2)}%` : '—'}
                s={<>redeemed of <Face d={d} raw={r.issued} />; {issued > 0 ? `${(within / issued * 100).toFixed(1)}%` : '—'} by the day after maturity · <Face d={d} raw={r.publicOutstanding ?? r.outstanding} /> still owed to holders</>} />
            })}
          </div>
        )}
        {kind === 'sold' && <div className="hdx-note">Every sale of a round together, a rollover included; the share of each sale sold is on its round above.</div>}
        {kind === 'redeemed' && <div className="hdx-note">A matured bond redeems 1:1 for {d.underlying.symbol} out of the Bonds pot at any time; nothing is paid automatically. What the Treasury’s own accounts redeemed (the rollover’s returned bonds) counts here too.</div>}
      </div>
    </>
  )
}

// 5. the round the holders and activity below show — one page-level selector
function RoundPicker({ d, r }: { d: BondDashboard; r: BondRound }) {
  return (
    <div className="bond-round-picker">
      <span className="muted">Holders and activity of</span>
      <div className="seg-bar" role="group" aria-label="Round shown below">
        {[...d.rounds].reverse().map(x => (
          <button key={x.bondId} type="button" className={`seg-btn${x.bondId === r.bondId ? ' active' : ''}`} aria-pressed={x.bondId === r.bondId}
            onClick={() => setQuery({ round: x.round === d.rounds[d.rounds.length - 1].round ? null : String(x.round), page: null, hpage: null })}>
            {roundName(x)} · {bondDate(x.maturityAt)}
          </button>
        ))}
      </div>
    </div>
  )
}

// 6. who holds them — the asset page's own holder list, of the selected round
function HoldersSection({ d, r }: { d: BondDashboard; r: BondRound }) {
  const page = Number(useQueryValue('hpage', '0')) || 0
  const list = r.holders?.list ?? []
  const pages = Math.max(1, Math.ceil(list.length / HOLDERS_SHOWN))
  const shown = list.slice(page * HOLDERS_SHOWN, (page + 1) * HOLDERS_SHOWN)
  return (
    <>
      <SecTitle title="Holders" subtitle={<>{roundName(r)} · largest first · <Link to={paths.holders(r.bondId)}>all {F.int(r.holders?.holderCount ?? 0)} holders</Link></>} />
      <div className="panel">
        <table className="tbl ice-rank">
          <thead><tr><th>Holder</th><th className="r">Bonds (face)</th><th className="r">Worth now</th><th className="r">Share</th></tr></thead>
          <tbody>
            {!shown.length ? <EmptyRow cols={4}>{r.holders ? 'No holders' : 'The holders could not be read right now'}</EmptyRow> : shown.map((h, i) => (
              <tr key={h.account?.accountId ?? h.tag?.tagId ?? i}>
                <td data-label="Holder">{h.tag ? <TagGroupPill tag={h.tag} /> : h.account ? <AddrPill account={h.account} noCopy /> : '—'}</td>
                <td data-label="Bonds (face)" className="r mono"><Face d={d} raw={h.balance} /></td>
                <td data-label="Worth now" className="r mono"><Usd v={h.valueUsd ?? null} /></td>
                <td data-label="Share" className="r mono muted">{F.share(h.share ?? null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && <Pager page={page} totalPages={pages} onPage={p => setQuery({ hpage: p > 0 ? String(p) : null })} />}
      <div className="hdx-note">The Treasury’s accounts fold into one row: they hold what its sales did not sell, the 0.1% OTC fees and, after a rollover, the older round’s bonds it took back. Bonds held through a bound EVM address count as their account’s.</div>
    </>
  )
}

// 7. every act on the selected round's bond
const KINDS: { v: string; label: string; type: string; action?: string }[] = [
  { v: '', label: 'Every act', type: 'all' },
  { v: 'purchases', label: 'Purchases', type: 'bond', action: 'Purchase' },
  { v: 'rollovers', label: 'Rollovers', type: 'bond', action: 'Rollover' },
  { v: 'transfers', label: 'Transfers', type: 'transfer' },
  { v: 'redemptions', label: 'Redemptions', type: 'bond', action: 'Redeem' },
]
function ActivitySection({ r, narrow }: { r: BondRound; narrow: boolean }) {
  const now = useNow()
  const page = usePageParam()
  const size = narrow ? ACTIVITY_PAGE_NARROW : ACTIVITY_PAGE
  const kindParam = useQueryValue('kind', '')
  const kind = KINDS.find(k => k.v === kindParam) ?? KINDS[0]
  const src = useAssetActivity(r.bondId, kind.type, page * size, kind.action, true, undefined, undefined, undefined, undefined, size)
  const rows = src.data ?? []
  return (
    <>
      <div className="sec-title-row">
        <h2 className="sec-title">Activity <span style={MUTED_SUB}>· {roundName(r)} · every act on its bond, newest first</span></h2>
        <select className="activity-action" value={kind.v} onChange={e => setQuery({ kind: e.target.value || null, page: null })} aria-label="Kind">
          {KINDS.map(k => <option key={k.v} value={k.v}>{k.label}</option>)}
        </select>
      </div>
      <ActivityTable rows={rows} now={now} live={page === 0} anchorRef={src.anchorRef} loading={src.isFetching && rows.length === 0} pending={src.isPlaceholderData} pageSize={size} error={src.error} onRetry={() => { void src.refetch() }} />
      <Pager page={page} totalPages={page + (rows.length >= size ? 2 : 1)} hasNext={rows.length >= size} onPage={p => setQuery({ page: p > 0 ? String(p) : null })} />
    </>
  )
}

// 8. the accounts behind it
function AccountsSection({ d }: { d: BondDashboard }) {
  const p = d.pot
  return (
    <>
      <SecTitle title="Accounts" subtitle="who issues, sells and holds the underlying" />
      <div className="panel">
        <table className="tbl">
          <thead><tr><th>Role</th><th>Account</th></tr></thead>
          <tbody>
            {d.accounts.map(a => (
              <tr key={a.account.accountId + a.role}>
                <td data-label="Role">{a.role}</td>
                <td data-label="Account"><AddrPill account={a.account} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="hdx-note">
        The Bonds pot holds <Face d={d} raw={p.balance} /> {p.reconciled === true ? <>— exactly the <Face d={d} raw={p.outstanding} /> of {d.underlying.symbol} bonds outstanding, checked at this block.</> : p.reconciled === false ? <>against <Face d={d} raw={p.outstanding} /> outstanding: the two do <b>not</b> match at this block.</> : <>(its balance could not be read).</>} On this explorer the pot’s holdings are a custody balance, counted in no value — the bonds that claim them carry it.
      </div>
    </>
  )
}

function BondsSkeleton() {
  return (
    <>
      <ChartSkeleton h={78} />
      <SecTitle title="Rounds" /><ChartSkeleton h={260} />
      <SecTitle title="Implied yield" /><ChartSkeleton h={220} />
      <SecTitle title="Holders" />
      <div className="panel"><table className="tbl"><tbody><TableSkeleton cols={4} rows={6} mobileCols={2} /></tbody></table></div>
    </>
  )
}

function SelectedRound({ d, narrow }: { d: BondDashboard; narrow: boolean }) {
  const r = useSelectedRound(d)
  if (!r) return null
  return (
    <>
      <RoundPicker d={d} r={r} />
      <HoldersSection d={d} r={r} />
      <ActivitySection r={r} narrow={narrow} />
    </>
  )
}

export function Bonds({ family }: { family: string }) {
  const { data, isError, refetch } = useBondDashboard(family)
  const narrow = useMediaQuery(NARROW)
  const now = useNow()
  const fam = bondFamilyUi(family)
  const title = data?.family.title ?? fam?.title ?? 'Bonds'
  useDocumentTitle(title)
  const sym = data?.underlying.symbol ?? family.toUpperCase()
  const appUrl = data?.family.appUrl ?? fam?.appUrl ?? null
  return (
    <div className="wrap ice-page juicer-page bonds-page">
      {appUrl && (
        <div className="ext-link-row">
          <a className="ext-link" href={appUrl} target="_blank" rel="noopener noreferrer">Open in the Hydration app</a>
        </div>
      )}
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Assets', to: paths.assets() }, { label: title }]} />
        <h1 className="page-title">{title} <span className="sub">fixed-yield bonds sold below face, redeemable 1:1 for {sym} at maturity</span></h1>
      </div>
      {!narrow && <Intro narrow={false} d={data} />}
      {isError
        ? <LoadError title={`Couldn’t load the ${title} dashboard`} onRetry={() => { void refetch() }} />
        : !data ? <BondsSkeleton /> : (
          <>
            <Ribbon d={data} />
            {narrow && <Intro narrow d={data} />}
            <div className="ice-asof">
              {data.asOfBlock != null
                ? <>Bond state at <Link to={paths.block(data.asOfBlock)} className="hash">block {F.int(data.asOfBlock)}</Link> · <Ago ts={data.generatedAt} now={now} /></>
                : 'The bond state is unavailable right now (no fresh read).'}
              {' · '}every round over <AssetChip asset={data.underlying} />
            </div>
            {!data.rounds.length ? <div className="pf-card"><div className="hdx-note" style={{ marginTop: 0 }}>{data.asOfBlock == null ? 'The bond state is unavailable right now.' : 'No bond over this asset has been issued yet.'}</div></div> : (
              <>
                <RoundsSection d={data} />
                <YieldSection d={data} narrow={narrow} />
                <FlowSection d={data} narrow={narrow} kind="sold" />
                <FlowSection d={data} narrow={narrow} kind="redeemed" />
                <SelectedRound d={data} narrow={narrow} />
                <AccountsSection d={data} />
              </>
            )}
          </>
        )}
    </div>
  )
}
