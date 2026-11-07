import type { ClickHouseClient } from '../db/client.ts'
import { BOND_TERMS, BOND_UNDERLYING_ID, whenExplorerAssetsLoaded } from './explorerAssets.ts'
import { getOtcPlacedLegsByOrderId } from './explorerService.ts'
import { BONDS_POT_ACCOUNT, type BondSale } from './bonds.ts'
import { loadBondSales } from './bondSales.ts'
import { loadIndexedHead } from './pinnedBlock.ts'
import { createStrategyRefresher, selectRows as select } from './strategyRefresher.ts'

// Every bond's CURRENT state at ONE indexed block, held in memory and read by the
// coordinated background refresher (backgroundRefresh.ts, through the shared cycle in
// strategyRefresher.ts) and once at boot before the api listens (bondService.ts) —
// never on a request path. All of it is indexed (no chain read):
//  - the issues and redemptions (bond_activity: Bonds.Issued / Bonds.Redeemed);
//  - every primary-sale source with its fills and pull — the one shared sale read
//    (bondSales.ts) bounded to the block — with each OTC source's maker resolved (the
//    issuer side: what it holds is unsold);
//  - every holder's balance of every bond (asset_account_latest_balances, asset-first,
//    newest per holder), and the Bonds pot's balance of each underlying (the Tokens side
//    and, for a contract-backed underlying like HOLLAR, its ERC-20 wallet pot).
// It re-reads when bond_activity, the OTC events, the bonds' balances or the bond
// registry move, else every fifth tick (a bond's status turns on the clock at maturity).
//
// Checked before the issuer/public split is stated: per bond, its holders' balances must
// sum to Σ issued − Σ redeemed (the supply), else `holdersReconciled` is false and the
// split is withheld; and per underlying, the pot must hold exactly the outstanding supply
// of every bond over it (`potReconciled`). Balances are the newest observation per holder
// while the events are bounded to the block, so a transfer landing between the two reads
// fails the first check for one cycle rather than being stated. A primary-sale order
// whose maker did not resolve would misstate the issuer side: no snapshot then.

export interface BondIssue { bondId: number; block: number; atMs: number; issuer: string; amount: string; fee: string }
export interface BondRedemption { bondId: number; block: number; eventIndex: number; extrinsicIndex: number | null; atMs: number; who: string; amount: string }
export interface BondSnapshot {
  block: number
  readAt: number
  issues: BondIssue[]
  redemptions: BondRedemption[]
  sales: BondSale[]
  /** bond id → holder account id (as stored) → balance (raw, > 0). */
  holdings: Map<number, Map<string, bigint>>
  /** Per bond: its holders sum to its supply (issued − redeemed). */
  holdersReconciled: Map<number, boolean>
  /** underlying id → the pot's balance of it (raw). */
  pot: Map<number, bigint>
  /** Per underlying: the pot holds exactly the outstanding supply of its bonds; null when the pot's balance could not be read. */
  potReconciled: Map<number, boolean | null>
}

type EventRow = { block_height: number; event_index: number; extrinsic_index: number | null; ts: number; event_name: string; args_json: string }
const parse = (s: string): Record<string, unknown> => { try { return JSON.parse(s) as Record<string, unknown> } catch { return {} } }
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const isRaw = (s: string) => /^\d+$/.test(s)

/** Supply per bond: Σ issued − Σ redeemed (raw). */
export function bondSupplies(issues: readonly BondIssue[], redemptions: readonly BondRedemption[]): Map<number, bigint> {
  const out = new Map<number, bigint>()
  for (const i of issues) out.set(i.bondId, (out.get(i.bondId) ?? 0n) + BigInt(i.amount))
  for (const r of redemptions) out.set(r.bondId, (out.get(r.bondId) ?? 0n) - BigInt(r.amount))
  return out
}

/** A bond's ISSUER side: its issuer and the accounts its primary-sale sources hold unsold bonds in (an OTC maker; an LBP pool). */
export function bondIssuerAccounts(bondId: number, issuer: string | undefined, sales: readonly BondSale[]): Set<string> {
  const out = new Set<string>()
  if (issuer) out.add(issuer.toLowerCase())
  for (const s of sales) if (s.bondId === bondId) for (const a of s.issuerAccounts) out.add(a.toLowerCase())
  return out
}

/** Decodes the issue/redeem rows; a malformed one is skipped. */
export function bondEvents(rows: readonly EventRow[]): { issues: BondIssue[]; redemptions: BondRedemption[] } {
  const issues: BondIssue[] = [], redemptions: BondRedemption[] = []
  for (const r of rows) {
    const a = parse(r.args_json)
    const bondId = Number(a.bondId)
    const amount = str(a.amount)
    if (!Number.isInteger(bondId) || bondId <= 0 || !isRaw(amount)) continue
    if (r.event_name === 'Bonds.Issued') issues.push({ bondId, block: r.block_height, atMs: r.ts * 1000, issuer: str(a.issuer).toLowerCase(), amount, fee: isRaw(str(a.fee)) ? str(a.fee) : '0' })
    else if (r.event_name === 'Bonds.Redeemed') redemptions.push({ bondId, block: r.block_height, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index, atMs: r.ts * 1000, who: str(a.who).toLowerCase(), amount })
  }
  return { issues, redemptions }
}

/** Assembles a snapshot from its reads and checks it (pure, for the tests); null when a sale's issuer side did not resolve. */
export function assembleBondSnapshot(input: {
  block: number
  readAt: number
  bondIds: readonly number[]
  underlyingOf: (bondId: number) => number | undefined
  eventRows: readonly EventRow[]
  sales: readonly BondSale[]
  makers: ReadonlyMap<string, string | null>
  balanceRows: ReadonlyArray<{ asset_id: string; account_id: string; bal: string }>
  potRows: ReadonlyArray<{ asset_id: string; bal: string }>
}): BondSnapshot | null {
  const { issues, redemptions } = bondEvents(input.eventRows)
  const sales: BondSale[] = []
  for (const s of input.sales) {
    if (s.venue !== 'otc') { sales.push(s); continue }
    const maker = input.makers.get(s.id)
    if (!maker) return null
    sales.push({ ...s, issuerAccounts: [maker.toLowerCase()] })
  }
  const holdings = new Map<number, Map<string, bigint>>()
  for (const r of input.balanceRows) {
    const id = Number(r.asset_id)
    const m = holdings.get(id) ?? holdings.set(id, new Map()).get(id)!
    m.set(r.account_id.toLowerCase(), BigInt(r.bal))
  }
  const supplies = bondSupplies(issues, redemptions)
  const holdersReconciled = new Map<number, boolean>()
  for (const id of input.bondIds) {
    const held = [...(holdings.get(id)?.values() ?? [])].reduce((s, v) => s + v, 0n)
    const ok = held === (supplies.get(id) ?? 0n)
    holdersReconciled.set(id, ok)
    if (!ok) console.warn(`[bonds] bond ${id}: holders hold ${held}, supply is ${supplies.get(id) ?? 0n} at block ${input.block}; issuer/public split withheld`)
  }
  const pot = new Map<number, bigint>()
  for (const r of input.potRows) pot.set(Number(r.asset_id), (pot.get(Number(r.asset_id)) ?? 0n) + BigInt(r.bal))
  const potReconciled = new Map<number, boolean | null>()
  for (const u of new Set(input.bondIds.map(input.underlyingOf).filter((u): u is number => u != null))) {
    const outstanding = input.bondIds.filter(id => input.underlyingOf(id) === u).reduce((s, id) => s + (supplies.get(id) ?? 0n), 0n)
    const held = pot.get(u)
    potReconciled.set(u, held == null ? null : held === outstanding)
  }
  return { block: input.block, readAt: input.readAt, issues, redemptions, sales, holdings, holdersReconciled, pot, potReconciled }
}

/** One cycle: everything at one indexed block, or nothing (the previous snapshot stays). */
export async function readBondSnapshot(ch: ClickHouseClient): Promise<BondSnapshot | null> {
  // The bonds are the registry's: wait for its first load rather than reading none.
  await whenExplorerAssetsLoaded()
  const terms = [...BOND_TERMS.values()]
  if (!terms.length) return null
  const block = await loadIndexedHead(ch, 'bond:pin')
  const bondIds = terms.map(t => t.bondId)
  const underlyings = [...new Set(terms.map(t => t.underlyingId))]
  const [eventRows, sales, balanceRows, potRows] = await Promise.all([
    select<EventRow>(ch, `-- bond:events
      SELECT block_height, event_index, extrinsic_index, toUnixTimestamp(block_timestamp) AS ts, event_name, args_json
      FROM price_data.bond_activity FINAL WHERE block_height <= {b:UInt32}`, { b: block }),
    loadBondSales(ch, bondIds, id => BOND_UNDERLYING_ID[id] != null, block),
    select<{ asset_id: string; account_id: string; bal: string }>(ch, `-- bond:holders
      SELECT asset_id, account_id, toString(toUInt256OrZero(argMaxMerge(total_state))) AS bal
      FROM price_data.asset_account_latest_balances
      WHERE asset_id IN {ids:Array(String)}
      GROUP BY asset_id, account_id HAVING toUInt256OrZero(argMaxMerge(total_state)) > 0`, { ids: bondIds.map(String) }),
    select<{ asset_id: string; bal: string }>(ch, `-- bond:pot
      SELECT asset_id, toString(toUInt256OrZero(argMaxMerge(total_state))) AS bal
      FROM price_data.asset_account_latest_balances
      WHERE asset_id IN {u:Array(String)} AND account_id = {pot:String}
      GROUP BY asset_id
      UNION ALL
      SELECT asset_id, toString(toUInt256OrZero(argMax(total, updated_at))) AS bal
      FROM price_data.erc20_wallet_balances
      WHERE asset_id IN {u:Array(String)} AND account_id = {pot:String}
      GROUP BY asset_id`, { u: underlyings.map(String), pot: BONDS_POT_ACCOUNT }),
  ])
  const otcIds = sales.filter(s => s.venue === 'otc').map(s => s.id)
  const legs = otcIds.length ? await getOtcPlacedLegsByOrderId(otcIds) : new Map()
  const snap = assembleBondSnapshot({
    block, readAt: Date.now(), bondIds, underlyingOf: id => BOND_TERMS.get(id)?.underlyingId,
    eventRows, sales, makers: new Map(otcIds.map(id => [id, legs.get(id)?.maker ?? null])), balanceRows, potRows,
  })
  if (!snap) console.warn('[bonds] a primary-sale order\'s maker did not resolve; keeping the previous snapshot')
  return snap
}

/** The refresher's change mark: the newest ingest of every source (never a row count, which a merge moves) and the bond registry. */
export async function loadBondMark(ch: ClickHouseClient): Promise<string> {
  const ids = [...BOND_TERMS.keys()].map(String)
  const [r] = await select<{ m: string }>(ch, `-- bond:mark
    SELECT concat(
      (SELECT concat(toString(max(block_height)), ':', toString(max(ingested_at))) FROM price_data.bond_activity), '|',
      (SELECT concat(toString(max(block_height)), ':', toString(max(ingested_at))) FROM price_data.otc_activity), '|',
      (SELECT toString(maxMerge(last_block_state)) FROM price_data.asset_account_latest_balances WHERE asset_id IN {ids:Array(String)})) AS m`,
  { ids })
  const registry = [...BOND_TERMS.values()].map(t => `${t.bondId}:${t.issued}:${t.anchor?.priceWad ?? ''}:${t.anchor?.closedMs ?? ''}`).join(',')
  return `${r?.m ?? ''}|${registry}`
}

/** A snapshot older than this states no current figure (the refresher has stopped renewing it). */
export const BOND_SNAPSHOT_MAX_AGE_MS = 15 * 60_000
const refresher = createStrategyRefresher<BondSnapshot>({
  name: 'bonds',
  loadMark: loadBondMark,
  read: readBondSnapshot,
  maxAgeMs: BOND_SNAPSHOT_MAX_AGE_MS,
})
export function initBondState(c: ClickHouseClient): void { refresher.init(c) }
export const refreshBondState = (): Promise<void> => refresher.refresh()
export const currentBondSnapshot = (nowMs = Date.now()): BondSnapshot | null => refresher.current(nowMs)
/** Test seam. */
export function setBondSnapshotForTest(s: BondSnapshot | null): void { refresher.setForTest(s) }
