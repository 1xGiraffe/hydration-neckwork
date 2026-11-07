import { type ReactNode, useEffect } from 'react'
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
import { LBP_BUY_COLOR, LBP_SELL_COLOR, LBP_SPOT_COLOR, LbpSaleChart, lbpTime } from '../components/LbpSaleChart'
import { BOND_STATUS_LABEL, BOND_STATUS_TONE, bondDate, bondPct as pct } from '../components/positions/bondStatus'
import { bondFamilyUi } from '../bondFamilies'

// Section titles are the page outline's h2s under its h1.
const SecTitle = (p: { title: string; subtitle?: ReactNode }) => <DashboardSectionTitle {...p} as="h2" />

// A bond family's page (/<family>-bonds). The Treasury issues a bond against an
// underlying it locks in the Bonds pallet pot and sells it below face; from maturity any
// holder redeems it 1:1. Two ways of selling share one page, decided from the data (a
// sale's venue), not from the family:
//  - fixed-price OTC offers in face units (the HOLLAR bonds, for USDT and USDC, with a
//    rollover) — the round's fixed yield is the offer's, the APR climbs as maturity nears;
//  - liquidity bootstrapping pools paid in another asset (the HDX bonds, for DOT) — every
//    purchase paid its own price, stated in face units at its own time, so the page gives
//    the average, the discount and the APR as bought, and draws each pool's price curve
//    and fills.
// Then what the index adds: how each sale went, who bought, how quickly the matured
// bonds came back, who holds them and every act on them.

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
/** Whether a round, or any round of the page, sold through an LBP (prices in face units at each purchase's time). */
const lbpRound = (r: BondRound) => r.sales.some(s => s.lbp != null)
const anyLbp = (d: BondDashboard) => d.rounds.some(lbpRound)
/** The assets the money sales took, as symbols ("USDT / USDC", "DOT"). */
const paySymbols = (d: BondDashboard) => [...new Set(d.rounds.flatMap(r => r.sales.filter(s => s.kind === 'sale').map(s => s.paymentAsset.symbol)))].join(' / ')

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
function Intro({ narrow, d, family }: { narrow: boolean; d: BondDashboard | undefined; family: string }) {
  const sym = d?.underlying.symbol ?? family.toUpperCase()
  const lbpPay = d ? (anyLbp(d) ? paySymbols(d) || 'DOT' : null) : bondFamilyUi(family)?.lbpPayment ?? null
  const body = lbpPay != null ? <LbpIntroBody sym={sym} pay={lbpPay} d={d} /> : <OtcIntroBody sym={sym} />
  if (narrow) return <details className="ice-gloss juicer-intro"><summary>What {sym} Bonds are and how they work</summary>{body}</details>
  return body
}
function OtcIntroBody({ sym }: { sym: string }) {
  return (
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
}
function LbpIntroBody({ sym, pay, d }: { sym: string; pay: string; d: BondDashboard | undefined }) {
  // The pools' own terms where the dashboard has them (weights, fees), else the round-one design.
  const lbps = d?.rounds.flatMap(r => r.sales.flatMap(s => (s.lbp ? [s.lbp] : []))) ?? []
  const w0 = lbps[0]?.paymentWeightStart ?? 15, w1 = lbps[0]?.paymentWeightEnd ?? 60
  // "0.5% in round 1 and 2% in round 2", or one figure when every round charged it.
  const feeByRound = d?.rounds.flatMap(r => r.sales.flatMap(x => (x.lbp ? [{ round: r.round, fee: x.lbp.feePct }] : []))) ?? []
  const fees = new Set(feeByRound.map(f => f.fee)).size === 1 ? `${feeByRound[0].fee}%`
    : feeByRound.map(f => `${f.fee}% in round ${f.round}`).join(feeByRound.length === 2 ? ' and ' : ', ')
  return (
    <>
      <p className="ice-lede">
        {sym} Bonds were one-year bonds the Hydration <b>Treasury</b> sold for {pay} in 2023 and 2024. Each bond redeems 1:1 for {sym} from its maturity date; the {sym} that pays it back was locked in the Bonds pallet’s pot the moment the round was issued. Instead of a fixed price, every round was sold through a <b>liquidity bootstrapping pool</b> (LBP): its price started high and fell over the sale window unless buying lifted it, so every purchase paid its own price.
      </p>
      <ol className="juicer-steps bond-steps" aria-label={`How ${sym} Bonds work`}>
        <li>
          <b>Buy</b>
          <span>Governance issued each round — a new bond token maturing a year later — and the Treasury put the bonds and some {pay} into an LBP pool. For one to two days anyone could buy bonds with {pay} (or route another asset through it). The pool’s weights moved from the bonds toward {pay}, {w0}% → {w1}% {pay}, so the price per bond drifted down between purchases{fees ? <>; the pool’s trading fee, {fees}, was charged in {pay} and went to the Treasury</> : null}.</span>
        </li>
        <li>
          <b>Hold</b>
          <span>Bonds are ordinary tokens: they could be sold back into the pool while it ran, transferred, or traded in XYK pools some holders opened. When the window closed the Treasury removed the pool’s liquidity — the unsold bonds and the {pay} came back to it.</span>
        </li>
        <li>
          <b>Redeem</b>
          <span>From maturity, redeem any amount 1:1 for {sym} out of the pot, at any time; nothing is paid automatically.</span>
        </li>
      </ol>
      <p className="juicer-risk">
        Every price, discount and yield on this page is in {sym} <b>at the moment of each purchase</b>: the {pay} a buyer paid (fee included) valued at {pay}’s and {sym}’s hourly prices then, against the {sym} the bond redeems for. That is the return a buyer locked in measured in {sym}; in {pay} or in dollars it also depends on how the two moved since. The pools opened above face, so the earliest buyers paid more than one {sym} per bond and locked in a negative return.
      </p>
      <details className="ice-gloss">
        <summary>Terms on this page</summary>
        <dl>
          <dt>Round</dt><dd>One bond token with one maturity, issued by governance against {sym} it locked in the Bonds pot.</dd>
          <dt>Face</dt><dd>What a bond redeems for at maturity: one {sym}. Amounts of bonds on this page are stated in face.</dd>
          <dt>LBP sale</dt><dd>The pool the Treasury seeded with a round’s bonds and {pay}. Its weights shift from the bonds to {pay} over the sale window (relay-chain blocks), which pulls the price down; a purchase pushes it up, a sell back down.</dd>
          <dt>Bond sold back</dt><dd>A buyer selling bonds back into the pool while the sale ran: the pool paid {pay} out, less its fee, and took the bonds back. Sales and prices on this page are net of them.</dd>
          <dt>Price · discount</dt><dd>What a purchase paid per bond, in {sym} at that moment, and how far below one {sym} that is. A round’s figure is the volume-weighted average over its purchases, net of sells back.</dd>
          <dt>Yield · APR</dt><dd>What holding to maturity returns on that price, and that return annualised (simple) over the time from the purchase to maturity. Each purchase locked in its own; the round states the yield at its average price and the APR as bought, weighted by bonds.</dd>
          <dt>Worth now</dt><dd>What a bond is valued at on this explorer: its sale’s average price while the sale stood, then that price accreting to face by maturity, and face from maturity.</dd>
          <dt>Owed to holders · the Treasury’s own</dt><dd>Bonds issued and not yet redeemed, split between holders outside the Treasury and the Treasury’s own accounts (the bonds its pools did not sell, until it redeemed them).</dd>
          <dt>Bonds pot</dt><dd>The Bonds pallet’s account. It holds the {sym} of every outstanding bond until it is redeemed.</dd>
        </dl>
      </details>
    </>
  )
}

// 1. headline strip — five cells, one line at desktop width
function Ribbon({ d }: { d: BondDashboard }) {
  const now = useNow()
  const live = [...d.rounds].reverse().find(r => r.status === 'selling' || r.status === 'active') ?? d.rounds[d.rounds.length - 1]
  const left = live ? (Date.parse(live.maturityAt) - now) / 1000 : null
  const t = d.totals
  const lbp = live != null && lbpRound(live)
  const cells: { k: string; v: ReactNode; s?: ReactNode }[] = [
    { k: 'Owed to holders', v: <><span className="mono">{F.amount(t.publicOutstanding ?? t.outstanding, d.underlying.decimals)}</span> {d.underlying.symbol}</>, s: <>face · worth <Usd v={t.publicUsd} /> · {t.holders != null ? F.int(t.holders) : '—'} holders</> },
    lbp
      ? { k: `${roundName(live)} · discount`, v: pct(live.discountPct, 2), s: <>{pct(live.fixedYieldPct)} to maturity at the average price · {pct(live.avgAprPct)} APR as bought</> }
      : { k: live ? `${roundName(live)} · fixed yield` : 'Fixed yield', v: pct(live?.fixedYieldPct ?? null, 4), s: live ? <>{pct(live.aprAtOpenPct)} APR from opening, net of fee</> : undefined },
    { k: 'Status', v: live ? <span className={`badge ${BOND_STATUS_TONE[live.status]}`}>{BOND_STATUS_LABEL[live.status]}</span> : '—', s: live ? <>{left != null && left > 0 ? `matures ${bondDate(live.maturityAt)} · ${Math.ceil(left / 86_400)}d` : `matured ${bondDate(live.maturityAt)}`}</> : undefined },
    { k: 'Sold', v: <><span className="mono">{F.amount(t.soldForMoney, d.underlying.decimals)}</span> {d.underlying.symbol}</>, s: anyLbp(d) ? <>for {paySymbols(d)} in LBP sales · {F.int(t.buyers)} buyers</> : <>for {paySymbols(d) || 'money'} · +{F.amount(t.rolledOver, d.underlying.decimals)} rolled</> },
    { k: 'Redeemed', v: <><span className="mono">{F.amount(t.redeemed, d.underlying.decimals)}</span> {d.underlying.symbol}</>, s: <>paid back out of the Bonds pot</> },
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
function LbpSaleProgress({ d, r, s }: { d: BondDashboard; r: BondRound; s: BondSale }) {
  const l = s.lbp!
  const dec = r.asset.decimals
  const sold = num(s.sold, dec), unsold = num(s.unsold, dec), left = num(s.remaining, dec), offered = num(s.offered, dec)
  const color = roundColor(d, r.bondId)
  const pay = s.paymentAsset
  const segs: ShareSegment[] = [
    { key: 'sold', label: 'Sold', color, value: sold, tip: <><span className="t-d">Sold to {F.int(s.buyers)} buyer{s.buyers === 1 ? '' : 's'} in {F.int(s.fills)} fill{s.fills === 1 ? '' : 's'}, net of {F.int(l.sellBacks)} sells back</span><TipRow label="Bonds (face)" value={F.exact(s.sold, dec)} /><TipRow label={`Paid (${pay.symbol}, fees included)`} value={F.exact(s.paid, pay.decimals)} /></> },
    { key: 'left', label: 'In the pool', color: 'var(--text-low)', value: left, tip: <><span className="t-d">Still in the pool</span><TipRow label="Bonds (face)" value={F.exact(s.remaining, dec)} /></> },
    { key: 'unsold', label: 'Unsold', color: UNSOLD_COLOR, value: unsold, tip: <><span className="t-d">Not sold — back with the Treasury{l.returned ? ` on ${bondDate(l.returned.at)}` : ''}</span><TipRow label="Bonds (face)" value={F.exact(s.unsold, dec)} /></> },
  ]
  const share = offered > 0 ? sold / offered * 100 : null
  return (
    <div className="bond-offer">
      <div className="bond-offer-head">
        <span><b>LBP sale for <AssetChip asset={pay} /></b> <AddrPill account={l.pool} noCopy /></span>
        <span className="muted">{F.amount(l.seed.bonds, dec)} bonds + {F.amount(l.seed.payment, pay.decimals)} {pay.symbol} seeded · {pay.symbol} weight {l.paymentWeightStart}% → {l.paymentWeightEnd}% · {l.feePct}% fee{l.startAt && l.endAt ? <> · {lbpTime(Date.parse(l.startAt))} → {lbpTime(Date.parse(l.endAt))} UTC</> : null}</span>
        <span className="mono">{share != null ? `${share.toFixed(1)}% sold · ` : ''}{s.state === 'open' ? 'open' : s.state === 'filled' ? 'sold out' : `closed ${s.endedAt ? bondDate(s.endedAt) : ''}`}</span>
      </div>
      <ShareBar segments={segs} h={12} />
    </div>
  )
}
function SaleProgress({ d, r, s }: { d: BondDashboard; r: BondRound; s: BondSale }) {
  if (s.lbp) return <LbpSaleProgress d={d} r={r} s={s} />
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
      {lbpRound(r) ? <LbpRoundCards d={d} r={r} /> : <div className="hdx-cards" style={{ marginTop: 10 }}>
        <Card k="Fixed yield" v={pct(r.fixedYieldPct, 4)} s={r.fixedYieldPct != null ? <>to maturity, net of the 0.1% fee · {pct(r.aprAtOpenPct)} APR counted from when the sale opened{r.salePrice != null ? <> · {r.salePrice.toFixed(4)} paid per bond</> : null}</> : 'no sale in stablecoins'} />
        <Card k="Issued" v={<Face d={d} raw={r.issued} />} s={<>by <AddrPill account={r.issuer} noCopy /> into the Bonds pot</>} />
        <Card k="Sold for money" dot={roundColor(d, r.bondId)} v={<Face d={d} raw={r.soldForMoney} />} s={<>{r.proceeds.length ? <>raised {r.proceeds.map((p, i) => <span key={p.asset.assetId}>{i > 0 && ' + '}<AssetAmount asset={p.asset} raw={p.raw} /></span>)}</> : 'nothing raised yet'}{r.rolledOver !== '0' ? <> · <Face d={d} raw={r.rolledOver} /> rolled over</> : null} · {F.int(r.buyers)} buyers</>} />
        <Card k="Redeemed" v={<Face d={d} raw={r.redeemed} />} s={r.redemptions ? <>{redeemedPct != null ? `${redeemedPct.toFixed(redeemedPct > 99.9 ? 2 : 1)}% of the issue` : ''} in {F.int(r.redemptions)} redemptions{r.lastRedemptionAt ? <>, the last {bondDate(r.lastRedemptionAt)}</> : null}</> : left > 0 ? 'redeemable from maturity' : 'none yet'} />
        <Card k="Owed to holders" v={<Face d={d} raw={r.publicOutstanding ?? r.outstanding} />} s={r.publicOutstanding != null ? <>face held outside the Treasury · worth <Usd v={r.publicUsd} /> now</> : <>issued less redeemed — the holders do not reconcile at this block, so the split is withheld</>} />
        <Card k="The Treasury’s own" v={<Face d={d} raw={r.issuerHeld} />} s={r.issuerHeld != null ? <>face: unsold bonds and OTC fees{r.rolledOver !== '0' ? ', bonds taken back by a rollover' : ''} · worth <Usd v={r.issuerUsd} />{r.valueFactor != null ? <> · {r.valueFactor >= 1 ? 'at face (matured)' : `${r.valueFactor.toFixed(4)} ${d.underlying.symbol} per bond`}</> : null}</> : 'withheld with the split'} />
      </div>}
      {r.sales.length > 0 && <div className="bond-offers">{r.sales.map(s => <SaleProgress key={`${s.venue}:${s.id}`} d={d} r={r} s={s} />)}</div>}
    </div>
  )
}

// An LBP round: every purchase paid its own price, so the round states the average (in
// face units at each purchase's time), its discount and yield, and the APR as bought.
function LbpRoundCards({ d, r }: { d: BondDashboard; r: BondRound }) {
  const now = useNow()
  const left = (Date.parse(r.maturityAt) - now) / 1000
  const dec = r.asset.decimals
  const sales = r.sales.filter(s => s.lbp)
  const unsold = sales.reduce((a, s) => a + BigInt(s.unsold), 0n).toString()
  const returned = sales.map(s => s.lbp!.returned).find(x => x != null)
  const sellBacks = sales.reduce((a, s) => a + s.lbp!.sellBacks, 0)
  const fees = sales.map(s => ({ asset: s.paymentAsset, raw: s.lbp!.fees }))
  const redeemedPct = num(r.issued, dec) > 0 ? num(r.redeemed, dec) / num(r.issued, dec) * 100 : null
  // The issue fee is charged on what the issuer puts in (issued + fee), as the pallet takes it.
  const feePct = r.issueFee !== '0' ? num(r.issueFee, dec) / (num(r.issued, dec) + num(r.issueFee, dec)) * 100 : null
  return (
    <div className="hdx-cards" style={{ marginTop: 10 }}>
      <Card k="Discount" v={pct(r.discountPct, 2)} s={r.salePrice != null ? <>{r.salePrice.toFixed(4)} {d.underlying.symbol} paid per bond on average, at each purchase’s prices · {pct(r.fixedYieldPct)} to maturity · {pct(r.avgAprPct)} APR as bought</> : 'a purchase could not be priced, so no average is stated'} />
      <Card k="Issued" v={<Face d={d} raw={r.issued} />} s={<>by <AddrPill account={r.issuer} noCopy /> into the Bonds pot{feePct != null ? <> · plus a {Number(feePct.toFixed(2))}% issue fee, <span className="nowrap">{F.amount(r.issueFee, d.underlying.decimals)} {d.underlying.symbol}</span></> : null}</>} />
      <Card k="Sold" dot={roundColor(d, r.bondId)} v={<Face d={d} raw={r.soldForMoney} />} s={<>for {r.proceeds.map((p, i) => <span key={p.asset.assetId} className="nowrap">{i > 0 && ' + '}{F.amount(p.raw, p.asset.decimals)} {p.asset.symbol}</span>)}, the pool’s fees of {fees.map((p, i) => <span key={i} className="nowrap">{i > 0 && ' + '}{F.amount(p.raw, p.asset.decimals)} {p.asset.symbol}</span>)} included · {F.int(r.buyers)} buyers{sellBacks ? ` · ${F.int(sellBacks)} sold back` : ''}</>} />
      <Card k="Unsold" dot={UNSOLD_COLOR} v={<Face d={d} raw={unsold} />} s={returned ? <>back to the Treasury with the pool’s {sales[0].paymentAsset.symbol} on {bondDate(returned.at)}</> : 'still in the pool'} />
      <Card k="Redeemed" v={<Face d={d} raw={r.redeemed} />} s={r.redemptions ? <>{redeemedPct != null ? `${redeemedPct.toFixed(redeemedPct > 99.9 ? 2 : 1)}% of the issue` : ''} in {F.int(r.redemptions)} redemptions{r.lastRedemptionAt ? <>, the last {bondDate(r.lastRedemptionAt)}</> : null}</> : left > 0 ? 'redeemable from maturity' : 'none yet'} />
      <Card k="Owed to holders" v={<Face d={d} raw={r.publicOutstanding ?? r.outstanding} />} s={r.publicOutstanding != null ? <>face held outside the Treasury · worth <Usd v={r.publicUsd} /> now{r.issuerHeld != null && r.issuerHeld !== '0' ? <> · the Treasury’s own <Face d={d} raw={r.issuerHeld} /></> : null}</> : <>issued less redeemed — the holders do not reconcile at this block, so the split is withheld</>} />
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
    // Fixed-price offers only: an LBP's purchases each paid their own price (its own section).
    for (const s of r.sales) if (s.fixedYieldPct != null && s.lbp == null) {
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
          {d.rounds.filter(r => !lbpRound(r)).map(r => {
            const fills = bought.get(r.bondId) ?? []
            const w = fills.reduce((s, f) => s + num(f.bonds), 0)
            const avg = w > 0 ? fills.reduce((s, f) => s + (f.aprPct ?? 0) * num(f.bonds), 0) / w : null
            return <Card key={r.bondId} k={roundName(r)} dot={roundColor(d, r.bondId)} v={pct(r.fixedYieldPct, 4)}
              s={<>fixed · {pct(r.aprAtOpenPct)} APR at the sale’s opening{avg != null ? <>, {pct(avg)} on average as bought</> : null}{r.sales.some(s => s.kind === 'rollover') ? <> · rollover {r.sales.filter(s => s.kind === 'rollover').map(s => pct(s.aprAtOpenPct)).join(' / ')} APR</> : null}</>} />
          })}
        </div>
        <div className="hdx-note">A sale’s price never changes, so its fixed yield is the same for every buyer, while the time left to maturity shrinks: the APR a purchase locked in climbs day by day until the sale closes — the app’s “APR +”. The rollover (dashed) paid in the previous round’s bonds and earns from that round’s maturity on. Yields are on the sales’ own units, one {paySymbols(d) || 'unit'} per {d.underlying.symbol} of face, the way the issuer prices them. Each fixed yield is the order’s exact on-chain terms rounded half-up to four decimals; the app’s quote is set by hand and can differ in the last digit.</div>
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
  // An LBP sale ran a day or two: the LBP chart above shows it fill by fill, so a
  // daily bar chart of it says nothing more.
  if (kind === 'sold' && anyLbp(d)) return null
  if (firstIdx < 0) return kind === 'redeemed' ? (<><SecTitle title={title} /><div className="pf-card"><div className="hdx-note" style={{ marginTop: 0 }}>No bond has been redeemed yet — the first round to mature opens redemptions.</div></div></>) : null
  const from = Math.max(0, firstIdx - (kind === 'redeemed' ? 2 : 0))
  const to = Math.min(d.days.length - 1, lastIdx + 3)
  const rows = d.days.slice(from, to + 1)
  const every = Math.max(1, Math.ceil(rows.length / (narrow ? 4 : 10)))
  // A span that crosses a year names it on every axis label.
  const multiYear = rows.length > 0 && rows[0].day.slice(0, 4) !== rows[rows.length - 1].day.slice(0, 4)
  const axisLabel = (day: string) => (multiYear ? `${mdLabel(day)} ’${day.slice(2, 4)}` : mdLabel(day))
  const shown = d.rounds.filter(r => kind === 'sold' || Date.parse(r.maturityAt) <= now)
  const totals = new Map(d.rounds.map(r => [r.bondId, num(kind === 'sold' ? r.offered : r.issued, dec)]))
  const running = new Map<number, number>()
  for (const x of d.days.slice(0, from)) for (const [id, raw] of Object.entries(x[kind])) running.set(Number(id), (running.get(Number(id)) ?? 0) + num(raw, dec))
  const columns: StackColumn[] = rows.map((x, i) => {
    for (const [id, raw] of Object.entries(x[kind])) running.set(Number(id), (running.get(Number(id)) ?? 0) + num(raw, dec))
    const snap = new Map(running)
    return {
      key: x.day, label: i % every === 0 ? axisLabel(x.day) : '',
      segments: shown.map(r => ({ key: String(r.bondId), label: roundName(r), color: roundColor(d, r.bondId), value: num(x[kind][String(r.bondId)] ?? '0', dec) })),
      tip: (
        <>
          <span className="t-d">{mdLabel(x.day)}, {x.day.slice(0, 4)}</span>
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
      <SecTitle title={title} subtitle={kind === 'sold' ? (anyLbp(d) ? `bonds bought in the LBP sales net of sells back, in ${d.underlying.symbol} face` : `bonds bought in the Treasury’s sales and rollovers, in ${d.underlying.symbol} face`) : `bonds redeemed for ${d.underlying.symbol} per day from maturity`} />
      <div className="pf-card">
        <ChartLegend items={shown.map(r => ({ label: `${roundName(r)}${kind === 'redeemed' ? ` · matured ${bondDate(r.maturityAt)}` : ''}`, color: roundColor(d, r.bondId) }))} />
        {/* Every column at its true height: a bond chart's tallest day (a round's sale, the
            Treasury redeeming what it kept) is the story, never a clamped outlier. */}
        <StackedColumnChart columns={columns} h={narrow ? 300 : 170} yFmt={tick} clamp={false} />
        {kind === 'redeemed' && (
          <div className="hdx-cards">
            {shown.map(r => {
              const issued = num(r.issued, dec), red = num(r.redeemed, dec)
              const m = Date.parse(r.maturityAt)
              let within = 0
              for (const x of d.days) if (Date.parse(x.day + 'T00:00:00Z') <= m + DAY_MS) within += num(x.redeemed[String(r.bondId)] ?? '0', dec)
              return <Card key={r.bondId} k={roundName(r)} dot={roundColor(d, r.bondId)} v={issued > 0 ? `${(red / issued * 100).toFixed(2)}%` : '—'}
                s={<>redeemed of <span className="nowrap">{F.amount(r.issued, dec)} {d.underlying.symbol}</span>; {issued > 0 ? `${(within / issued * 100).toFixed(1)}%` : '—'} by the day after maturity · <span className="nowrap">{F.amount(r.publicOutstanding ?? r.outstanding, dec)} {d.underlying.symbol}</span> still owed to holders</>} />
            })}
          </div>
        )}
        {kind === 'sold' && <div className="hdx-note">Every sale of a round together{d.rounds.some(r => r.rolledOver !== '0') ? ', a rollover included' : ''}; the share of each sale sold is on its round above.</div>}
        {kind === 'redeemed' && <div className="hdx-note">A matured bond redeems 1:1 for {d.underlying.symbol} out of the Bonds pot at any time; nothing is paid automatically. What the Treasury’s own accounts redeemed ({anyLbp(d) ? 'the bonds its pools did not sell' : 'the rollover’s returned bonds'}) counts here too.</div>}
      </div>
    </>
  )
}

// 4b. each LBP sale as it ran — the pool's price curve and every fill
function LbpSection({ d, narrow }: { d: BondDashboard; narrow: boolean }) {
  const rounds = [...d.rounds].reverse().filter(lbpRound)
  if (!rounds.length) return null
  const sym = d.underlying.symbol
  return (
    <>
      <SecTitle title="LBP sales" subtitle={`each round’s pool price over its sale window, in ${sym} per bond at the time, with every purchase and sell back`} />
      {rounds.flatMap(r => r.sales.filter(s => s.lbp).map(s => {
        const l = s.lbp!
        const faces = l.curve.map(c => c.face).filter((v): v is number => v != null)
        const buys = l.fills.filter(f => f.side === 'buy' && f.face != null)
        const below = buys.filter(f => f.face! < 1).reduce((a, f) => a + f.bonds, 0)
        const total = buys.reduce((a, f) => a + f.bonds, 0)
        const withheld = l.reconciled === false || !l.curve.length
        return (
          <div className="pf-card lbp-sale" key={`${r.bondId}:${s.id}`} id={`lbp-round-${r.round}`}>
            <div className="sec-title-row" style={{ marginTop: 0 }}>
              <h3 className="sec-title" style={{ margin: 0 }}>
                <i className="bond-dot" style={{ background: roundColor(d, r.bondId) }} />{roundName(r)} <AssetChip asset={r.asset} />
                {' '}<span style={MUTED_SUB}>· {l.startAt ? lbpTime(Date.parse(l.startAt)) : '—'} → {l.endAt ? lbpTime(Date.parse(l.endAt)) : 'open'} UTC</span>
              </h3>
            </div>
            <ChartLegend items={[
              ...(withheld ? [] : [{ label: `Pool price (${sym} per bond)`, color: LBP_SPOT_COLOR }]),
              { label: 'Purchase', color: LBP_BUY_COLOR },
              ...(l.sellBacks ? [{ label: 'Sold back', color: LBP_SELL_COLOR }] : []),
              { label: `Face · 1 ${sym}`, color: 'var(--text-low)', dashed: true },
            ]} />
            <LbpSaleChart label={roundName(r)} lbp={l} maturityAt={r.maturityAt} faceSymbol={sym} paySymbol={s.paymentAsset.symbol} bondSymbol={r.asset.symbol} narrow={narrow} h={narrow ? 280 : 220} />
            <div className="hdx-cards">
              <Card k="Opened at" v={faces.length ? `${faces[0].toFixed(4)} ${sym}` : '—'} s={<>per bond, the pool’s price at the start{l.curve[0]?.pay != null ? <> · {l.curve[0].pay!.toPrecision(4)} {s.paymentAsset.symbol}</> : null}</>} />
              <Card k="Closed at" v={faces.length ? `${faces[faces.length - 1].toFixed(4)} ${sym}` : '—'} s={<>per bond at the end · low {faces.length ? Math.min(...faces).toFixed(4) : '—'}, high {faces.length ? Math.max(...faces).toFixed(4) : '—'}</>} />
              <Card k="Average paid" v={s.avgFacePrice != null ? `${s.avgFacePrice.toFixed(4)} ${sym}` : '—'} s={<>per bond, net of sells back · {s.avgPrice != null ? `${s.avgPrice.toPrecision(4)} ${s.paymentAsset.symbol}` : '—'} · {pct(s.discountPct, 2)} discount</>} />
              <Card k="APR as bought" v={pct(s.avgAprPct)} s={<>bonds-weighted over {F.int(buys.length)} purchases · {total > 0 ? `${(Math.floor(below / total * 1000) / 10).toFixed(1)}%` : '—'} of the bonds bought below face</>} />
            </div>
            <div className="hdx-note">
              {withheld
                ? <>The pool’s price curve is withheld: replaying its reserves through the fills does not land on what the Treasury took back, so a fill is missing from the index. The fills themselves are shown.</>
                : <>The line is the pool’s price just before and after every fill, from its reserves and its weights at that relay block — a purchase lifts it, the weights’ drift toward {s.paymentAsset.symbol} pulls it down between fills; replaying the reserves through every fill lands exactly on what the Treasury took back. </>}
              {' '}A dot is one fill at the price it paid ({s.lbp!.feePct}% fee included) or, sold back, the price it got; its area is the bonds it moved. Prices are in {sym} at that hour’s {s.paymentAsset.symbol} and {sym} prices, so a dot above the face line paid more than the bond redeems for.
            </div>
          </div>
        )
      }))}
    </>
  )
}

// 5. the round the buyers, holders and activity below show — one page-level selector
function RoundPicker({ d, r }: { d: BondDashboard; r: BondRound }) {
  return (
    <div className="bond-round-picker">
      <span className="muted">Buyers, holders and activity of</span>
      <div className="seg-bar" role="group" aria-label="Round shown below">
        {[...d.rounds].reverse().map(x => (
          <button key={x.bondId} type="button" className={`seg-btn${x.bondId === r.bondId ? ' active' : ''}`} aria-pressed={x.bondId === r.bondId}
            onClick={() => setQuery({ round: x.round === d.rounds[d.rounds.length - 1].round ? null : String(x.round), page: null, hpage: null, bpage: null })}>
            {roundName(x)} · {bondDate(x.maturityAt)}
          </button>
        ))}
      </div>
    </div>
  )
}

// 5b. who bought the selected round in its sales
const BUYERS_SHOWN = 10
function BuyersSection({ d, r }: { d: BondDashboard; r: BondRound }) {
  const page = Number(useQueryValue('bpage', '0')) || 0
  const b = r.buyerStats
  if (!b || !b.purchases) return null
  const pages = Math.max(1, Math.ceil(b.top.length / BUYERS_SHOWN))
  const shown = b.top.slice(page * BUYERS_SHOWN, (page + 1) * BUYERS_SHOWN)
  const lbp = lbpRound(r)
  return (
    <>
      <SecTitle title="Buyers" subtitle={<>{roundName(r)} · who bought it in its {lbp ? 'LBP sale, by bonds kept' : 'sales, by bonds bought'}{b.top.length < b.buyers ? ` · the ${F.int(b.top.length)} largest of ${F.int(b.buyers)}` : ''}</>} />
      <div className="hdx-cards bond-buyer-cards">
        <Card k="Buyers" v={F.int(b.buyers)} s={<>in {F.int(b.purchases)} purchases{lbp && b.sellers ? <> · {F.int(b.sellers)} sold some back</> : null}</>} />
        <Card k="Median purchase" v={<Face d={d} raw={b.medianPurchase} />} s={<>largest <Face d={d} raw={b.largestPurchase} /></>} />
        <Card k="Top 10 buyers" v={F.share(b.top10SharePct != null ? b.top10SharePct / 100 : null)} s="of the bonds the sales sold" />
      </div>
      <div className="panel">
        <table className="tbl ice-rank">
          <thead><tr><th>Buyer</th><th className="r">{lbp ? 'Bonds kept' : 'Bonds bought'}</th><th className="r">Fills</th><th className="r">Paid</th><th className="r">Price</th><th className="r">APR</th></tr></thead>
          <tbody>
            {!shown.length ? <EmptyRow cols={6}>No purchases</EmptyRow> : shown.map(x => (
              <tr key={x.account.accountId}>
                <td data-label="Buyer"><AddrPill account={x.account} noCopy /></td>
                <td data-label={lbp ? 'Bonds kept' : 'Bonds bought'} className="r mono"><Face d={d} raw={x.bonds} /></td>
                <td data-label="Fills" className="r mono">{F.int(x.fills)}</td>
                <td data-label="Paid" className="r mono">{x.paid.length ? x.paid.map(p => <div key={p.asset.assetId}><AssetAmount asset={p.asset} raw={p.raw} /></div>) : '—'}</td>
                <td data-label="Price" className="r mono">{x.facePrice != null ? `${x.facePrice.toFixed(4)} ${d.underlying.symbol}` : '—'}</td>
                <td data-label="APR" className="r mono">{pct(x.aprPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && <Pager page={page} totalPages={pages} onPage={p => setQuery({ bpage: p > 0 ? String(p) : null })} />}
      <div className="hdx-note">
        {lbp
          ? <>Bonds kept are what an account bought less what it sold back into the pool, and what it paid is net the same way. Price is per bond received, in {d.underlying.symbol} at each purchase’s prices, and the APR is the one its purchases locked in, weighted by bonds.</>
          : <>Bonds bought are received net of the 0.1% OTC fee, a rollover’s included. Price is per bond received, net of the fee, and the APR is the one its purchases locked in, weighted by bonds.</>}
      </div>
    </>
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
      <div className="hdx-note">{lbpRound(r)
        ? <>The Treasury’s accounts fold into one row: they held the bonds its LBP sale did not sell from the day it emptied the pool until it redeemed them. The pool itself held the unsold ones while the sale ran.</>
        : <>The Treasury’s accounts fold into one row: they hold what its sales did not sell, the 0.1% OTC fees and, after a rollover, the older round’s bonds it took back.</>} Bonds held through a bound EVM address count as their account’s.</div>
    </>
  )
}

// 7. every act on the selected round's bond
interface ActKind { v: string; label: string; type: string; action?: string }
/** The kinds of act a round's activity filter offers: a rollover only where a sale was one, a sell back only where an LBP sold it. */
function bondActivityKinds(d: Pick<BondDashboard, 'rounds'>): ActKind[] {
  const sales = d.rounds.flatMap(r => r.sales)
  return [
    { v: '', label: 'Every act', type: 'all' },
    { v: 'purchases', label: 'Purchases', type: 'bond', action: 'Purchase' },
    ...(sales.some(s => s.kind === 'rollover') ? [{ v: 'rollovers', label: 'Rollovers', type: 'bond', action: 'Rollover' }] : []),
    ...(sales.some(s => s.lbp != null) ? [{ v: 'sellbacks', label: 'Sells back', type: 'bond', action: 'SellBack' }] : []),
    { v: 'transfers', label: 'Transfers', type: 'transfer' },
    { v: 'redemptions', label: 'Redemptions', type: 'bond', action: 'Redeem' },
  ]
}
function ActivitySection({ d, r, narrow }: { d: BondDashboard; r: BondRound; narrow: boolean }) {
  const now = useNow()
  const page = usePageParam()
  const size = narrow ? ACTIVITY_PAGE_NARROW : ACTIVITY_PAGE
  const kindParam = useQueryValue('kind', '')
  const KINDS = bondActivityKinds(d)
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

function BondsSkeleton({ lbp }: { lbp: boolean }) {
  return (
    <>
      <ChartSkeleton h={78} />
      <SecTitle title="Rounds" /><ChartSkeleton h={260} />
      <SecTitle title={lbp ? 'LBP sales' : 'Implied yield'} /><ChartSkeleton h={220} />
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
      <BuyersSection d={d} r={r} />
      <HoldersSection d={d} r={r} />
      <ActivitySection d={d} r={r} narrow={narrow} />
    </>
  )
}

export function Bonds({ family }: { family: string }) {
  const { data, isError, refetch } = useBondDashboard(family)
  // A round linked from elsewhere (an activity page's #round-N, an LBP's #lbp-round-N)
  // is scrolled to once the page holds it: the router lands a new page at the top.
  const hash = typeof window === 'undefined' ? '' : window.location.hash
  useEffect(() => {
    const id = hash.slice(1)
    if (data && /^(lbp-)?round-\d+$/.test(id)) document.getElementById(id)?.scrollIntoView({ block: 'start' })
  }, [data, hash])
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
        <h1 className="page-title">{title} <span className="sub">{(data ? anyLbp(data) : bondFamilyUi(family)?.lbpPayment != null) ? `one-year bonds sold through LBPs, redeemable 1:1 for ${sym} at maturity` : `fixed-yield bonds sold below face, redeemable 1:1 for ${sym} at maturity`}</span></h1>
      </div>
      {!narrow && <Intro narrow={false} d={data} family={family} />}
      {isError
        ? <LoadError title={`Couldn’t load the ${title} dashboard`} onRetry={() => { void refetch() }} />
        : !data ? <BondsSkeleton lbp={bondFamilyUi(family)?.lbpPayment != null} /> : (
          <>
            <Ribbon d={data} />
            {narrow && <Intro narrow d={data} family={family} />}
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
                <LbpSection d={data} narrow={narrow} />
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
