import { cached } from './cache.ts'
import { BOND_TERMS, currentPriceOf, displayDescriptor, type ExplorerAsset } from './explorerAssets.ts'
import { accountRef, ensurePrices, getHolders, resolveRelatedAccounts, type AccountRef, type HolderRow, type PriceInfo } from './explorerService.ts'
import {
  BOND_FAMILIES, BONDS_POT_ACCOUNT, bondFamily, bondStatus, bondValueFactorWad, familyRounds, fillYield, isMoneySale, otcFillFee, rescale, saleProgress, salePriceWad, wadNumber,
  type BondFamily, type BondSale, type BondSaleKind, type BondSaleVenue, type BondStatus, type BondTerms,
} from './bonds.ts'
import { bondIssuerAccounts, bondSupplies, currentBondSnapshot, refreshBondState, type BondSnapshot } from './bondState.ts'
import { rawUsd, strategyDashboardCache, type StrategyDashboardCache } from './strategyDashboard.ts'

// A bond family's page (/explorer/bonds/:family — one per bonds.ts BOND_FAMILIES entry)
// and an account's bond positions (/explorer/address/:a/bonds). Two sources, each for
// what it can state:
//  - the CURRENT state — supply, what the issuer side and the public hold, each sale
//    source's progress, the pot — from the bond refresher's snapshot (bondState.ts),
//    valued at current prices (a bond by the bond rule, bonds.ts); absent (null) when the
//    snapshot is stale, never a zero;
//  - the terms and the HISTORY — every round's issue, its sale sources and every fill,
//    the yield each fill locked in, the redemptions — from the same snapshot's indexed
//    rows, in the sources' own face units (bonds.ts DOLLAR_FACE_UNITS).
// Every sale view is venue-agnostic (bonds.ts BondSale): an OTC offer today, an LBP pool
// for the HDX bonds. The holder lists are the asset page's own (getHolders), so a round's
// holders here and on its asset page are one list. Built off the request path and
// served stale-while-revalidate (strategyDashboardCache), one cache per family.

const TOP_HOLDERS = 25
const DAY_MS = 86_400_000

export interface BondFillDay {
  day: string
  bondId: number
  kind: BondSaleKind
  fills: number
  /** Bonds released that day (raw, the venue's fee included) and what was paid for them (raw, the source's payment asset). */
  bonds: string
  paid: string
  /** The bonds-weighted yield the day's fills locked in, held to maturity. */
  returnPct: number | null
  aprPct: number | null
}
export interface BondSaleView {
  venue: BondSaleVenue
  id: string
  kind: BondSaleKind
  paymentAsset: ExplorerAsset
  /** For a rollover, the round its payment bonds are. */
  fromRound: number | null
  issuerAccounts: AccountRef[]
  openedAt: string
  openedBlock: number
  endedAt: string | null
  state: 'open' | 'filled' | 'closed'
  /** A fixed-terms source's size (raw, the fee included); null for a venue without one. */
  offered: string | null
  /** Bonds released (raw, the fee included), paid for them (raw, payment asset) and what buyers received (raw). */
  sold: string
  paid: string
  net: string
  remaining: string
  unsold: string
  fills: number
  buyers: number
  /** The source's own price per face unit, net of the fee (a fixed-terms source's ask); its discount to face and the fixed return it pays to maturity; that return annualised from when the source opened. */
  price: number | null
  discountPct: number | null
  fixedYieldPct: number | null
  aprAtOpenPct: number | null
  /** What buyers actually paid per bond received, net of the fee (volume-weighted). */
  avgPrice: number | null
}
export interface BondRoundView {
  round: number
  bondId: number
  asset: ExplorerAsset
  status: BondStatus
  issuer: AccountRef
  createdAt: string
  createdBlock: number
  maturityAt: string
  issued: string
  issueFee: string
  sales: BondSaleView[]
  /** Offered by fixed-terms sources; released for money (the bond's face sold for new money) and for older bonds (rolled over). */
  offered: string
  soldForMoney: string
  rolledOver: string
  /** What the money sales raised, per payment asset (raw). */
  proceeds: Array<{ asset: ExplorerAsset; raw: string }>
  /** The money sale's fixed yield — its price's return to maturity — and that return as an APR from when it opened, as the app quotes it. */
  fixedYieldPct: number | null
  aprAtOpenPct: number | null
  /** Where the money sale priced the bond (net of the fee) and whether a money source still sells it (bonds.ts saleAnchor). */
  salePrice: number | null
  saleOpen: boolean
  redeemed: string
  redemptions: number
  firstRedemptionAt: string | null
  lastRedemptionAt: string | null
  /** Issued − redeemed. */
  outstanding: string
  /** Of it, held by the issuer side (unsold, fees, bonds taken back by a rollover) and by everyone else; null when the holders do not sum to the supply. */
  issuerHeld: string | null
  publicOutstanding: string | null
  /** What one bond is worth now in the underlying (the bond rule), and the public's and the issuer side's bonds at it. */
  valueFactor: number | null
  publicUsd: number | null
  issuerUsd: number | null
  holders: { list: HolderRow[]; total: number; holderCount: number; totalUsd: number } | null
  buyers: number
}
export interface BondDayView { day: string; sold: Record<string, string>; redeemed: Record<string, string> }
export interface BondDashboard {
  generatedAt: string
  asOfBlock: number | null
  family: { key: string; title: string; appUrl: string | null }
  underlying: ExplorerAsset
  rounds: BondRoundView[]
  fillDays: BondFillDay[]
  days: BondDayView[]
  totals: {
    issued: string; soldForMoney: string; rolledOver: string; redeemed: string; outstanding: string
    /** Face the public holds and what it is worth now; null when a round's holders do not reconcile. */
    publicOutstanding: string | null; publicUsd: number | null
    holders: number | null; buyers: number; fills: number
  }
  pot: { account: AccountRef; balance: string | null; outstanding: string; reconciled: boolean | null }
  accounts: Array<{ role: string; account: AccountRef }>
}

const asset = (id: number): ExplorerAsset => displayDescriptor(id)
const iso = (ms: number) => new Date(ms).toISOString()
const dayOf = (ms: number) => iso(ms).slice(0, 10)
/** A fill's weight in a bonds-weighted mean: the bonds it delivered, in whole units of the bond. */
const weightOf = (net: bigint, decimals: number): number => Number(net) / 10 ** decimals

/** A fixed-terms source's price, discount, fixed yield and APR from when it opened. */
export function saleTerms(s: Pick<BondSale, 'offered' | 'asked' | 'openedMs' | 'paymentAssetId' | 'bondId'>, t: Pick<BondTerms, 'maturityMs'>, decimalsOf: (id: number) => number, isRollover: boolean): Pick<BondSaleView, 'price' | 'discountPct' | 'fixedYieldPct' | 'aprAtOpenPct'> {
  if (s.offered == null || s.asked == null) return { price: null, discountPct: null, fixedYieldPct: null, aprAtOpenPct: null }
  const offered = BigInt(s.offered), asked = BigInt(s.asked)
  const p = salePriceWad(asked, decimalsOf(s.paymentAssetId), offered, decimalsOf(s.bondId))
  const paidMaturity = BOND_TERMS.get(s.paymentAssetId)?.maturityMs ?? null
  const y = fillYield({ paid: asked, paidDecimals: decimalsOf(s.paymentAssetId), net: offered - otcFillFee(offered), bondDecimals: decimalsOf(s.bondId), atMs: s.openedMs, maturityMs: t.maturityMs, paidMaturityMs: paidMaturity })
  return {
    price: p == null ? null : wadNumber(p),
    discountPct: p == null || isRollover ? null : Math.round((1 - wadNumber(p)) * 1e6) / 1e4,
    fixedYieldPct: y?.returnPct ?? null,
    aprAtOpenPct: y?.aprPct ?? null,
  }
}

/** The per-day yield of a bond's fills, bonds-weighted (pure, for the tests). */
export function fillDaysOf(sales: readonly BondSale[], terms: ReadonlyMap<number, BondTerms>, decimalsOf: (id: number) => number): BondFillDay[] {
  const acc = new Map<string, { day: string; bondId: number; kind: BondSaleKind; fills: number; bonds: bigint; paid: bigint; wr: number; wa: number; w: number; wA: number }>()
  for (const s of sales) {
    const t = terms.get(s.bondId)
    if (!t) continue
    const paidMaturity = terms.get(s.paymentAssetId)?.maturityMs ?? null
    for (const f of s.fills) {
      const key = `${dayOf(f.atMs)}:${s.bondId}:${s.kind}`
      const a = acc.get(key) ?? acc.set(key, { day: dayOf(f.atMs), bondId: s.bondId, kind: s.kind, fills: 0, bonds: 0n, paid: 0n, wr: 0, wa: 0, w: 0, wA: 0 }).get(key)!
      const net = BigInt(f.bonds) - BigInt(f.fee)
      const y = fillYield({ paid: BigInt(f.paid), paidDecimals: decimalsOf(s.paymentAssetId), net, bondDecimals: decimalsOf(s.bondId), atMs: f.atMs, maturityMs: t.maturityMs, paidMaturityMs: paidMaturity })
      const weight = weightOf(net, decimalsOf(s.bondId))
      a.fills++
      a.bonds += BigInt(f.bonds)
      a.paid += BigInt(f.paid)
      if (y) { a.wr += y.returnPct * weight; a.w += weight; if (y.aprPct != null) { a.wa += y.aprPct * weight; a.wA += weight } }
    }
  }
  return [...acc.values()].sort((x, y) => x.day.localeCompare(y.day) || x.bondId - y.bondId || x.kind.localeCompare(y.kind)).map(a => ({
    day: a.day, bondId: a.bondId, kind: a.kind, fills: a.fills, bonds: a.bonds.toString(), paid: a.paid.toString(),
    returnPct: a.w > 0 ? a.wr / a.w : null, aprPct: a.wA > 0 ? a.wa / a.wA : null,
  }))
}

/** A family's rounds (bonds.ts familyRounds over the registry: every bond over its underlying ever issued). */
function familyBonds(f: BondFamily): BondTerms[] {
  return familyRounds(BOND_TERMS.values(), f.underlyingId)
}
/** Whether any primary-sale source still sells the bond (bonds.ts saleProgress: the one open/closed rule). */
const anySaleOpen = (sales: readonly BondSale[], t: BondTerms, nowMs: number): boolean =>
  sales.some(s => s.bondId === t.bondId && saleProgress(s, t.maturityMs, nowMs).state === 'open')

function saleView(s: BondSale, t: BondTerms, nowMs: number): BondSaleView {
  const p = saleProgress(s, t.maturityMs, nowMs)
  const decimalsOf = (id: number) => asset(id).decimals
  const avg = p.net > 0n ? rescale(p.paid, decimalsOf(s.paymentAssetId), decimalsOf(s.bondId)) * 10n ** 18n / p.net : null
  const fromTerms = BOND_TERMS.get(s.paymentAssetId)
  const fromRound = fromTerms ? familyRounds(BOND_TERMS.values(), fromTerms.underlyingId).findIndex(x => x.bondId === s.paymentAssetId) + 1 || null : null
  return {
    venue: s.venue, id: s.id, kind: s.kind, paymentAsset: asset(s.paymentAssetId), fromRound,
    issuerAccounts: s.issuerAccounts.map(accountRef),
    openedAt: iso(s.openedMs), openedBlock: s.openedBlock, endedAt: p.endedMs != null ? iso(p.endedMs) : null, state: p.state,
    offered: s.offered, sold: p.sold.toString(), paid: p.paid.toString(), net: p.net.toString(),
    remaining: p.remaining.toString(), unsold: p.unsold.toString(),
    fills: s.fills.length, buyers: new Set(s.fills.map(f => f.taker)).size,
    ...saleTerms(s, t, decimalsOf, s.kind === 'rollover'),
    avgPrice: avg != null ? wadNumber(avg) : null,
  }
}

async function roundView(round: number, t: BondTerms, snap: BondSnapshot, prices: Map<number, PriceInfo>, nowMs: number): Promise<BondRoundView> {
  const bond = asset(t.bondId)
  const sales = snap.sales.filter(s => s.bondId === t.bondId)
  const views = sales.map(s => saleView(s, t, nowMs))
  const issues = snap.issues.filter(i => i.bondId === t.bondId)
  const reds = snap.redemptions.filter(r => r.bondId === t.bondId).sort((a, b) => a.block - b.block)
  const issued = issues.reduce((s, i) => s + BigInt(i.amount), 0n)
  const redeemed = reds.reduce((s, r) => s + BigInt(r.amount), 0n)
  const outstanding = issued - redeemed
  const issuerAccounts = bondIssuerAccounts(t.bondId, t.issuer, snap.sales)
  const holdings = snap.holdings.get(t.bondId) ?? new Map<string, bigint>()
  const reconciled = snap.holdersReconciled.get(t.bondId) === true
  const issuerHeld = [...holdings].filter(([a]) => issuerAccounts.has(a)).reduce((s, [, v]) => s + v, 0n)
  const publicOutstanding = reconciled ? outstanding - issuerHeld : null
  const money = views.filter(v => isMoneySale(sales.find(s => s.id === v.id && s.venue === v.venue)!, t.underlyingId))
  const proceeds = new Map<number, bigint>()
  for (const v of money) proceeds.set(v.paymentAsset.assetId, (proceeds.get(v.paymentAsset.assetId) ?? 0n) + BigInt(v.paid))
  const sum = (list: BondSaleView[], pick: (v: BondSaleView) => string | null) => list.reduce((s, v) => s + BigInt(pick(v) ?? '0'), 0n).toString()
  const factor = bondValueFactorWad(t, nowMs)
  // The round's fixed yield is its money sale's (the first, the lowest price, when several).
  const headline = [...money].filter(v => v.fixedYieldPct != null).sort((a, b) => (b.fixedYieldPct ?? 0) - (a.fixedYieldPct ?? 0))[0]
  const holders = await getHolders(t.bondId, TOP_HOLDERS, 0).catch(() => null)
  return {
    round, bondId: t.bondId, asset: bond,
    status: bondStatus({ nowMs, maturityMs: t.maturityMs, openSale: anySaleOpen(sales, t, nowMs), publicOutstanding: publicOutstanding ?? outstanding }),
    issuer: accountRef(t.issuer), createdAt: iso(t.createdMs), createdBlock: t.createdBlock, maturityAt: iso(t.maturityMs),
    issued: issued.toString(), issueFee: issues.reduce((s, i) => s + BigInt(i.fee), 0n).toString(),
    sales: views,
    offered: sum(views, v => v.offered),
    soldForMoney: sum(money, v => v.sold),
    rolledOver: sum(views.filter(v => v.kind === 'rollover'), v => v.sold),
    proceeds: [...proceeds].map(([id, raw]) => ({ asset: asset(id), raw: raw.toString() })),
    fixedYieldPct: headline?.fixedYieldPct ?? null,
    aprAtOpenPct: headline?.aprAtOpenPct ?? null,
    salePrice: t.anchor ? wadNumber(t.anchor.priceWad) : null,
    saleOpen: anySaleOpen(sales.filter(s => isMoneySale(s, t.underlyingId)), t, nowMs),
    redeemed: redeemed.toString(), redemptions: reds.length,
    firstRedemptionAt: reds.length ? iso(reds[0].atMs) : null, lastRedemptionAt: reds.length ? iso(reds[reds.length - 1].atMs) : null,
    outstanding: outstanding.toString(),
    issuerHeld: reconciled ? issuerHeld.toString() : null,
    publicOutstanding: publicOutstanding?.toString() ?? null,
    valueFactor: factor != null ? wadNumber(factor) : null,
    publicUsd: publicOutstanding != null ? rawUsd(prices, t.bondId, publicOutstanding) : null,
    issuerUsd: reconciled ? rawUsd(prices, t.bondId, issuerHeld) : null,
    holders: holders ? { list: holders.holders, total: holders.total, holderCount: holders.holderCount, totalUsd: holders.totalUsd } : null,
    buyers: new Set(sales.flatMap(s => s.fills.map(f => f.taker))).size,
  }
}

/** Per day from the first sale to today: bonds sold and redeemed per round (raw). */
export function bondDays(bondIds: readonly number[], snap: Pick<BondSnapshot, 'sales' | 'redemptions'>, nowMs: number): BondDayView[] {
  const ids = new Set(bondIds)
  const sold = new Map<string, Map<number, bigint>>(), red = new Map<string, Map<number, bigint>>()
  const add = (m: Map<string, Map<number, bigint>>, day: string, id: number, v: bigint) => {
    const d = m.get(day) ?? m.set(day, new Map()).get(day)!
    d.set(id, (d.get(id) ?? 0n) + v)
  }
  let first: number | null = null
  for (const s of snap.sales) if (ids.has(s.bondId)) for (const f of s.fills) { add(sold, dayOf(f.atMs), s.bondId, BigInt(f.bonds)); first = Math.min(first ?? f.atMs, f.atMs) }
  for (const r of snap.redemptions) if (ids.has(r.bondId)) { add(red, dayOf(r.atMs), r.bondId, BigInt(r.amount)); first = Math.min(first ?? r.atMs, r.atMs) }
  if (first == null) return []
  const out: BondDayView[] = []
  const rec = (m: Map<number, bigint> | undefined) => Object.fromEntries([...(m ?? [])].map(([k, v]) => [String(k), v.toString()]))
  for (let t = Date.parse(dayOf(first) + 'T00:00:00Z'); t <= nowMs; t += DAY_MS) {
    const day = dayOf(t)
    out.push({ day, sold: rec(sold.get(day)), redeemed: rec(red.get(day)) })
  }
  return out
}

async function buildBondDashboard(f: BondFamily, snap: BondSnapshot | null): Promise<BondDashboard> {
  const prices = await ensurePrices()
  const nowMs = Date.now()
  const underlying = asset(f.underlyingId)
  const family = { key: f.key, title: f.title, appUrl: f.appUrl }
  const pot = { account: accountRef(BONDS_POT_ACCOUNT), balance: null as string | null, outstanding: '0', reconciled: null as boolean | null }
  if (!snap) {
    return {
      generatedAt: iso(nowMs), asOfBlock: null, family, underlying, rounds: [], fillDays: [], days: [],
      totals: { issued: '0', soldForMoney: '0', rolledOver: '0', redeemed: '0', outstanding: '0', publicOutstanding: null, publicUsd: null, holders: null, buyers: 0, fills: 0 },
      pot, accounts: [],
    }
  }
  const bonds = familyBonds(f)
  const rounds: BondRoundView[] = []
  for (const [i, t] of bonds.entries()) rounds.push(await roundView(i + 1, t, snap, prices, nowMs))
  const ids = bonds.map(t => t.bondId)
  const sales = snap.sales.filter(s => ids.includes(s.bondId))
  const supplies = bondSupplies(snap.issues, snap.redemptions)
  const outstanding = ids.reduce((s, id) => s + (supplies.get(id) ?? 0n), 0n)
  const sum = (pick: (r: BondRoundView) => string | null): string | null => rounds.some(r => pick(r) == null) ? null : rounds.reduce((s, r) => s + BigInt(pick(r)!), 0n).toString()
  const usd = rounds.map(r => r.publicUsd)
  // Distinct holders across rounds outside the issuer side: an account holding two rounds counts once.
  const issuer = new Set(ids.flatMap(id => [...bondIssuerAccounts(id, BOND_TERMS.get(id)?.issuer, snap.sales)]))
  const holderSet = new Set(ids.flatMap(id => [...(snap.holdings.get(id)?.keys() ?? [])].filter(a => !issuer.has(a))))
  const issuers = [...new Set(bonds.map(t => t.issuer))]
  const sellers = [...new Set(sales.flatMap(s => s.issuerAccounts))].filter(a => !issuers.includes(a))
  return {
    generatedAt: iso(nowMs), asOfBlock: snap.block, family, underlying, rounds,
    fillDays: fillDaysOf(sales, BOND_TERMS, id => asset(id).decimals),
    days: bondDays(ids, snap, nowMs),
    totals: {
      issued: sum(r => r.issued) ?? '0', soldForMoney: sum(r => r.soldForMoney) ?? '0', rolledOver: sum(r => r.rolledOver) ?? '0',
      redeemed: sum(r => r.redeemed) ?? '0', outstanding: outstanding.toString(),
      publicOutstanding: sum(r => r.publicOutstanding), publicUsd: usd.some(v => v == null) ? null : usd.reduce<number>((a, v) => a + (v ?? 0), 0),
      holders: holderSet.size, buyers: new Set(sales.flatMap(s => s.fills.map(x => x.taker))).size, fills: sales.reduce((s, x) => s + x.fills.length, 0),
    },
    pot: { ...pot, balance: snap.pot.get(f.underlyingId)?.toString() ?? null, outstanding: outstanding.toString(), reconciled: snap.potReconciled.get(f.underlyingId) ?? null },
    accounts: [
      ...issuers.map(a => ({ role: 'Issuer — issued the bonds against its own underlying', account: accountRef(a) })),
      ...sellers.map(a => ({ role: 'Sale account — the sales’ issuer side, holds what went unsold', account: accountRef(a) })),
      { role: `Bonds pot — holds the ${underlying.symbol} owed to every outstanding bond`, account: accountRef(BONDS_POT_ACCOUNT) },
    ],
  }
}

const dashboards = new Map<string, StrategyDashboardCache<BondDashboard>>(BOND_FAMILIES.map(f => [f.key, strategyDashboardCache({
  name: `bonds:${f.key}`, key: `explorer:bonds-dashboard:${f.key}`, snapshot: () => currentBondSnapshot(), build: snap => buildBondDashboard(f, snap),
})]))
/**
 * Boot: the bond state is ClickHouse-only and cheap, so it is read once here — after the
 * asset registry, before the dashboards' first build and before the api listens — rather
 * than waiting its turn behind the node-full lanes of the scheduler's first pass.
 */
export async function initBondService(): Promise<void> {
  await refreshBondState().catch(err => console.warn('[bonds] boot state read failed; the scheduler retries', err instanceof Error ? err.message : err))
  for (const d of dashboards.values()) d.init()
}
/** A family's dashboard, or null for no such family. */
export function getBondDashboard(family: string): Promise<BondDashboard> | null {
  return bondFamily(family) ? dashboards.get(family)!.get() : null
}

export interface AccountBondPosition {
  family: string
  familyTitle: string
  round: number
  bondId: number
  asset: ExplorerAsset
  underlying: ExplorerAsset
  balance: string
  maturityAt: string
  status: BondStatus
  /** At maturity it redeems 1:1 — now if it has matured. */
  redeemable: boolean
  /** Worth now (the bond rule) and at face. */
  valueUsd: number | null
  faceUsd: number | null
  valueFactor: number | null
  /** What this account bought in the primary sale (any part may have moved since): bonds received net of the fee, what it paid per asset, and the bonds-weighted return and APR it locked in. */
  bought: { bonds: string; paid: Array<{ asset: ExplorerAsset; raw: string }>; returnPct: number | null; aprPct: number | null; fills: number } | null
}
export interface AccountBonds { asOfBlock: number | null; positions: AccountBondPosition[] }

/** An account's bonds across every family, from the current snapshot alone; positions empty when it holds none, asOfBlock null when the snapshot is stale. */
export async function getAccountBondPositions(address: string): Promise<AccountBonds | null> {
  const resolved = await resolveRelatedAccounts(address)
  if (!resolved) return null
  const snap = currentBondSnapshot()
  if (!snap) return { asOfBlock: null, positions: [] }
  const ids = new Set([resolved.norm.accountId, ...resolved.related].map(a => a.toLowerCase()))
  return cached(`explorer:bonds-account:${snap.block}:${snap.readAt}:${[...ids].sort().join(',')}`, 30_000, async () => {
    const prices = await ensurePrices()
    const nowMs = Date.now()
    const positions: AccountBondPosition[] = []
    for (const f of BOND_FAMILIES) {
      for (const [i, t] of familyBonds(f).entries()) {
        const held = [...(snap.holdings.get(t.bondId) ?? [])].filter(([a]) => ids.has(a)).reduce((s, [, v]) => s + v, 0n)
        if (held <= 0n) continue
        const dec = asset(t.bondId).decimals
        const fills = snap.sales.filter(s => s.bondId === t.bondId).flatMap(s => s.fills.filter(x => ids.has(x.taker)).map(x => ({ s, x })))
        const paid = new Map<number, bigint>()
        let bonds = 0n, wa = 0, wr = 0, w = 0
        for (const { s, x } of fills) {
          const net = BigInt(x.bonds) - BigInt(x.fee)
          bonds += net
          paid.set(s.paymentAssetId, (paid.get(s.paymentAssetId) ?? 0n) + BigInt(x.paid))
          const y = fillYield({ paid: BigInt(x.paid), paidDecimals: asset(s.paymentAssetId).decimals, net, bondDecimals: dec, atMs: x.atMs, maturityMs: t.maturityMs, paidMaturityMs: BOND_TERMS.get(s.paymentAssetId)?.maturityMs ?? null })
          if (y?.aprPct != null) { const weight = weightOf(net, dec); wa += y.aprPct * weight; wr += y.returnPct * weight; w += weight }
        }
        const factor = bondValueFactorWad(t, nowMs)
        positions.push({
          family: f.key, familyTitle: f.title, round: i + 1, bondId: t.bondId, asset: asset(t.bondId), underlying: asset(t.underlyingId),
          balance: held.toString(), maturityAt: iso(t.maturityMs),
          status: bondStatus({ nowMs, maturityMs: t.maturityMs, openSale: anySaleOpen(snap.sales, t, nowMs), publicOutstanding: held }),
          redeemable: nowMs >= t.maturityMs,
          valueUsd: currentPriceOf(prices, t.bondId) ? rawUsd(prices, t.bondId, held) : null,
          faceUsd: rawUsd(prices, t.underlyingId, rescale(held, dec, asset(t.underlyingId).decimals)),
          valueFactor: factor != null ? wadNumber(factor) : null,
          bought: fills.length ? { bonds: bonds.toString(), paid: [...paid].map(([id, raw]) => ({ asset: asset(id), raw: raw.toString() })), returnPct: w > 0 ? wr / w : null, aprPct: w > 0 ? wa / w : null, fills: fills.length } : null,
        })
      }
    }
    return { asOfBlock: snap.block, positions: positions.sort((a, b) => Date.parse(a.maturityAt) - Date.parse(b.maturityAt)) }
  })
}
