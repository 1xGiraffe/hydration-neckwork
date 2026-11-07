import { useEffect, type ReactNode } from 'react'
import { useActivity, useActivityCount, useJuicerDashboard } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useNow } from '../hooks/useNow'
import { Link, paths, setQuery, useQueryValue, usePageParam } from '../router'
import { AddrPill, Ago, AssetAmount, AssetChip, ChartSkeleton, Crumbs, EmptyRow, F, LoadError, Pager, TableSkeleton, Usd, compactAmount } from '../components/ui'
import { ActivityTable } from '../components/ActivityTable'
import { CAT, JUICER_LABELS } from '../components/activityColors'
import { offeredPages } from '../utils/activityPaging'
import { ChartLegend, ShareBar, StackedColumnChart } from '../components/HdxCharts'
import type { ShareSegment, StackColumn } from '../components/HdxCharts'
import { ChartTooltipRow as TipRow, DashboardSectionTitle } from '../components/DashboardPrimitives'
import { monthDayLabel as mdLabel } from '../utils/dashboardDates'
import type { JuicerDashboard, JuicerLoop, JuicerVault } from '../types'
import { UnwindsIn } from '../components/positions/JuicerPositions'
import { JUICER_STATUS_LABEL, JUICER_STATUS_TONE } from '../components/positions/juicerStatus'

// Section titles are the page outline's h2s under its h1.
const SecTitle = (p: { title: string; subtitle?: ReactNode }) => <DashboardSectionTitle {...p} as="h2" />

// Juicer: Hydration's leveraged PRIME-loop strategy (app.hydration.net/strategies/juicer).
// A deposit is supplied to the money market as the vault's collateral position ("Main");
// keepers borrow HOLLAR against it and loop PRIME with that HOLLAR in one shared loop;
// harvests turn the loop's yield back into the deposited asset and compound it into
// every holder's balance. The page states the vault as the official app does — its
// TVL, cap, estimated APY and settings (the API's pinned read of the contracts) — then
// what the indexed history adds: who is in it, what flowed in and out, every withdrawal
// request and every act.

const APP_URL = 'https://app.hydration.net/strategies/juicer'
const NARROW = '(max-width: 720px)'
const ACTIVITY_PAGE = 25
const ACTIVITY_PAGE_NARROW = 10
const POSITIONS_SHOWN = 10
// Fewer days than this read as a table, not a chart (see FlowsSection).
const FLOWS_CHART_MIN_DAYS = 14
const MUTED_SUB = { color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 } as const
const DEPOSIT_COLOR = CAT.juicer
const CLAIM_COLOR = CAT.juicerClaim
const HARVEST_COLOR = CAT.juicerKeeper
const usdTick = (v: number): string => v === 0 ? '$0' : '$' + compactAmount(v)
const bps = (v: number | null | undefined): string => v == null ? '—' : `${(v / 100).toFixed(v % 100 === 0 ? 0 : 1)}%`
const pctOf = (v: number | null | undefined, digits = 2): string => v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}%`
const hf = (v: number | null | undefined): string => v == null || !Number.isFinite(v) ? '—' : v > 100 ? '>100' : v.toFixed(2)
function days(sec: number | null | undefined): string {
  if (sec == null) return '—'
  const d = sec / 86_400
  return Number.isInteger(d) ? `${d} day${d === 1 ? '' : 's'}` : `${(sec / 3600).toFixed(0)} hours`
}

// The juicer-actions the feed filters on: the server's slugs, labelled as the badges.
const JUICER_FILTERS: { v: string; label: string }[] = [
  { v: 'juicer-deposit', label: JUICER_LABELS.Deposit },
  { v: 'juicer-withdraw', label: JUICER_LABELS.Withdraw },
  { v: 'juicer-unwind', label: JUICER_LABELS.Unwind },
  { v: 'juicer-settle', label: JUICER_LABELS.Settle },
  { v: 'juicer-claim', label: JUICER_LABELS.Claim },
  { v: 'juicer-claim-surplus', label: JUICER_LABELS.ClaimSurplus },
  { v: 'juicer-harvest', label: JUICER_LABELS.Harvest },
  { v: 'juicer-rebalance', label: JUICER_LABELS.Rebalance },
  { v: 'juicer-delever', label: JUICER_LABELS.Delever },
  { v: 'juicer-lever', label: JUICER_LABELS.Lever },
  { v: 'juicer-unlever', label: JUICER_LABELS.Unlever },
]
const VAULT_STATUS: Record<JuicerVault['status'], { label: string; tone: string }> = {
  open: { label: 'Open for deposits', tone: 'ok' },
  // A Main borrowing round still deploying: deposit() reverts OutstandingDebt until it completes.
  deploying: { label: 'Deploying — deposits wait', tone: 'pending' },
  full: { label: 'Vault is full', tone: 'pending' },
  paused: { label: 'Deposits paused', tone: 'fail' },
  unavailable: { label: 'State unavailable', tone: '' },
}

function Card({ k, v, s, dot }: { k: string; v: ReactNode; s?: ReactNode; dot?: string }) {
  return (
    <div className="hdx-card">
      <div className="hk">{dot && <i style={{ background: dot }} />}{k}</div>
      <div className="hv">{v}</div>
      {s && <div className="hs">{s}</div>}
    </div>
  )
}

// 0. what this is — the official app's own explanation, its terms and its caveats
function Intro({ narrow }: { narrow: boolean }) {
  const body = (
    <>
      <p className="ice-lede">
        Put the borrowing power of the asset you hold to work. Your deposit is supplied to Hydration’s money market and you receive vault shares; HOLLAR borrowed against it goes into a separate PRIME looping strategy, and harvested yield is converted back into the asset you deposited and compounded into your balance — nothing to claim. You keep exposure to your deposited asset: you do not pair it with another asset in a liquidity pool, so there is no impermanent loss from pool rebalancing, though its dollar value still follows the asset’s price.
      </p>
      <ol className="juicer-steps" aria-label="How Juicer works">
        <li>
          <b>Deposit</b>
          <span>Your asset is supplied to the money market and you receive vault shares. Synthetic backing protects this collateral position while borrowed HOLLAR goes to work in a separate PRIME loop. Keepers build the PRIME position gradually; paying with another asset swaps it into the deposit asset first.</span>
        </li>
        <li>
          <b>Earn</b>
          <span>Juicer converts harvested yield into your deposited asset. After the protocol harvest share and the vault’s borrowing interest, the remainder compounds into your balance; deposited principal is excluded from the harvest fee. Keepers handle harvesting, rebalancing and automatic debt reduction at safety thresholds.</span>
        </li>
        <li>
          <b>Withdraw</b>
          <span>Request a full or partial withdrawal. Your shares stay invested during the cooldown; when the unwind starts it fixes your collateral and your share of the debt, and the exit then bears its own borrowing interest. It settles in parts — claim payouts as they become available. Requests cannot be cancelled, and shared settlement and liquidity affect the final timing.</span>
        </li>
      </ol>
      <p className="juicer-risk">
        Returns vary. Strategy shortfalls or pauses can delay withdrawals; principal protection is denominated in the asset you deposited and depends on correct configuration, reliable oracles and timely maintenance — it is not an unconditional guarantee. The PRIME loop keeps its own liquidation risk. If strategy losses leave a shortfall, unpaid claims remain recorded while governance supplies recovery funding; withdrawals may take longer or be paused, and no fixed recovery deadline is promised.
      </p>
      <details className="ice-gloss">
        <summary>Terms on this page</summary>
        <dl>
          <dt>Est. APY · run-rate</dt><dd>The estimate is the official app’s: the loop at its TARGET leverage. The run-rate is the same arithmetic at the loop’s LIVE leverage and Main’s live LTV — what holders accrue now, negative while the loop is still being built and its carry does not yet cover Main’s interest.</dd>
          <dt>Vault shares</dt><dd>What a deposit mints (jETH for the GETH vault). Funded earnings are added to every holder’s balance, so a share’s exchange rate stays near 1 while balances grow.</dd>
          <dt>Main</dt><dd>The vault’s own position on the money market: the deposited collateral and the HOLLAR borrowed against it, kept inside a band under the collateral’s max LTV.</dd>
          <dt>Synthetic backing</dt><dd>Non-cash collateral the vault supplies beside the deposits to hold Main’s health factor. It adds no borrowing power and cannot repay debt.</dd>
          <dt>PRIME loop</dt><dd>One shared position (the SubLoop) that supplies PRIME, borrows HOLLAR against it and buys more PRIME, up to a target health factor. Its leverage earns the yield, and it can be liquidated; deposits are not in it.</dd>
          <dt>Harvest</dt><dd>Turning the loop’s surplus PRIME into each vault’s collateral, taking the protocol harvest share, paying Main’s HOLLAR interest and compounding the rest. Anyone can trigger it; keepers do.</dd>
          <dt>Protocol harvest share</dt><dd>Discounted HOLLAR borrowing is paired with a governance-configured protocol harvest share: much of the loop’s yield would otherwise pay HOLLAR interest, and this pricing shifts protocol revenue into harvested collateral. Deposited principal is excluded from it.</dd>
          <dt>Cooldown</dt><dd>The earliest a requested withdrawal can start to unwind. The escrowed shares keep earning until then.</dd>
          <dt>Unwind · settle · claim</dt><dd>The unwind fixes the exit’s collateral and its share of Main’s debt; the loop frees HOLLAR to repay that debt and the exit settles in parts; the owner (or a keeper on their behalf) claims each settled part. A finished exit’s later loop proceeds are claimable in HOLLAR as surplus.</dd>
          <dt>Lever · unlever</dt><dd>The loop’s own steps: borrowed HOLLAR sent out as an ICE intent to buy PRIME, or PRIME sold back to repay the loop’s debt.</dd>
        </dl>
      </details>
    </>
  )
  // A phone leads with the figures; the explanation is one tap away.
  if (narrow) return <details className="ice-gloss juicer-intro"><summary>What Juicer is and how it works</summary>{body}</details>
  return body
}

// 1. headline strip
function Ribbon({ d }: { d: JuicerDashboard }) {
  const v = d.vaults[0]
  const holders = d.vaults.reduce((s, x) => s + (x.holders ?? 0), 0)
  const cells: { k: string; v: ReactNode; s?: ReactNode }[] = [
    { k: 'TVL', v: <Usd v={d.totals.tvlUsd} />, s: v?.tvl != null ? <><span className="mono">{F.amount(v.tvl, v.collateral.decimals)}</span> {v.collateral.symbol}</> : 'state unavailable' },
    { k: 'Est. APY', v: pctOf(v?.apyPct), s: <>at target leverage · {v?.runRateApyPct != null ? <>earning <span style={{ color: v.runRateApyPct < 0 ? 'var(--red)' : 'var(--green)' }}>{pctOf(v.runRateApyPct)}</span> now</> : 'run-rate unknown'}</> },
    { k: 'Capacity', v: v?.status === 'full' ? 'Full' : v?.status === 'deploying' ? 'Deploying' : v?.remaining != null ? <><span className="mono">{F.amount(v.remaining, v.collateral.decimals)}</span> {v.collateral.symbol}</> : '—', s: v?.cap != null ? <>of a <span className="mono">{F.amount(v.cap, v.collateral.decimals)}</span> {v.collateral.symbol} cap</> : undefined },
    { k: 'Holders', v: F.int(holders), s: <>{F.int(d.totals.depositors)} ever deposited</> },
    { k: 'Deposited', v: <Usd v={d.totals.depositsUsd} />, s: <>{F.int(d.totals.deposits)} deposits, valued when made</> },
    { k: 'Withdrawals', v: F.int(d.totals.withdrawals), s: <>requests · {F.int(d.totals.claims)} claimed</> },
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

// 2. the vault — capacity, rate, Main and its settings
function VaultSection({ v }: { v: JuicerVault }) {
  const st = VAULT_STATUS[v.status]
  const capSegs: ShareSegment[] = v.tvl != null && v.cap != null ? [
    { key: 'tvl', label: 'Deposited', color: DEPOSIT_COLOR, value: Number(v.tvl), tip: <><span className="t-d">Deposited</span><TipRow label={v.collateral.symbol} value={F.exact(v.tvl, v.collateral.decimals)} /></> },
    { key: 'room', label: 'Room left', color: 'var(--separator)', value: Math.max(0, Number(v.cap) - Number(v.tvl)), tip: <><span className="t-d">Room left</span><TipRow label={v.collateral.symbol} value={F.exact(v.remaining, v.collateral.decimals)} /></> },
  ] : []
  return (
    <>
      <SecTitle title={`${v.name} vault`} subtitle={<>deposit {v.collateral.symbol}, hold {v.shareAsset.symbol} · <span className={`badge ${st.tone}`}>{st.label}</span></>} />
      <div className="pf-card">
        {capSegs.length > 0 && <>
          <ChartLegend items={[{ label: `Deposited ${F.amount(v.tvl, v.collateral.decimals)} ${v.collateral.symbol}`, color: DEPOSIT_COLOR }, { label: `Room ${F.amount(v.remaining, v.collateral.decimals)} ${v.collateral.symbol}`, color: 'var(--separator)' }]} />
          <ShareBar segments={capSegs} h={18} />
        </>}
        <div className="hdx-cards">
          <Card k="TVL" v={<Usd v={v.tvlUsd} />} dot={DEPOSIT_COLOR} s={v.tvl != null ? <><AssetAmount asset={v.collateral} raw={v.tvl} /> supplied as Main’s collateral</> : 'state unavailable'} />
          <Card k="Est. APY" v={pctOf(v.apyPct)} s={<>at the loop’s target leverage, the official estimate · run-rate now {v.runRateApyPct != null ? <span style={{ color: v.runRateApyPct < 0 ? 'var(--red)' : 'var(--text-high)' }}>{pctOf(v.runRateApyPct)}</span> : '—'} at its live leverage{v.deployedFraction != null ? <>; Main borrowing at {F.share(v.deployedFraction)} of target</> : null}</>} />
          <Card k="Main" v={v.main ? <>HF {hf(v.main.healthFactor)}</> : '—'} s={v.main ? <>{F.usd(v.main.collateralUsd)} collateral · {F.usd(v.main.debtUsd)} HOLLAR debt · LTV {v.main.ltv != null ? F.share(v.main.ltv) : '—'}</> : undefined} />
          <Card k="Target LTV" v={bps(v.targetLtvBps)} s={<>relevers under {bps(v.releverLtvBps)}, delevers over {bps(v.deleverLtvBps)} · max {bps(v.maxLtvBps)}, liquidation at {bps(v.liquidationThresholdBps)}</>} />
          <Card k="Protocol harvest share" v={bps(v.protocolFeeBps)} s={<>paired with discounted HOLLAR borrowing (Main {bps(v.mainDiscountBps)} off); deposited principal is excluded</>} />
          <Card k="Withdrawal cooldown" v={days(v.withdrawalDelaySec)} s="the earliest an unwind starts; requests cannot be cancelled" />
        </div>
        {v.main?.syntheticUsd != null && <div className="hdx-note">Main’s collateral above excludes the synthetic backing ({F.usd(v.main.syntheticUsd)}), which holds its health factor but adds no borrowing power. Shares outstanding: <span className="mono">{F.amount(v.sharesOutstanding, v.shareAsset.decimals)}</span> {v.shareAsset.symbol}{v.exchangeRate != null && <>, at {(Number(v.exchangeRate) / 1e18).toFixed(4)} {v.collateral.symbol} each</>}.</div>}
      </div>
    </>
  )
}

// 3. the shared PRIME loop
function LoopSection({ l }: { l: JuicerLoop }) {
  return (
    <>
      <SecTitle title="PRIME loop" subtitle={<>shared by every vault · <AddrPill account={l.account} noCopy /></>} />
      <div className="pf-card">
        <div className="hdx-cards" style={{ marginTop: 0 }}>
          <Card k="Collateral" v={<Usd v={l.collateralUsd} />} s="PRIME supplied to the money market" />
          <Card k="Debt" v={<Usd v={l.debtUsd} />} s={l.borrowRatePct != null ? <>HOLLAR at {pctOf(l.borrowRatePct)}, less a {bps(l.loopDiscountBps)} loop discount</> : 'HOLLAR borrowed'} />
          <Card k="Health factor" v={hf(l.healthFactor)} s={<>target {hf(l.targetHf)} · keepers de-lever at the safety threshold</>} />
          <Card k="Leverage" v={l.leverage != null ? `${l.leverage.toFixed(2)}×` : '—'} s={l.targetLeverage != null ? `${l.targetLeverage.toFixed(2)}× at the target health factor` : undefined} />
          <Card k="PRIME supply APY" v={pctOf(l.primeSupplyApyPct)} s="the money market’s rate plus PRIME’s own yield, the explorer’s yield model" />
          <Card k="Emergency pause" v={l.emergencyPaused == null ? '—' : <span style={{ color: l.emergencyPaused ? 'var(--red)' : 'var(--green)' }}>{l.emergencyPaused ? 'on' : 'off'}</span>} s="freezes deposits, withdrawals and claims on every vault" />
        </div>
        {l.leverage != null && l.targetLeverage != null && l.leverage < l.targetLeverage * 0.5 && (
          <div className="hdx-note">The loop is well under its target leverage: keepers enter PRIME gradually, only while the PRIME/HOLLAR pool trades near the oracle price.</div>
        )}
      </div>
    </>
  )
}

// 4. what flowed — per day since launch
function FlowsSection({ d, narrow }: { d: JuicerDashboard; narrow: boolean }) {
  const rows = d.perDay
  const every = Math.max(1, Math.ceil(rows.length / (narrow ? 5 : 10)))
  const columns: StackColumn[] = rows.map((x, i) => ({
    key: x.day, label: i % every === 0 ? mdLabel(x.day) : '',
    segments: [
      { key: 'deposits', label: 'Deposited', color: DEPOSIT_COLOR, value: x.depositsUsd },
      { key: 'claims', label: 'Claimed', color: CLAIM_COLOR, value: x.claimsUsd },
      { key: 'harvests', label: 'Harvested', color: HARVEST_COLOR, value: x.harvestsUsd },
    ],
    tip: (
      <>
        <span className="t-d">{mdLabel(x.day)}</span>
        <TipRow color={DEPOSIT_COLOR} label="Deposited" value={`${F.usd(x.depositsUsd)} · ${F.int(x.deposits)}`} />
        <TipRow color={CLAIM_COLOR} label="Claimed" value={`${F.usd(x.claimsUsd)} · ${F.int(x.claims)}`} />
        <TipRow color={HARVEST_COLOR} label="Harvested" value={F.usd(x.harvestsUsd)} />
        <TipRow label="Withdrawal requests" value={F.int(x.withdrawals)} />
        <TipRow label="Rebalances" value={F.int(x.rebalances)} />
      </>
    ),
  }))
  const t = d.totals
  return (
    <>
      <SecTitle title="Flows" subtitle="per day since launch · valued when they happened" />
      <div className="pf-card">
        {!rows.length ? <div className="hdx-note" style={{ marginTop: 0 }}>No Juicer activity has been indexed yet.</div>
          // A chart of a few days draws one launch-day bar and slivers — and its scale would
          // clamp the launch to make the rest visible. Until there are enough days to read a
          // trend from, the days are a table.
          : rows.length < FLOWS_CHART_MIN_DAYS ? (
            <div className="panel" style={{ marginTop: 0 }}>
              <table className="tbl">
                <thead><tr><th>Day</th><th className="r">Deposited</th><th className="r">Withdrawal requests</th><th className="r">Claimed</th><th className="r">Harvested</th><th className="r">Rebalances</th></tr></thead>
                <tbody>
                  {[...rows].reverse().map(x => (
                    <tr key={x.day}>
                      <td data-label="Day">{mdLabel(x.day)}</td>
                      <td data-label="Deposited" className="r mono"><Usd v={x.depositsUsd} /> <span className="muted">· {F.int(x.deposits)}</span></td>
                      <td data-label="Withdrawal requests" className="r mono">{F.int(x.withdrawals)}</td>
                      <td data-label="Claimed" className="r mono"><Usd v={x.claimsUsd} /></td>
                      <td data-label="Harvested" className="r mono"><Usd v={x.harvestsUsd} /></td>
                      <td data-label="Rebalances" className="r mono">{F.int(x.rebalances)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <>
            <ChartLegend items={[{ label: 'Deposited', color: DEPOSIT_COLOR }, { label: 'Claimed', color: CLAIM_COLOR }, { label: 'Harvested', color: HARVEST_COLOR }]} />
            <StackedColumnChart columns={columns} h={narrow ? 300 : 180} yFmt={usdTick} />
          </>}
        <div className="hdx-cards">
          <Card k="Deposits" v={<Usd v={t.depositsUsd} />} dot={DEPOSIT_COLOR} s={`${F.int(t.deposits)} deposits by ${F.int(t.depositors)} accounts`} />
          <Card k="Withdrawal requests" v={F.int(t.withdrawals)} s="shares put into escrow for the cooldown; they keep earning until the unwind starts" />
          <Card k="Claimed" v={<Usd v={t.claimsUsd} />} dot={CLAIM_COLOR} s={`${F.int(t.claims)} payouts of settled collateral`} />
          <Card k="Harvested" v={<Usd v={t.harvestsUsd} />} dot={HARVEST_COLOR} s={t.harvests ? `${F.int(t.harvests)} harvests compounded into balances` : 'no harvest yet — the loop is still being built'} />
          <Card k="Rebalances" v={F.int(t.rebalances)} s="keeper borrowing rounds on Main" />
        </div>
        {t.unpricedRows > 0 && <div className="hdx-note">{F.int(t.unpricedRows)} {t.unpricedRows === 1 ? 'act has' : 'acts have'} no price when they happened and {t.unpricedRows === 1 ? 'is' : 'are'} left out of every dollar figure.</div>}
      </div>
    </>
  )
}

// 5. who is in it, and who is on the way out
function PositionsSection({ v }: { v: JuicerVault }) {
  const now = useNow()
  const page = Number(useQueryValue('ppage', '0')) || 0
  const pages = Math.max(1, Math.ceil(v.positions.length / POSITIONS_SHOWN))
  const shown = v.positions.slice(page * POSITIONS_SHOWN, (page + 1) * POSITIONS_SHOWN)
  return (
    <div className="rev-grid juicer-grid">
      <div>
        <SecTitle title="Positions" subtitle={<>largest first · held plus on its way out, funded earnings included</>} />
        <div className="panel">
          <table className="tbl ice-rank">
            <thead><tr><th>Holder</th><th className="r">Position</th><th className="r">Shares</th><th className="r">Share</th></tr></thead>
            <tbody>
              {!shown.length ? <EmptyRow cols={4}>No positions</EmptyRow> : shown.map(p => (
                <tr key={p.account.accountId}>
                  <td data-label="Holder"><AddrPill account={p.account} noCopy /></td>
                  <td data-label="Position" className="r mono">
                    <Usd v={p.totalUsd} />
                    {p.totalAssets != null && <div className="muted" style={{ fontSize: 11 }}>{F.amount(p.totalAssets, v.collateral.decimals)} {v.collateral.symbol}</div>}
                  </td>
                  <td data-label="Shares" className="r mono">
                    <AssetAmount asset={v.shareAsset} raw={p.shares} />
                    {p.inWithdrawal !== '0' && <div className="muted" style={{ fontSize: 11 }}>+ {F.amount(p.inWithdrawal, v.shareAsset.decimals)} in withdrawal</div>}
                  </td>
                  <td data-label="Share" className="r mono muted">{F.share(p.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pages > 1 && <Pager page={page} totalPages={pages} onPage={p => setQuery({ ppage: p > 0 ? String(p) : null })} />}
      </div>
      <div>
        <SecTitle title="Withdrawals" subtitle="every request, newest first · live" />
        <div className="panel">
          <table className="tbl ice-rank">
            <thead><tr><th>Request</th><th>Owner</th><th className="r">Shares</th><th>State</th></tr></thead>
            <tbody>
              {!v.withdrawals.length ? <EmptyRow cols={4}>No withdrawal requests</EmptyRow> : v.withdrawals.map(w => (
                <tr key={w.requestId} id={`juicer-request-${w.requestId}`}>
                  <td data-label="Request" className="mono">#{w.requestId}</td>
                  <td data-label="Owner"><AddrPill account={w.owner} noCopy /></td>
                  <td data-label="Shares" className="r mono">
                    <AssetAmount asset={v.shareAsset} raw={w.shares} />
                    {w.valueUsd != null && <div className="muted" style={{ fontSize: 11 }}>{F.usd(w.valueUsd)}</div>}
                  </td>
                  <td data-label="State">
                    <span className={`badge ${JUICER_STATUS_TONE[w.status]}`}>{JUICER_STATUS_LABEL[w.status]}</span>
                    {w.status === 'cooldown' && w.eligibleAt && <div><UnwindsIn iso={w.eligibleAt} now={now} /></div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// 6. the contracts behind it
function ContractsSection({ d }: { d: JuicerDashboard }) {
  return (
    <>
      <SecTitle title="Contracts" subtitle={<>deployed and configured by governance{d.launchBlock ? <> · first act at <Link to={paths.block(d.launchBlock)} className="hash mono">block {F.int(d.launchBlock)}</Link></> : null}</>} />
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

// 7. every act
function ActivitySection({ narrow }: { narrow: boolean }) {
  const size = narrow ? ACTIVITY_PAGE_NARROW : ACTIVITY_PAGE
  const page = usePageParam()
  const requested = useQueryValue('action', '')
  const action = JUICER_FILTERS.some(a => a.v === requested) ? requested : ''
  const now = useNow()
  const { data, isFetching, isPlaceholderData, error, refetch, anchorRef } = useActivity(size, undefined, undefined, page * size, 'juicer', undefined, action || undefined)
  const { data: count } = useActivityCount('juicer', undefined, undefined, undefined, action || undefined)
  const rows = data ?? []
  const pages = offeredPages({ page, rowsOnPage: rows.length, rowCount: count?.total, maxOffset: count?.maxOffset, pageSize: size })
  return (
    <>
      <div className="sec-title-row">
        <h2 className="sec-title">Juicer activity <span style={MUTED_SUB}>· newest first</span></h2>
        <select className="activity-action" value={action} onChange={e => setQuery({ action: e.target.value || null, page: null })} aria-label="Juicer action">
          <option value="">All actions</option>
          {JUICER_FILTERS.map(a => <option key={a.v} value={a.v}>{a.label}</option>)}
        </select>
      </div>
      <ActivityTable rows={rows} now={now} live={page === 0} anchorRef={anchorRef} loading={isFetching && rows.length === 0} pending={isPlaceholderData} pageSize={size} error={error} onRetry={() => { void refetch() }} />
      <Pager page={page} totalPages={pages.totalPages} hasNext={pages.hasNext} note={pages.note} onPage={p => setQuery({ page: p > 0 ? String(p) : null })} />
    </>
  )
}

function JuicerSkeleton() {
  return (
    <>
      <ChartSkeleton h={78} />
      <SecTitle title="Vault" /><ChartSkeleton h={220} />
      <SecTitle title="Positions" />
      <div className="panel"><table className="tbl"><tbody><TableSkeleton cols={4} rows={6} mobileCols={2} /></tbody></table></div>
    </>
  )
}

export function Juicer() {
  const { data, isError, refetch } = useJuicerDashboard()
  const narrow = useMediaQuery(NARROW)
  const now = useNow()
  useDocumentTitle('Juicer')
  // A request linked from its activity page (#juicer-request-N) is scrolled to once the table exists.
  useEffect(() => {
    const id = window.location.hash.slice(1)
    if (data && id.startsWith('juicer-request-')) document.getElementById(id)?.scrollIntoView({ block: 'center' })
  }, [data])
  return (
    <div className="wrap ice-page juicer-page">
      <div className="ext-link-row">
        <a className="ext-link" href={APP_URL} target="_blank" rel="noopener noreferrer">Open in the Hydration app</a>
      </div>
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Assets', to: paths.assets() }, { label: 'Juicer' }]} />
        <h1 className="page-title">Juicer <span className="sub">earn in your deposited asset with automated PRIME looping</span></h1>
      </div>
      {!narrow && <Intro narrow={false} />}
      {isError
        ? <LoadError title="Couldn’t load the Juicer dashboard" onRetry={() => { void refetch() }} />
        : !data ? <JuicerSkeleton /> : (
          <>
            <Ribbon d={data} />
            {narrow && <Intro narrow />}
            <div className="ice-asof">
              {data.asOfBlock != null
                ? <>Vault state at <Link to={paths.block(data.asOfBlock)} className="hash">block {F.int(data.asOfBlock)}</Link> · <Ago ts={data.generatedAt} now={now} /></>
                : 'The vault’s current state is unavailable right now; its history below still holds.'}
              {data.vaults[0] && <> · <AssetChip asset={data.vaults[0].shareAsset} /> over <AssetChip asset={data.vaults[0].collateral} /></>}
            </div>
            {data.vaults.map(v => <VaultSection key={v.vault.accountId} v={v} />)}
            {data.loop && <LoopSection l={data.loop} />}
            <FlowsSection d={data} narrow={narrow} />
            {data.vaults.map(v => <PositionsSection key={v.vault.accountId} v={v} />)}
            <ActivitySection narrow={narrow} />
            <ContractsSection d={data} />
          </>
        )}
    </div>
  )
}
