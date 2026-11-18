import type { ClickHouseClient } from '../db/client.ts'
import {
  DEAD_ADDRESS, JUICER_FEE_CONTROLLER, JUICER_SUBLOOP, JUICER_VAULTS, JUICER_YIELD_ACCOUNTING, decodeJuicerLog,
  type JuicerEvent, type JuicerLogRow, type JuicerVaultDef,
} from './juicer.ts'
import { joinVia, userRevenueRows as rows, type CustodyResolution, type CustodyResolver, type FoldWindow, type Ledger } from './userRevenueFold.ts'
import { UNATTRIBUTED_VIA, ethMappedAccount } from './userRevenueStreams.ts'
import { loadErc20Book } from './userRevenueTokens.ts'

// User Revenue — the Juicer strategy as a CUSTODY (juicer.ts explains the strategy).
// Its contracts hold money-market positions on their holders' behalf, so what those
// positions earn and pay is the holders' — never the contracts' own:
//
//  * The SubLoop (shared by every vault) holds the leveraged PRIME loop: aPRIME (its
//    PRIME accrual and supply interest) against HOLLAR debt (the discounted loop
//    interest). Its income belongs to the vaults by their units of the loop
//    (SubLoop.sharesOf). Of each vault's part, the protocol owns its fee rate —
//    JuicerFeeController.protocolFeeBps(vault), the share of the loop's yield the
//    vault's yield accounting assigns to the protocol at each checkpoint (collected at
//    the harvest as ProtocolFeeAccrued). That share is booked to the fee controller
//    (holder class 'protocol', via `juicer-loop>juicer-fee`); the rest passes to the
//    vault. Main's own income (collateral interest, pool fees, token accrual) is not
//    charged the fee — the contracts' own rule — and Main's HOLLAR interest is the
//    holders' cost.
//  * A vault (CollateralVault) holds Main: the deposited collateral against HOLLAR
//    debt. Its income — Main's, plus its part of the loop — passes to its share
//    holders pro rata, per hour, by the share token's units at the hour's start: each
//    wallet's own shares (Transfer deltas), and each withdrawal request in its cooldown
//    or queue to its owner (the shares sit in the vault's escrow but still earn until
//    the unwind starts and fixes the collateral owed). What no holder claims — the
//    locked bootstrap shares at the burn address, the yield fund's shares, escrowed
//    shares whose unwind has started — is booked unattributed under
//    JUICER_REMAINDER_VIA, never re-spread over the holders.
//
// Every vault in JUICER_VAULTS joins with no change here. The loop's split between
// vaults needs SubLoop.sharesOf, which no event restates (a harvest burns a vault's
// units with no log naming the vault): while one vault has ever funded the loop it owns
// all of it; once several have, the split is the juicer-state refresher's pinned read
// (juicer_loop_shares) at or before the hour, and an hour none reaches is booked
// unattributed under JUICER_LOOP_UNSPLIT_VIA.

/** Via segments: the loop's pass-through, the protocol's fee share of it, a vault (by its share asset). */
export const JUICER_LOOP_VIA = 'juicer-loop'
export const JUICER_FEE_VIA = 'juicer-fee'
export const juicerVaultVia = (def: JuicerVaultDef): string => `juicer:${def.shareAssetId}`
/** A vault's income no share holder claims (burn-address, fund and exiting escrow shares). */
export const JUICER_REMAINDER_VIA = 'custody:juicer-remainder'
/** The loop's income in an hour no per-vault split reaches (several vaults, no pinned read). */
export const JUICER_LOOP_UNSPLIT_VIA = 'custody:juicer-loop-unsplit'

/** Share token holders that are custody, not a holder's own position. */
const NOT_HOLDERS = new Set<string>([DEAD_ADDRESS, JUICER_YIELD_ACCOUNTING, '0x0000000000000000000000000000000000000000'])

/** One withdrawal request's life: requested at a block, earning until its unwind starts. */
export interface JuicerRequestSpan { vault: string; id: number; owner: string; shares: bigint; requested: number; started: number | null }

/** Every request of every vault from the logs (RedeemRequested, UnwindStarted). Pure. */
export function juicerRequestSpans(events: readonly JuicerEvent[]): JuicerRequestSpan[] {
  const out = new Map<string, JuicerRequestSpan>()
  for (const e of [...events].sort((a, b) => a.blockHeight - b.blockHeight || a.eventIndex - b.eventIndex)) {
    if (e.requestId == null || !JUICER_VAULTS.some(v => v.vault === e.contract)) continue
    const key = `${e.contract}:${e.requestId}`
    if (e.name === 'RedeemRequested' && e.party && e.shares) {
      out.set(key, { vault: e.contract, id: e.requestId, owner: e.party, shares: BigInt(e.shares), requested: e.blockHeight, started: null })
    } else if (e.name === 'UnwindStarted') {
      const r = out.get(key)
      if (r && r.started == null) r.started = e.blockHeight
    }
  }
  return [...out.values()]
}

/**
 * Who earns a vault's income at one block (pure): the share token's wallet holders but
 * the vault's own escrow and the custody accounts, plus every request open at the block
 * (requested at or before it, unwind not started by it) to its owner — H160s with their
 * units, sorted — and the units outstanding (Σ every wallet: the token's supply), the
 * denominator a claimant's part is taken of.
 */
export function juicerVaultClaimants(
  vault: string, wallet: ReadonlyMap<string, bigint>, requests: readonly JuicerRequestSpan[], block: number,
): { claimants: Array<[string, bigint]>; outstanding: bigint } {
  const units = new Map<string, bigint>()
  let outstanding = 0n
  for (const [h, u] of wallet) {
    if (u <= 0n) continue
    outstanding += u
    if (h === vault || NOT_HOLDERS.has(h)) continue
    units.set(h, (units.get(h) ?? 0n) + u)
  }
  for (const r of requests) {
    if (r.vault !== vault || r.requested > block || (r.started != null && r.started <= block)) continue
    units.set(r.owner, (units.get(r.owner) ?? 0n) + r.shares)
  }
  const claimants = [...units].filter(([, u]) => u > 0n).sort(([a], [b]) => a.localeCompare(b))
  const claimed = claimants.reduce((a, [, u]) => a + u, 0n)
  // A request's units include the funded earnings it took from the fund; the claims never exceed the supply on chain.
  return { claimants, outstanding: claimed > outstanding ? claimed : outstanding }
}

/** A vault's protocol fee rate (bps) at a block, from its ProtocolFeeUpdated logs (0 before the first). Pure. */
export function juicerFeeBpsAt(events: readonly JuicerEvent[], vault: string, block: number): bigint {
  let bps = 0n
  for (const e of events) {
    if (e.blockHeight > block) break
    if (e.name === 'ProtocolFeeUpdated' && e.vault === vault && e.bps != null) bps = BigInt(e.bps)
  }
  return bps
}

/**
 * The loop's split between vaults at a block (pure): vault → its units of the loop, with
 * the loop's total. One vault ever funded it (LoopDeposited) → all of it. Several → the
 * latest pinned read at or before the block; null when none reaches it.
 */
export function juicerLoopSplitAt(
  events: readonly JuicerEvent[], reads: ReadonlyArray<{ vault: string; block: number; shares: bigint; total: bigint }>, block: number,
): { units: Map<string, bigint>; total: bigint } | null {
  const funders = new Set<string>()
  for (const e of events) {
    if (e.blockHeight > block) break
    if (e.name === 'LoopDeposited' && e.vault) funders.add(e.vault)
  }
  if (funders.size === 0) return null
  if (funders.size === 1) return { units: new Map([[[...funders][0], 1n]]), total: 1n }
  let at = -1
  for (const r of reads) if (r.block <= block && r.block > at) at = r.block
  if (at < 0) return null
  const units = new Map<string, bigint>()
  let total = 0n
  for (const r of reads) if (r.block === at) { units.set(r.vault, r.shares); total = r.total }
  return total > 0n ? { units, total } : null
}

const zeros = (n: number): bigint[] => new Array<bigint>(n).fill(0n)

/** The Juicer custodies of one window: a resolver per contract account (ETH-mapped), and the protocol's own Juicer accounts. */
export interface JuicerCustody {
  resolvers: Map<string, CustodyResolver>
  /** The fee controller (collected fees) and each vault's Main debt ledger (its reserve): the protocol's money. */
  protocolAccounts: string[]
}

export async function loadJuicerCustody(client: ClickHouseClient, w: FoldWindow, accountOf: (h160: string) => string): Promise<JuicerCustody> {
  const protocolAccounts = [ethMappedAccount(JUICER_FEE_CONTROLLER), ...JUICER_VAULTS.map(v => ethMappedAccount(v.mainDebt))]
  const resolvers = new Map<string, CustodyResolver>()
  if (!JUICER_VAULTS.length) return { resolvers, protocolAccounts }
  const [logRows, reads] = await Promise.all([
    rows<JuicerLogRow>(client, `
      SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, contract_address, topic0, topics, data
      FROM price_data.juicer_logs FINAL WHERE block_height <= {b:UInt32} ORDER BY block_height, event_index`, { b: w.lastBlock }, 'ur:juicer-logs'),
    rows<{ vault: string; b: string; s: string; t: string }>(client, `
      SELECT vault, block_height AS b, toString(argMax(shares, computed_at)) AS s, toString(argMax(total_shares, computed_at)) AS t
      FROM price_data.juicer_loop_shares WHERE block_height <= {b:UInt32} GROUP BY vault, block_height ORDER BY block_height`, { b: w.lastBlock }, 'ur:juicer-loop-shares'),
  ])
  const events = logRows.map(decodeJuicerLog).filter((e): e is JuicerEvent => e != null)
  const loopReads = reads.map(r => ({ vault: r.vault, block: Number(r.b), shares: BigInt(r.s), total: BigInt(r.t) }))
  const requests = juicerRequestSpans(events)
  const hourStart = (h: number) => (h === 0 ? w.openBlock : w.hourBlocks[h - 1].last)

  for (const def of JUICER_VAULTS) {
    const book = await loadErc20Book(client, w, def.vault, def.shareAssetId)
    let snapshots: Array<{ claimants: Array<[string, bigint]>; outstanding: bigint }> | null = null
    const at = (h: number) => {
      if (!snapshots) {
        snapshots = []
        const c = book.cursor(def.shareAssetId)
        for (let i = 0; i < w.hours; i++) {
          c.advanceTo(hourStart(i))
          snapshots.push(juicerVaultClaimants(def.vault, c.balances, requests, hourStart(i)))
        }
      }
      return snapshots[h]
    }
    const kind = juicerVaultVia(def)
    resolvers.set(ethMappedAccount(def.vault), {
      kind,
      async resolve(ledger: Ledger): Promise<CustodyResolution> {
        const H = ledger.amounts.length
        const parts = new Map<string, Ledger>()
        const remainder = zeros(H)
        for (let h = 0; h < H; h++) {
          const I = ledger.amounts[h]
          if (I === 0n) continue
          const { claimants, outstanding } = at(h)
          if (outstanding <= 0n || !claimants.length) { remainder[h] += I; continue }
          let given = 0n
          for (const [holder, u] of claimants) {
            const part = (I * u) / outstanding
            if (part === 0n) continue
            const account = accountOf(holder)
            let l = parts.get(account)
            if (!l) {
              l = { holder: account, stream: ledger.stream, pot: ledger.pot, via: joinVia(ledger.via, kind), asset: ledger.asset, held: def.shareAssetId, price: ledger.price, amounts: zeros(H), units: zeros(H) }
              parts.set(account, l)
            }
            l.amounts[h] += part
            l.units![h] = u
            given += part
          }
          remainder[h] += I - given
        }
        return { parts: [...parts.values()], remainder, remainderVia: JUICER_REMAINDER_VIA }
      },
    })
  }

  // The loop: to the vaults by their units, the protocol's fee share of each vault's part to the fee controller.
  const feeAccount = ethMappedAccount(JUICER_FEE_CONTROLLER)
  resolvers.set(ethMappedAccount(JUICER_SUBLOOP), {
    kind: JUICER_LOOP_VIA,
    async resolve(ledger: Ledger): Promise<CustodyResolution> {
      const H = ledger.amounts.length
      const via = joinVia(ledger.via, JUICER_LOOP_VIA)
      const parts = new Map<string, Ledger>()
      const unsplit = zeros(H)
      const rounding = zeros(H)
      const part = (account: string, partVia: string, held: number | null): Ledger => {
        const key = `${account}|${partVia}`
        let l = parts.get(key)
        if (!l) {
          l = { holder: account, stream: ledger.stream, pot: ledger.pot, via: partVia, asset: ledger.asset, held, price: ledger.price, amounts: zeros(H) }
          parts.set(key, l)
        }
        return l
      }
      for (let h = 0; h < H; h++) {
        const I = ledger.amounts[h]
        if (I === 0n) continue
        const block = hourStart(h)
        const split = juicerLoopSplitAt(events, loopReads, block)
        if (!split) { unsplit[h] += I; continue }
        let given = 0n
        for (const def of JUICER_VAULTS) {
          const u = split.units.get(def.vault) ?? 0n
          if (u <= 0n) continue
          const vaultPart = (I * u) / split.total
          const fee = (vaultPart * juicerFeeBpsAt(events, def.vault, block)) / 10_000n
          if (fee !== 0n) part(feeAccount, joinVia(via, JUICER_FEE_VIA), null).amounts[h] += fee
          if (vaultPart - fee !== 0n) part(ethMappedAccount(def.vault), via, null).amounts[h] += vaultPart - fee
          given += vaultPart
        }
        rounding[h] += I - given
      }
      return { parts: [...parts.values()], remainder: unsplit, remainderVia: JUICER_LOOP_UNSPLIT_VIA, more: [{ via: UNATTRIBUTED_VIA.rounding, amounts: rounding }] }
    },
  })
  return { resolvers, protocolAccounts }
}
