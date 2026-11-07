// Bonds (the Bonds pallet) — the pure rules every bond surface shares: the explorer's
// bond pages, positions and activity, and the price every value surface states for a
// bond token, current and historical. No I/O (the sale reads are bondSales.ts).
//
// pallet-bonds: `issue(asset, amount, maturity)` takes `amount` of the underlying from
// the issuer into the pallet pot (`modl` + `pltbonds`) and mints the same amount of a
// bond asset to the issuer — one bond is one unit of the underlying owed at maturity
// (its FACE). From the maturity (Unix ms) on, any holder `redeem`s any part 1:1 out of
// the pot; nothing redeems before it. So the pot holds exactly the outstanding supply,
// Σ issued − Σ redeemed of every bond over that underlying.
//
// A bond is SOLD by its issuer through one or more primary-sale sources (`BondSale`): an
// OTC order governance placed selling it (bondSales.ts reads them), or — for the HDX
// bonds — an LBP pool. A source is a `sale` when it takes money and a `rollover` when it
// takes an older bond of the same underlying.

/** 10^18 — WAD fixed point for prices and factors. */
export const BOND_WAD = 10n ** 18n
export const YEAR_MS = 365 * 86_400_000
/** The Bonds pallet pot (`modl` + `pltbonds`): holds the underlying of every outstanding bond. */
export const BONDS_POT_ACCOUNT = '0x6d6f646c706c74626f6e64730000000000000000000000000000000000000000'
export const HOLLAR_ASSET_ID = 222

/** A family of bonds: every bond over one underlying, shown on one page (`/<key>-bonds`). */
export interface BondFamily { key: string; underlyingId: number; title: string; appUrl: string | null; description: string }
/** The bond pages. Every per-family surface (route, SEO hub, sitemap, MCP dashboard) derives from this list. */
export const BOND_FAMILIES: readonly BondFamily[] = [
  {
    key: 'hollar', underlyingId: HOLLAR_ASSET_ID, title: 'HOLLAR Bonds', appUrl: 'https://app.hydration.net/strategies/hollar-bonds',
    description: 'HOLLAR Bonds on Hydration: fixed-yield bonds the Treasury sells below face, redeemable 1:1 for HOLLAR at maturity. Every round’s fixed yield and APR, sale progress, rollovers, redemptions, holders and every purchase, transfer and redemption.',
  },
]
export const bondFamily = (key: string): BondFamily | undefined => BOND_FAMILIES.find(f => f.key === key)
export const bondFamilyOf = (underlyingId: number): BondFamily | undefined => BOND_FAMILIES.find(f => f.underlyingId === underlyingId)
export const bondFamilyPath = (key: string): string => `/${key}-bonds`

/** The OTC fill fee on `amountOut` (runtime OtcFee: 0.1 %, rounded up — pallet-otc calculate_fee). */
export function otcFillFee(amountOut: bigint): bigint {
  return (amountOut + 999n) / 1000n
}

/**
 * Assets whose unit counts as ONE FACE UNIT of a dollar-denominated bond in a sale's
 * terms: USDT (10), USDC (22) and HOLLAR (222) — the way the issuer prices the HOLLAR
 * bonds and the app quotes their yield, never at the stablecoins' momentary prices.
 */
export const DOLLAR_FACE_UNITS: ReadonlySet<number> = new Set([10, 22, HOLLAR_ASSET_ID])
/** Whether a payment in `paymentId` reads 1:1 against the face of a bond over `underlyingId`. */
export function paysInFaceUnits(paymentId: number, underlyingId: number): boolean {
  return paymentId === underlyingId || (DOLLAR_FACE_UNITS.has(paymentId) && DOLLAR_FACE_UNITS.has(underlyingId))
}

/** `raw` in `from` decimals restated in `to` decimals (exact when `to` ≥ `from`, floored otherwise). */
export function rescale(raw: bigint, from: number, to: number): bigint {
  return to >= from ? raw * 10n ** BigInt(to - from) : raw / 10n ** BigInt(from - to)
}

/** Face units paid per bond received (WAD): `paid` (payment raw) for `net` bonds (raw). Null when either is nothing. */
export function netPriceWad(paid: bigint, paidDecimals: number, net: bigint, bondDecimals: number): bigint | null {
  if (net <= 0n || paid <= 0n) return null
  return rescale(paid, paidDecimals, bondDecimals) * BOND_WAD / net
}
/** An OTC offer's price: `paid` asked for `bondsGross` offered, the buyer receiving them net of the fill fee. */
export function salePriceWad(paid: bigint, paidDecimals: number, bondsGross: bigint, bondDecimals: number): bigint | null {
  return netPriceWad(paid, paidDecimals, bondsGross - otcFillFee(bondsGross), bondDecimals)
}

// ── the primary sale ────────────────────────────────────────────────────────────

export type BondSaleVenue = 'otc' | 'lbp'
export type BondSaleKind = 'sale' | 'rollover'
export interface BondSaleFill {
  block: number
  eventIndex: number
  extrinsicIndex: number | null
  atMs: number
  taker: string
  /** What the buyer paid (raw, payment asset). */
  paid: string
  /** Bonds the source released (raw), the venue's fee included; the buyer received `bonds − fee`. */
  bonds: string
  fee: string
  partial: boolean
}
/** One primary-sale source of one bond. */
export interface BondSale {
  venue: BondSaleVenue
  /** The OTC order id; an LBP pool's account. */
  id: string
  bondId: number
  kind: BondSaleKind
  paymentAssetId: number
  /** The issuer-side accounts the source holds unsold bonds in (the OTC maker; an LBP pool). Empty until resolved. */
  issuerAccounts: string[]
  /** A fixed-terms source's size: bonds offered (raw, the fee included) and the payment asked for them. Null for a venue without fixed terms. */
  offered: string | null
  asked: string | null
  openedBlock: number
  openedMs: number
  /** When the issuer withdrew it (an OTC pull); null while it stands. */
  closedBlock: number | null
  closedMs: number | null
  fills: BondSaleFill[]
}

/**
 * THE primary-sale rule for an OTC order: placed with NO extrinsic — dispatched by
 * governance on the issuer's behalf (every user order carries one) — and selling a bond;
 * a `rollover` when it takes another bond in payment, else a `sale`.
 */
export function primaryOtcSaleKind(o: { governance: boolean; assetIn: number; assetOut: number }, isBond: (assetId: number) => boolean): BondSaleKind | null {
  if (!o.governance || !isBond(o.assetOut)) return null
  return isBond(o.assetIn) ? 'rollover' : 'sale'
}

export interface BondSaleProgress {
  /** Released (raw, the fee included), paid (payment raw) and received by buyers (raw, net of the fee). */
  sold: bigint
  paid: bigint
  net: bigint
  /** Still on offer (open), returned unsold (closed): a fixed-terms source only. */
  remaining: bigint
  unsold: bigint
  state: 'open' | 'filled' | 'closed'
  /** When it stopped selling: sold out, withdrawn, or — still standing — the bond's maturity. Null while open. */
  endedMs: number | null
}
/** A source's progress: ONE definition of open / sold out / closed for every surface. */
export function saleProgress(s: BondSale, maturityMs: number, nowMs: number): BondSaleProgress {
  const sold = s.fills.reduce((a, f) => a + BigInt(f.bonds), 0n)
  const paid = s.fills.reduce((a, f) => a + BigInt(f.paid), 0n)
  const net = s.fills.reduce((a, f) => a + BigInt(f.bonds) - BigInt(f.fee), 0n)
  const left = s.offered != null ? BigInt(s.offered) - sold : null
  const lastFill = s.fills.length ? s.fills[s.fills.length - 1].atMs : null
  if (left != null && left <= 0n) return { sold, paid, net, remaining: 0n, unsold: 0n, state: 'filled', endedMs: lastFill }
  if (s.closedMs != null || nowMs >= maturityMs) {
    return { sold, paid, net, remaining: 0n, unsold: left ?? 0n, state: 'closed', endedMs: s.closedMs != null ? Math.min(s.closedMs, maturityMs) : maturityMs }
  }
  return { sold, paid, net, remaining: left ?? 0n, unsold: 0n, state: 'open', endedMs: null }
}

/** A source taking money in the bond's face units (a rollover pays in bonds and is no money sale). */
export function isMoneySale(s: Pick<BondSale, 'kind' | 'paymentAssetId'>, underlyingId: number): boolean {
  return s.kind === 'sale' && paysInFaceUnits(s.paymentAssetId, underlyingId)
}

/**
 * Where the bond's money sale priced it: while a money source is open, the lowest
 * executable price it asks (net of the fee) and `closedMs` null; once none is, the
 * volume-weighted net price of every money fill and when the last source stopped.
 * Null for a bond with no money sale.
 */
export interface BondSaleAnchor { priceWad: bigint; openedMs: number; closedMs: number | null }
export function saleAnchor(sales: readonly BondSale[], t: { underlyingId: number; maturityMs: number }, decimalsOf: (assetId: number) => number, nowMs: number): BondSaleAnchor | null {
  const money = sales.filter(s => isMoneySale(s, t.underlyingId))
  if (!money.length) return null
  const openedMs = Math.min(...money.map(s => s.openedMs))
  const progress = money.map(s => ({ s, p: saleProgress(s, t.maturityMs, nowMs) }))
  const open = progress.filter(x => x.p.state === 'open' && x.s.offered != null && x.s.asked != null)
    .map(x => salePriceWad(BigInt(x.s.asked!), decimalsOf(x.s.paymentAssetId), BigInt(x.s.offered!), decimalsOf(x.s.bondId)))
    .filter((p): p is bigint => p != null)
  if (open.length) return { priceWad: open.reduce((a, b) => (b < a ? b : a)), openedMs, closedMs: null }
  let paidFace = 0n, net = 0n
  for (const { s, p } of progress) { paidFace += rescale(p.paid, decimalsOf(s.paymentAssetId), decimalsOf(s.bondId)); net += p.net }
  if (net <= 0n || paidFace <= 0n) return null
  const ended = progress.map(x => x.p.endedMs ?? t.maturityMs)
  return { priceWad: paidFace * BOND_WAD / net, openedMs, closedMs: Math.max(...ended) }
}

/** A bond's own terms (Bonds.TokenCreated, Σ Bonds.Issued) and where its sale priced it. */
export interface BondTerms {
  bondId: number
  underlyingId: number
  issuer: string
  maturityMs: number
  createdBlock: number
  createdMs: number
  /** Σ issued (raw); a class created with nothing issued is no round. */
  issued: string
  anchor: BondSaleAnchor | null
}

/**
 * What one bond is worth in units of its underlying at `ms` (WAD) — THE bond valuation
 * rule, current and historical alike (a pure function of time, so a chart, a flow and
 * the live price agree):
 *  - from maturity it redeems 1:1: its face (1);
 *  - while its money sale stands (and before it opened) at the sale's price — the open
 *    offer's executable price net of the fee, else the volume-weighted price it sold at;
 *  - after the sale ended, that price accreting to face at maturity, simple interest
 *    (how the issuer and the app quote it): 1 / (1 + g · (M − t) / (M − t_end)), g = 1/p − 1;
 *  - a pre-maturity bond with no money sale has no stated value (null) — unpriced.
 * A live market for the bond itself (its own price feed) comes first where one exists
 * (withBondPrices keeps it).
 */
export function bondValueFactorWad(t: Pick<BondTerms, 'maturityMs' | 'anchor'>, ms: number): bigint | null {
  if (ms >= t.maturityMs) return BOND_WAD
  const a = t.anchor
  if (!a || a.priceWad <= 0n) return null
  if (a.closedMs == null || ms <= a.closedMs || a.closedMs >= t.maturityMs) return a.priceWad
  const g = BOND_WAD * BOND_WAD / a.priceWad - BOND_WAD
  if (g <= 0n) return a.priceWad
  return BOND_WAD * BOND_WAD / (BOND_WAD + g * BigInt(t.maturityMs - ms) / BigInt(t.maturityMs - a.closedMs))
}
/** A WAD factor as a number (display). */
export const wadNumber = (v: bigint): number => Number(v * 1_000_000_000n / BOND_WAD) / 1e9

/**
 * A copy of a CURRENT price map (integer USD at any one fixed scale) with every bond
 * priced by `bondValueFactorWad` × its underlying's current price (`priceOf`, the map's
 * own lookup rule). A bond with an entry of its own keeps it (a live market); one the
 * rule cannot state, or whose underlying is unpriced, is removed — unpriced.
 */
export function withBondPrices(feeds: ReadonlyMap<number, bigint>, terms: Iterable<BondTerms>, nowMs: number, priceOf: (assetId: number) => bigint | null | undefined): Map<number, bigint> {
  const out = new Map(feeds)
  for (const t of terms) {
    if (feeds.has(t.bondId)) continue
    const factor = bondValueFactorWad(t, nowMs)
    const underlying = priceOf(t.underlyingId)
    if (factor == null || underlying == null || underlying <= 0n) { out.delete(t.bondId); continue }
    out.set(t.bondId, underlying * factor / BOND_WAD)
  }
  return out
}

/**
 * The yield a fill locked in: `paid` (payment units) for `net` bonds, held to maturity —
 * the return (net ÷ paid − 1, rounded to 1e-4 %) and that return annualised simple over
 * the fill to maturity. A ROLLOVER pays in older bonds of the same underlying, worth face
 * from their own maturity, so its gain is earned from the later of the fill and the old
 * maturity (the official app's rollover APR). Null when it cannot be stated.
 */
export function fillYield(f: { paid: bigint; paidDecimals: number; net: bigint; bondDecimals: number; atMs: number; maturityMs: number; paidMaturityMs?: number | null }): { returnPct: number; aprPct: number | null } | null {
  if (f.paid <= 0n || f.net <= 0n) return null
  const paidFace = rescale(f.paid, f.paidDecimals, f.bondDecimals)
  if (paidFace <= 0n) return null
  // Return in units of 1e-6 % (1e-8), rounded half up.
  const scaled = (f.net * 100_000_000n * 2n + paidFace) / (2n * paidFace) - 100_000_000n
  const returnPct = Math.round(Number(scaled) / 100) / 10_000
  const from = f.paidMaturityMs != null ? Math.max(f.atMs, f.paidMaturityMs) : f.atMs
  const span = f.maturityMs - from
  return { returnPct, aprPct: span > 0 ? Number(scaled) / 1_000_000 * YEAR_MS / span : null }
}

/**
 * A bond's lifecycle as one word: `selling` while a primary-sale source still sells it
 * before maturity, `active` once none does and until maturity, `matured` from maturity
 * while anyone outside the issuer side still holds some, `redeemed` once none does (what
 * the issuer side still holds — unsold bonds, fees — is its own claim on its own pot).
 */
export type BondStatus = 'selling' | 'active' | 'matured' | 'redeemed'
export function bondStatus(o: { nowMs: number; maturityMs: number; openSale: boolean; publicOutstanding: bigint }): BondStatus {
  if (o.nowMs < o.maturityMs) return o.openSale ? 'selling' : 'active'
  return o.publicOutstanding > 0n ? 'matured' : 'redeemed'
}

/** A family's rounds: its bonds that were ever issued, oldest first (round 1 is the first). */
export function familyRounds(terms: Iterable<BondTerms>, underlyingId: number): BondTerms[] {
  return [...terms].filter(t => t.underlyingId === underlyingId && BigInt(t.issued || '0') > 0n)
    .sort((a, b) => a.createdBlock - b.createdBlock || a.bondId - b.bondId)
}
