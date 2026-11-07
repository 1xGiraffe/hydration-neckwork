import { cached } from './cache.ts'
import { BOND_TERMS, currentPriceOf, displayDescriptor, type ExplorerAsset } from './explorerAssets.ts'
import { accountRef, ensurePrices, getHolders, resolveRelatedAccounts, type AccountRef, type HolderRow, type PriceInfo } from './explorerService.ts'
import {
  BOND_FAMILIES, BOND_WAD, BONDS_POT_ACCOUNT, bondFamily, bondStatus, bondValueFactorWad, familyRounds, fillPaidFace, fillYield, isMoneySale, lbpReplay, otcFillFee, rescale, saleProgress, salePriceWad, wadNumber,
  type BondFamily, type BondSale, type BondSaleFill, type BondSaleKind, type BondSaleVenue, type BondStatus, type BondTerms,
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
  /** What buyers actually paid per bond received, net of the fee (volume-weighted), in the payment asset. */
  avgPrice: number | null
  /** The same in face units (equal to `avgPrice` for a source paying in face units; at each fill's event-time prices otherwise). */
  avgFacePrice: number | null
  /** The APR purchases locked in, bonds-weighted over every purchase (bonds.ts fillYield, held to maturity). */
  avgAprPct: number | null
  /** A source whose payment is not face units states its terms at event-time prices (bonds.ts header). */
  facedAtEventTime: boolean
  /** An LBP source's pool, weights, curve and fills; null for any other venue. */
  lbp: BondLbpView | null
}
/** An LBP sale: the pool's terms, what it was seeded with and returned, and the sale as it ran. */
export interface BondLbpView {
  pool: AccountRef
  feePct: number
  /** The payment asset's weight (%) at the start and the end; the bond's is the rest. */
  paymentWeightStart: number
  paymentWeightEnd: number
  startAt: string | null
  endAt: string | null
  seed: { payment: string; bonds: string }
  returned: { at: string; block: number; payment: string; bonds: string } | null
  /** Trading fees the collector received (raw, payment asset). */
  fees: string
  /** Sells back into the pool: how many, and the bonds they returned (raw). */
  sellBacks: number
  soldBack: string
  /** The replayed reserves land exactly on what the owner took back (null while the pool still holds them). The curve is withheld when false. */
  reconciled: boolean | null
  /**
   * The pool's spot price per bond, just before and just after every fill and at the
   * start and the end: `pay` in the payment asset, `face` in the bond's face units at
   * that moment's prices (null where unpriced). `t` is Unix ms.
   */
  curve: Array<{ t: number; pay: number | null; face: number | null }>
  /** Every fill: when, which way, the bonds (whole units), and the price per bond paid or received in the payment asset and in face units. */
  fills: Array<{ t: number; side: 'buy' | 'sell'; bonds: number; pay: number | null; face: number | null }>
}
/** Who bought a round: distinct buyers, concentration and the largest, by bonds bought net of sells. */
export interface BondBuyerStats {
  buyers: number
  /** Accounts that sold bonds back into a source. */
  sellers: number
  purchases: number
  /** Median and largest single purchase (bonds, raw). */
  medianPurchase: string | null
  largestPurchase: string | null
  /** The ten largest buyers' share of the bonds sold, %. */
  top10SharePct: number | null
  top: Array<{
    account: AccountRef
    fills: number
    /** Bonds bought net of sells back (raw) and what that cost net (raw, per payment asset). */
    bonds: string
    paid: Array<{ asset: ExplorerAsset; raw: string }>
    /** The bonds-weighted price per bond in face units, its return to maturity and APR as bought. */
    facePrice: number | null
    returnPct: number | null
    aprPct: number | null
  }>
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
  /** The money sale's discount to face at its price (null for a sale without one), and the bonds-weighted APR purchases locked in. */
  discountPct: number | null
  avgAprPct: number | null
  buyerStats: BondBuyerStats
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

/**
 * The yield one PURCHASE locked in, held to maturity (bonds.ts fillYield) on its face
 * value: the payment itself in face units, else at the fill's event-time prices; a
 * rollover's from the older bond's maturity. Null for a sell back or an unstated one.
 */
export function purchaseYield(s: BondSale, f: BondSaleFill, t: Pick<BondTerms, 'underlyingId' | 'maturityMs'>, decimalsOf: (id: number) => number, paidMaturityMs: number | null): ReturnType<typeof fillYield> {
  if (f.side === 'sell') return null
  const bondDecimals = decimalsOf(s.bondId)
  const net = BigInt(f.bonds) - BigInt(f.fee)
  // A rollover pays in bonds of the same face: 1:1 in units of the older bond.
  const face = s.kind === 'rollover' ? rescale(BigInt(f.paid), decimalsOf(s.paymentAssetId), bondDecimals) : fillPaidFace(s, f, t.underlyingId, decimalsOf)
  if (face == null) return null
  return fillYield({ paid: face, paidDecimals: bondDecimals, net, bondDecimals, atMs: f.atMs, maturityMs: t.maturityMs, paidMaturityMs })
}

/** The per-day yield of a bond's fills, bonds-weighted over the purchases; bonds and paid net of sells back (pure, for the tests). */
export function fillDaysOf(sales: readonly BondSale[], terms: ReadonlyMap<number, BondTerms>, decimalsOf: (id: number) => number): BondFillDay[] {
  const acc = new Map<string, { day: string; bondId: number; kind: BondSaleKind; fills: number; bonds: bigint; paid: bigint; wr: number; wa: number; w: number; wA: number }>()
  for (const s of sales) {
    const t = terms.get(s.bondId)
    if (!t) continue
    const paidMaturity = terms.get(s.paymentAssetId)?.maturityMs ?? null
    for (const f of s.fills) {
      const key = `${dayOf(f.atMs)}:${s.bondId}:${s.kind}`
      const a = acc.get(key) ?? acc.set(key, { day: dayOf(f.atMs), bondId: s.bondId, kind: s.kind, fills: 0, bonds: 0n, paid: 0n, wr: 0, wa: 0, w: 0, wA: 0 }).get(key)!
      const sign = f.side === 'sell' ? -1n : 1n
      const y = purchaseYield(s, f, t, decimalsOf, paidMaturity)
      const weight = weightOf(BigInt(f.bonds) - BigInt(f.fee), decimalsOf(s.bondId))
      a.fills++
      a.bonds += sign * BigInt(f.bonds)
      a.paid += sign * BigInt(f.paid)
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

/** A source's purchases, net of sells back, in face units (WAD price) — null when a fill's face value is unstated. */
function faceAverage(s: BondSale, t: BondTerms, decimalsOf: (id: number) => number): { priceWad: bigint } | null {
  let face = 0n, net = 0n
  for (const f of s.fills) {
    const v = s.kind === 'rollover' ? rescale(BigInt(f.paid), decimalsOf(s.paymentAssetId), decimalsOf(s.bondId)) : fillPaidFace(s, f, t.underlyingId, decimalsOf)
    if (v == null) return null
    const sign = f.side === 'sell' ? -1n : 1n
    face += sign * v
    net += sign * (BigInt(f.bonds) - BigInt(f.fee))
  }
  return net > 0n && face > 0n ? { priceWad: face * BOND_WAD / net } : null
}
/** The bonds-weighted APR of a set of purchases (bonds.ts fillYield over each). */
function weightedApr(list: Array<{ s: BondSale; f: BondSaleFill }>, decimalsOf: (id: number) => number): { aprPct: number | null; returnPct: number | null } {
  let wa = 0, wr = 0, w = 0
  for (const { s, f } of list) {
    const t = BOND_TERMS.get(s.bondId)
    if (!t) continue
    const y = purchaseYield(s, f, t, decimalsOf, BOND_TERMS.get(s.paymentAssetId)?.maturityMs ?? null)
    if (y?.aprPct == null) continue
    const weight = weightOf(BigInt(f.bonds) - BigInt(f.fee), decimalsOf(s.bondId))
    wa += y.aprPct * weight; wr += y.returnPct * weight; w += weight
  }
  return w > 0 ? { aprPct: wa / w, returnPct: wr / w } : { aprPct: null, returnPct: null }
}

const MAX_CURVE_POINTS = 1_200
function lbpView(s: BondSale, decimalsOf: (id: number) => number): BondLbpView | null {
  const l = s.lbp
  if (!l) return null
  const payDec = decimalsOf(s.paymentAssetId), bondDec = decimalsOf(s.bondId)
  const replay = lbpReplay(s, decimalsOf)
  // Face per bond = payment per bond × face per payment unit at that moment.
  const toFace = (payWad: bigint | null, rate: string | null | undefined): number | null =>
    payWad == null || rate == null ? null : wadNumber(payWad * BigInt(rate) / 10n ** BigInt(bondDec))
  const curve: BondLbpView['curve'] = []
  if (replay && replay.reconciled !== false) {
    for (const pt of replay.points) {
      const rate = pt.fill != null ? l.faceRate.fills[pt.fill] : pt.afterWad != null ? l.faceRate.start : l.faceRate.end
      if (pt.beforeWad != null) curve.push({ t: pt.atMs, pay: wadNumber(pt.beforeWad), face: toFace(pt.beforeWad, rate) })
      if (pt.afterWad != null) curve.push({ t: pt.atMs, pay: wadNumber(pt.afterWad), face: toFace(pt.afterWad, rate) })
    }
  }
  const fills = s.fills.map((f, i) => {
    const bonds = BigInt(f.bonds) - BigInt(f.fee)
    // A buy's price includes the fee it paid; a sell's is what it received per bond.
    const payWad = bonds > 0n ? rescale(BigInt(f.paid), payDec, bondDec) * BOND_WAD / bonds : null
    const faceRaw = fillPaidFace(s, f, BOND_TERMS.get(s.bondId)?.underlyingId ?? -1, decimalsOf)
    void i
    return {
      t: f.atMs, side: f.side === 'sell' ? 'sell' as const : 'buy' as const, bonds: weightOf(bonds, bondDec),
      pay: payWad != null ? wadNumber(payWad) : null,
      face: faceRaw != null && bonds > 0n ? wadNumber(faceRaw * BOND_WAD / bonds) : null,
    }
  })
  const fees = s.fills.reduce((a, f) => a + BigInt(f.paymentFee ?? '0'), 0n)
  const sells = s.fills.filter(f => f.side === 'sell')
  return {
    pool: accountRef(l.pool), feePct: l.fee[1] > 0 ? l.fee[0] / l.fee[1] * 100 : 0,
    paymentWeightStart: l.initialWeight / 1_000_000, paymentWeightEnd: l.finalWeight / 1_000_000,
    startAt: l.startMs != null ? iso(l.startMs) : null, endAt: l.endMs != null ? iso(l.endMs) : null,
    seed: { payment: l.seed.payment, bonds: l.seed.bonds },
    returned: l.returned ? { at: iso(l.returned.atMs), block: l.returned.block, payment: l.returned.payment, bonds: l.returned.bonds } : null,
    fees: fees.toString(), sellBacks: sells.length, soldBack: sells.reduce((a, f) => a + BigInt(f.bonds), 0n).toString(),
    reconciled: replay?.reconciled ?? null,
    curve: curve.length > MAX_CURVE_POINTS ? curve.filter((_, i) => i % Math.ceil(curve.length / MAX_CURVE_POINTS) === 0 || i === curve.length - 1) : curve,
    fills,
  }
}

function saleView(s: BondSale, t: BondTerms, nowMs: number): BondSaleView {
  const p = saleProgress(s, t.maturityMs, nowMs)
  const decimalsOf = (id: number) => asset(id).decimals
  const avg = p.net > 0n && p.paid > 0n ? rescale(p.paid, decimalsOf(s.paymentAssetId), decimalsOf(s.bondId)) * 10n ** 18n / p.net : null
  const fromTerms = BOND_TERMS.get(s.paymentAssetId)
  const fromRound = fromTerms ? familyRounds(BOND_TERMS.values(), fromTerms.underlyingId).findIndex(x => x.bondId === s.paymentAssetId) + 1 || null : null
  const faceAvg = faceAverage(s, t, decimalsOf)
  const bought = weightedApr(s.fills.map(f => ({ s, f })), decimalsOf)
  // A fixed-terms source (an OTC offer) states its terms from its ask; a source without
  // them (an LBP) from what it sold at: the face-unit average price, its return to
  // maturity, and that return annualised from when the sale opened.
  const terms = s.offered != null && s.asked != null ? saleTerms(s, t, decimalsOf, s.kind === 'rollover') : (() => {
    if (!faceAvg) return { price: null, discountPct: null, fixedYieldPct: null, aprAtOpenPct: null }
    const y = fillYield({ paid: faceAvg.priceWad, paidDecimals: 18, net: BOND_WAD, bondDecimals: 18, atMs: s.openedMs, maturityMs: t.maturityMs })
    const price = wadNumber(faceAvg.priceWad)
    return { price, discountPct: s.kind === 'rollover' ? null : Math.round((1 - price) * 1e6) / 1e4, fixedYieldPct: y?.returnPct ?? null, aprAtOpenPct: y?.aprPct ?? null }
  })()
  return {
    venue: s.venue, id: s.id, kind: s.kind, paymentAsset: asset(s.paymentAssetId), fromRound,
    issuerAccounts: s.issuerAccounts.map(accountRef),
    openedAt: iso(s.openedMs), openedBlock: s.openedBlock, endedAt: p.endedMs != null ? iso(p.endedMs) : null, state: p.state,
    offered: s.offered, sold: p.sold.toString(), paid: p.paid.toString(), net: p.net.toString(),
    remaining: p.remaining.toString(), unsold: p.unsold.toString(),
    fills: s.fills.length, buyers: new Set(s.fills.filter(f => f.side !== 'sell').map(f => f.taker)).size,
    ...terms,
    avgPrice: avg != null ? wadNumber(avg) : null,
    avgFacePrice: faceAvg ? wadNumber(faceAvg.priceWad) : null,
    avgAprPct: bought.aprPct,
    facedAtEventTime: s.facedAtEventTime === true,
    lbp: lbpView(s, decimalsOf),
  }
}

const TOP_BUYERS = 25
/** Who bought a set of sources (pure over the snapshot; accounts as stored, lowercased). */
export function buyerStatsOf(sales: readonly BondSale[], decimalsOf: (id: number) => number): Omit<BondBuyerStats, 'top'> & { top: Array<Omit<BondBuyerStats['top'][number], 'account' | 'paid'> & { account: string; paid: Map<number, bigint> }> } {
  const by = new Map<string, { fills: number; bonds: bigint; paid: Map<number, bigint>; buys: Array<{ s: BondSale; f: BondSaleFill }> }>()
  const purchases: bigint[] = []
  const sellers = new Set<string>()
  let total = 0n
  for (const s of sales) for (const f of s.fills) {
    const b = by.get(f.taker) ?? by.set(f.taker, { fills: 0, bonds: 0n, paid: new Map(), buys: [] }).get(f.taker)!
    const sign = f.side === 'sell' ? -1n : 1n
    const net = BigInt(f.bonds) - BigInt(f.fee)
    b.fills++
    b.bonds += sign * net
    b.paid.set(s.paymentAssetId, (b.paid.get(s.paymentAssetId) ?? 0n) + sign * BigInt(f.paid))
    total += sign * net
    if (f.side === 'sell') sellers.add(f.taker)
    else { purchases.push(net); b.buys.push({ s, f }) }
  }
  const buyers = [...by].filter(([, b]) => b.buys.length > 0).sort((x, y) => (y[1].bonds > x[1].bonds ? 1 : y[1].bonds < x[1].bonds ? -1 : 0))
  purchases.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const top10 = buyers.slice(0, 10).reduce((a, [, b]) => a + (b.bonds > 0n ? b.bonds : 0n), 0n)
  return {
    buyers: buyers.length, sellers: sellers.size, purchases: purchases.length,
    medianPurchase: purchases.length ? purchases[Math.floor((purchases.length - 1) / 2)].toString() : null,
    largestPurchase: purchases.length ? purchases[purchases.length - 1].toString() : null,
    top10SharePct: total > 0n ? Number(top10 * 1_000_000n / total) / 10_000 : null,
    top: buyers.slice(0, TOP_BUYERS).map(([account, b]) => {
      const sold = b.buys.reduce((a, x) => a + BigInt(x.f.bonds) - BigInt(x.f.fee), 0n)
      let face: bigint | null = 0n
      for (const { s, f } of b.buys) {
        const t = BOND_TERMS.get(s.bondId)
        const v = !t ? null : s.kind === 'rollover' ? rescale(BigInt(f.paid), decimalsOf(s.paymentAssetId), decimalsOf(s.bondId)) : fillPaidFace(s, f, t.underlyingId, decimalsOf)
        face = v == null || face == null ? null : face + v
      }
      const y = weightedApr(b.buys, decimalsOf)
      return {
        account, fills: b.fills, bonds: b.bonds.toString(), paid: b.paid,
        facePrice: face != null && sold > 0n ? wadNumber(face * BOND_WAD / sold) : null,
        returnPct: y.returnPct, aprPct: y.aprPct,
      }
    }),
  }
}
function buyerStatsView(sales: readonly BondSale[]): BondBuyerStats {
  const st = buyerStatsOf(sales, id => asset(id).decimals)
  return {
    ...st,
    top: st.top.map(b => ({ ...b, account: accountRef(b.account), paid: [...b.paid].map(([id, raw]) => ({ asset: asset(id), raw: raw.toString() })) })),
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
    buyers: new Set(sales.flatMap(s => s.fills.filter(f => f.side !== 'sell').map(f => f.taker))).size,
    discountPct: headline?.discountPct ?? null,
    avgAprPct: weightedApr(sales.filter(s => isMoneySale(s, t.underlyingId)).flatMap(s => s.fills.map(f => ({ s, f }))), id => asset(id).decimals).aprPct,
    buyerStats: buyerStatsView(sales),
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
  for (const s of snap.sales) if (ids.has(s.bondId)) for (const f of s.fills) { add(sold, dayOf(f.atMs), s.bondId, (f.side === 'sell' ? -1n : 1n) * BigInt(f.bonds)); first = Math.min(first ?? f.atMs, f.atMs) }
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
  const sellers = [...new Set(sales.filter(s => s.venue !== 'lbp').flatMap(s => s.issuerAccounts))].filter(a => !issuers.includes(a))
  const lbpPools = sales.filter(s => s.lbp).map(s => ({ pool: s.lbp!.pool, round: bonds.findIndex(t => t.bondId === s.bondId) + 1 }))
  return {
    generatedAt: iso(nowMs), asOfBlock: snap.block, family, underlying, rounds,
    fillDays: fillDaysOf(sales, BOND_TERMS, id => asset(id).decimals),
    days: bondDays(ids, snap, nowMs),
    totals: {
      issued: sum(r => r.issued) ?? '0', soldForMoney: sum(r => r.soldForMoney) ?? '0', rolledOver: sum(r => r.rolledOver) ?? '0',
      redeemed: sum(r => r.redeemed) ?? '0', outstanding: outstanding.toString(),
      publicOutstanding: sum(r => r.publicOutstanding), publicUsd: usd.some(v => v == null) ? null : usd.reduce<number>((a, v) => a + (v ?? 0), 0),
      holders: holderSet.size, buyers: new Set(sales.flatMap(s => s.fills.filter(x => x.side !== 'sell').map(x => x.taker))).size, fills: sales.reduce((s, x) => s + x.fills.length, 0),
    },
    pot: { ...pot, balance: snap.pot.get(f.underlyingId)?.toString() ?? null, outstanding: outstanding.toString(), reconciled: snap.potReconciled.get(f.underlyingId) ?? null },
    accounts: [
      ...issuers.map(a => ({ role: 'Issuer — issued the bonds against its own underlying', account: accountRef(a) })),
      ...sellers.map(a => ({ role: 'Sale account — the sales’ issuer side, holds what went unsold', account: accountRef(a) })),
      ...lbpPools.map(p => ({ role: `Round ${p.round} LBP pool — sold the bonds; held the unsold ones until the Treasury took them back`, account: accountRef(p.pool) })),
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
          // A sell back into the source nets out of what was bought and paid.
          const sign = x.side === 'sell' ? -1n : 1n
          const net = BigInt(x.bonds) - BigInt(x.fee)
          bonds += sign * net
          paid.set(s.paymentAssetId, (paid.get(s.paymentAssetId) ?? 0n) + sign * BigInt(x.paid))
          const y = purchaseYield(s, x, t, id => asset(id).decimals, BOND_TERMS.get(s.paymentAssetId)?.maturityMs ?? null)
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
