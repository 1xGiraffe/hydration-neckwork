import type { ClickHouseClient } from '../db/client.ts'
import { cached } from './cache.ts'
import { accountRef, type AccountRef } from './explorerService.ts'
import { foldTreasury, type ProposalFold, type SpendFold, type TreasuryEventRow } from './treasurySpends.ts'
import { allOpengovLifecycle, indexedHead, referendumEnactmentTaskId } from './governanceService.ts'
import { governanceMoments, type BlockMoment } from './governanceRead.ts'
import { referendumTitleFor } from './referendumTitleService.ts'
import { pendingNodeApi } from './pendingHeadService.ts'
import { xxhashAsU8a } from '@polkadot/util-crypto'
import { hexToU8a, u8aConcat, u8aToHex } from '@polkadot/util'
import { substrateAllKeys, substrateStorageBatch } from './substrateRpc.ts'
import { loadPinnedSubstrateBlock } from './pinnedBlock.ts'

// The treasury read model (the MCP's treasury view, the Data API's spends, the
// explorer search's spend hits): the pot (the treasury account's HDX, current and
// weekly), its spends with their state and what anyone may do about them, and the
// proposals the treasury paid at its spend period. Everything is indexed chain data:
// treasury_events (an MV over raw_events) folded by treasurySpends.ts, the account's
// balances from the balance projections, and the referendum whose enactment approved
// a spend (its named enactment task dispatched in the spend's approval block).

let client: ClickHouseClient
export function initGovernanceTreasury(c: ClickHouseClient): void { client = c }

/** `modlpy/trsry` — the Treasury pallet's account (PalletId *b"py/trsry"). */
export const TREASURY_ACCOUNT = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'

export async function treasuryEvents(): Promise<TreasuryEventRow[]> {
  return cached('governance:treasury:events', 6_000, async () => {
    const res = await client.query({
      query: `-- governance:treasury-events
        SELECT event_name, block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, args_json
        FROM price_data.treasury_events FINAL ORDER BY block_height, event_index`,
      format: 'JSONEachRow',
    })
    return (await res.json<TreasuryEventRow>()).map(r => ({ ...r, block_height: Number(r.block_height), event_index: Number(r.event_index) }))
  })
}

// ---- the spends as storage holds them ----
//
// A payout re-dates a spend's expiry in storage (now + the payout period) and no event
// states the new date, so the spends still in storage are read at one pinned block by
// the coordinated refresher and laid over the event fold: the stored expiry and payment
// state win wherever storage has the spend, unless an event indexed after the pinned
// block (a payout, a failed payment, a clear, a void) moved it since — the later fact
// wins, and the snapshot catches up on its next read. Treasury.Spends (Twox64Concat u32 →
// SpendStatus): asset_kind () (no bytes), amount u128, beneficiary AccountId32,
// valid_from u32, expire_at u32, status PaymentState<()> (0 Pending, 1 Attempted, 2 Failed).

const SPENDS_PREFIX = u8aToHex(u8aConcat(xxhashAsU8a('Treasury', 128), xxhashAsU8a('Spends', 128)))

export interface StoredSpend { expireAt: number; validFrom: number; status: 'pending' | 'attempted' | 'failed' }
let storedSpends: { block: number; spends: Map<number, StoredSpend> } | null = null

export function decodeStoredSpend(hex: string): StoredSpend | null {
  const v = hexToU8a(hex)
  if (v.length !== 16 + 32 + 4 + 4 + 1) return null
  const u32 = (o: number) => (v[o] | (v[o + 1] << 8) | (v[o + 2] << 16) | (v[o + 3] << 24)) >>> 0
  const status = v[56] === 0 ? 'pending' : v[56] === 1 ? 'attempted' : v[56] === 2 ? 'failed' : null
  return status ? { validFrom: u32(48), expireAt: u32(52), status } : null
}

export async function refreshTreasurySpends(): Promise<void> {
  if (!client) return
  const pin = await loadPinnedSubstrateBlock(client, undefined, 'governance:treasury-pin')
  const keys = await substrateAllKeys(SPENDS_PREFIX, undefined, undefined, pin.blockHash)
  const values = keys.length ? await substrateStorageBatch(keys, pin.blockHash) : []
  if (values.some(v => v == null)) return // a partial read is never published
  const spends = new Map<number, StoredSpend>()
  keys.forEach((k, i) => {
    const d = decodeStoredSpend(values[i]!)
    // Key layout: prefix (32 bytes) + twox64 (8 bytes) + the index (u32, little-endian).
    const b = hexToU8a(`0x${k.slice(-8)}`)
    if (d) spends.set((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0, d)
  })
  storedSpends = { block: pin.block, spends }
}

/** Lay the stored spends (read at `stored.block`) over the event fold (pure, for tests). */
export function withStoredSpends(spends: SpendFold[], stored: { block: number; spends: Map<number, StoredSpend> } | null, headBlock: number): SpendFold[] {
  if (!stored) return spends
  const next = headBlock + 1
  return spends.map(s => {
    const st = stored.spends.get(s.index)
    if (!st || s.processedAt || s.voidedAt) return s
    // A payment event after the snapshot's block is newer than what storage said there:
    // the fold only clears failedAt on a later Paid, so a failedAt past the snapshot is
    // the spend's latest payment fact. A payout past the snapshot re-dated the expiry
    // again, so the stored one no longer holds either.
    const paidSince = !!s.paidAt && s.paidAt.blockHeight > stored.block
    const failedSince = !!s.failedAt && s.failedAt.blockHeight > stored.block
    const status = failedSince ? 'failed' as const : paidSince ? 'attempted' as const : st.status
    const expireAt = paidSince ? s.expireAt : st.expireAt
    const lapsed = expireAt != null && next >= expireAt
    const state = status === 'attempted' ? 'paid' as const
      : lapsed ? 'expired' as const
        : status === 'failed' ? 'failed' as const
          : next >= st.validFrom ? 'claimable' as const : 'pending' as const
    return {
      ...s, expireAt, state,
      canPayout: (state === 'claimable' || state === 'failed'),
      canCheckStatus: status === 'attempted' || (expireAt != null && next > expireAt),
    }
  })
}

export async function treasuryFold(): Promise<ReturnType<typeof foldTreasury> & { headBlock: number }> {
  const [rows, headBlock] = await Promise.all([treasuryEvents(), indexedHead()])
  const fold = foldTreasury(rows, headBlock)
  return { ...fold, spends: withStoredSpends(fold.spends, storedSpends, headBlock), headBlock }
}

/** Approval block → the OpenGov referendum whose enactment ran in it (a spend is approved by its enactment). */
async function approvingReferenda(blocks: number[]): Promise<Map<number, number>> {
  const wanted = [...new Set(blocks)].filter(b => b > 0)
  if (!wanted.length) return new Map()
  return cached(`governance:treasury:approvers:${wanted.join(',')}`, 600_000, async () => {
    const lifecycle = await allOpengovLifecycle()
    const byTask = new Map([...lifecycle.keys()].map(i => [referendumEnactmentTaskId(i), i]))
    const res = await client.query({
      query: `SELECT task_id, block_height FROM price_data.scheduler_named_dispatches FINAL
              WHERE block_height IN {blocks:Array(UInt32)} AND event_name = 'Scheduler.Dispatched'`,
      query_params: { blocks: wanted }, format: 'JSONEachRow',
    })
    const out = new Map<number, number>()
    for (const r of await res.json<{ task_id: string; block_height: number }>()) {
      const index = byTask.get(r.task_id)
      // Two enactments in one block would leave the spend's referendum ambiguous: none is named.
      if (index != null) out.set(Number(r.block_height), out.has(Number(r.block_height)) ? -1 : index)
    }
    for (const [b, i] of out) if (i < 0) out.delete(b)
    return out
  })
}

// The runtime's periods, read once from the connected node's metadata (null without one).
async function treasuryPeriods(): Promise<{ spendPeriod: number | null; payoutPeriod: number | null }> {
  return cached('governance:treasury:periods', 3_600_000, async () => {
    const api = pendingNodeApi()
    const c = api?.consts?.treasury as Record<string, { toString(): string }> | undefined
    const n = (v: { toString(): string } | undefined) => (v != null && /^\d+$/.test(v.toString()) ? Number(v.toString()) : null)
    return { spendPeriod: n(c?.spendPeriod), payoutPeriod: n(c?.payoutPeriod) }
  })
}

export interface TreasurySpendRow extends Omit<SpendFold, 'beneficiary' | 'validFrom' | 'expireAt'> {
  beneficiary: AccountRef | null
  validFrom: BlockMoment | null
  expireAt: BlockMoment | null
  referendum: { index: number; title: string | null } | null
}

export interface TreasuryProposalRow extends Omit<ProposalFold, 'beneficiary'> {
  beneficiary: AccountRef | null
  referendum: { index: number; title: string | null } | null
}

export interface TreasuryOverview {
  account: AccountRef
  asOfBlock: number
  /** The treasury account's free HDX at the newest indexed observation (raw, 12 decimals). */
  pot: { free: string; block: number } | null
  /** The pot at the end of each Monday-anchored week (the last observation in it), oldest first. */
  potHistory: { week: string; balance: string }[]
  periods: { spendPeriod: number | null; payoutPeriod: number | null }
  totals: { paidOut: string; spendsPaid: number; awarded: string; proposalsAwarded: number; claimable: number; pending: number }
  spends: TreasurySpendRow[]
  proposals: TreasuryProposalRow[]
}

export async function getTreasury(): Promise<TreasuryOverview> {
  return cached('governance:treasury:overview', 6_000, async () => {
    const [fold, periods, potRows, weekly] = await Promise.all([
      treasuryFold(),
      treasuryPeriods(),
      client.query({
        query: `SELECT toString(argMaxMerge(free_state)) AS free, maxMerge(last_block_state) AS b
                FROM price_data.account_asset_latest_balances WHERE account_id = {a:String} AND asset_id = '0'`,
        query_params: { a: TREASURY_ACCOUNT }, format: 'JSONEachRow',
      }).then(r => r.json<{ free: string | null; b: number }>()),
      cached('governance:treasury:weekly', 600_000, async () => {
        const r = await client.query({
          query: `SELECT toString(week_start) AS week, argMaxMerge(balance_state) AS balance
                  FROM price_data.account_balance_weekly WHERE account_id = {a:String} AND asset_id = '0'
                  GROUP BY week_start ORDER BY week_start`,
          query_params: { a: TREASURY_ACCOUNT }, format: 'JSONEachRow',
        })
        const rows = (await r.json<{ week: string; balance: string }>()).filter(x => /^\d+$/.test(x.balance))
        // A week with no observation kept the previous week's balance.
        const out: { week: string; balance: string }[] = []
        const day = 86_400_000
        for (let i = 0; i < rows.length; i++) {
          out.push(rows[i])
          const next = i + 1 < rows.length ? Date.parse(`${rows[i + 1].week}T00:00:00Z`) : Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) + day
          for (let t = Date.parse(`${rows[i].week}T00:00:00Z`) + 7 * day; t < next; t += 7 * day) out.push({ week: new Date(t).toISOString().slice(0, 10), balance: rows[i].balance })
        }
        return out
      }),
    ])
    const approvers = await approvingReferenda([...fold.spends.map(s => s.approvedAt.blockHeight), ...fold.proposals.filter(p => p.origin === 'spend_local').map(p => p.proposedAt.blockHeight)])
    const m = await governanceMoments(fold.spends.flatMap(s => [s.validFrom ?? 0, s.expireAt ?? 0]))
    const refOf = (block: number) => { const i = approvers.get(block); return i == null ? null : { index: i, title: referendumTitleFor('opengov', i) } }
    const spends: TreasurySpendRow[] = fold.spends.map(s => ({
      ...s,
      beneficiary: s.beneficiary ? accountRef(s.beneficiary) : null,
      validFrom: s.validFrom != null ? m.at(s.validFrom) : null,
      expireAt: s.expireAt != null ? m.at(s.expireAt) : null,
      referendum: refOf(s.approvedAt.blockHeight),
    }))
    const proposals: TreasuryProposalRow[] = fold.proposals.map(p => ({
      ...p,
      beneficiary: p.beneficiary ? accountRef(p.beneficiary) : null,
      referendum: p.origin === 'spend_local' ? refOf(p.proposedAt.blockHeight) : null,
    }))
    const paid = fold.spends.filter(s => s.paidAt && !s.failedAt)
    const awarded = fold.proposals.filter(p => p.state === 'awarded')
    const sum = (xs: (string | null)[]) => xs.reduce((t, x) => t + BigInt(x ?? '0'), 0n).toString()
    const pot = potRows[0]?.free && /^\d+$/.test(potRows[0].free) ? { free: potRows[0].free, block: Number(potRows[0].b) } : null
    return {
      account: accountRef(TREASURY_ACCOUNT),
      asOfBlock: fold.headBlock,
      pot,
      potHistory: weekly,
      periods,
      totals: {
        paidOut: sum(paid.map(s => s.amount)), spendsPaid: paid.length,
        awarded: sum(awarded.map(p => p.amount)), proposalsAwarded: awarded.length,
        claimable: fold.spends.filter(s => s.canPayout).length,
        pending: fold.spends.filter(s => s.state === 'pending').length,
      },
      spends,
      proposals,
    }
  })
}
