import type { ClickHouseClient } from '../db/client.ts'
import { DISTRIBUTOR_ROW_PREFIX } from './mmRewardsProgram.ts'

// Read side of the claimable money-market incentive snapshot
// (`mm_incentive_snapshots`, published by the `mm-incentives` refresher in
// mmIncentiveService.ts). One definition for every surface that states an
// account's CURRENT unclaimed lending incentives — the explorer's account and tag
// pages, the accounts directory, the public /v1/accounts/balances and the Data
// API's /money-market/positions — so no two of them can read it two ways.
//
// A reward is one (holder, reward asset). `claimable` is the chain's own
// RewardsController.getAllUserRewards at the snapshot block: what one
// claimAllRewards would pay then (accrued plus every incentivized asset's pending
// accrual since the holder's last update). Beside it the log arithmetic
// (`model`: the B0 anchor plus every indexed Accrued less every RewardsClaimed,
// plus pending = scaled balance × (programme index − user index) / 10^decimals
// per asset); `reconciled` says the two agree to the unit. The published figure is
// always the chain's, less what the indexed RewardsClaimed say was claimed after
// the snapshot block (so a claimed reward is never counted twice).
//
// Beside the controller's, the generation carries the main market's rewards
// distributor (mmRewardsProgram.ts, the off-chain PRIME programme): one row per
// account it owes, asset_address DISTRIBUTOR_ROW_PREFIX + the distributor, read as
// a reward of its own with source 'distributor' — the tree's cumulative claimable
// less the distributor's claimed() at the snapshot block, brought forward over the
// distributor's Claimed events indexed after it. It has no log model, so it never
// enters the controller's reconciliation.
//
// A LEAF over the one table (plus its state pointer and the claims after its
// block), so the Data API and the public API can import it.

export interface MmIncentiveLeg {
  /** The incentivized asset (an aToken contract). */
  assetAddress: string
  scaledBalance: bigint
  userIndex: bigint
  /** The programme's index projected to the snapshot block (the chain's getAssetIndex). */
  assetIndex: bigint
  /** scaledBalance × (assetIndex − userIndex) / 10^decimals — the log model's pending accrual. */
  pending: bigint
}

/** Who pays a reward: the Aave RewardsController (claimAllRewards) or the main market's rewards distributor (a merkle claim). */
export type MmIncentiveSource = 'controller' | 'distributor'

export interface MmIncentiveReward {
  source: MmIncentiveSource
  /** The holder's ETH-form AccountId32 — the form every money-market table keys on. */
  accountId: string
  holder: string
  marketKey: string
  rewardAssetId: number
  rewardAddress: string
  /** What one claim would pay at the snapshot block: the controller's getAllUserRewards, or the distributor's owed amount. */
  claimable: bigint
  /** The log model's claimable (accrued + Σ pending). */
  model: bigint
  /** The log model's stored accrual (anchor + Σ Accrued − Σ claimed). */
  accrued: bigint
  reconciled: boolean
  /**
   * 0 < claimable < the reward asset's existential deposit. A claimAllRewards
   * including it reverts until the account holds that deposit of the asset or the
   * amount grows past it; the reward is owed, not forfeited. Still counted.
   */
  belowExistentialDeposit: boolean
  legs: MmIncentiveLeg[]
}

export interface MmIncentiveSnapshotView {
  /** The block the snapshot was read at; null while none is published or it is stale. */
  asOfBlock: number | null
  rewards: MmIncentiveReward[]
}

// Above this pointer age the snapshot is not published at all — the farm-reward
// snapshot's gate (LM_REWARD_MAX_AGE_SECONDS) and reasoning: the refresher runs
// every ~3 minutes, so 15 minutes is several failed cycles in a row.
export const MM_INCENTIVE_MAX_AGE_SECONDS = 15 * 60

/** An H160's ETH-form AccountId32. */
export const mmIncentiveAccountForm = (h160: string): string => `0x45544800${h160.toLowerCase().slice(2)}0000000000000000`

/**
 * SQL for readers that aggregate the snapshot in ClickHouse (the accounts
 * directory): the current generation's snapshot_id, or '' — which names no
 * partition — when none is published or its pointer is older than
 * MM_INCENTIVE_MAX_AGE_SECONDS. The gate loadMmIncentives applies.
 */
export function currentMmIncentiveGenerationSql(): string {
  return `(SELECT if(count() > 0 AND dateDiff('second', max(computed_at), now()) <= ${MM_INCENTIVE_MAX_AGE_SECONDS},
      argMax(snapshot_id, computed_at), '')
    FROM price_data.mm_incentive_snapshot_state WHERE snapshot_key = 'current')`
}

interface StoredRow {
  account_id: string; holder: string; reward_asset_id: number; reward_address: string; asset_address: string; market_key: string
  claimable_s: string; model_s: string; accrued_s: string; pending_s: string; scaled_s: string; user_index_s: string; asset_index_s: string
  reconciled: number; below_ed: number; snapshot_block: number
}

const big = (v: unknown): bigint => (/^\d+$/.test(String(v ?? '')) ? BigInt(String(v)) : 0n)

/**
 * The `asset_address` of a per-market total row. A (holder, reward) whose
 * programmes span several isolated markets carries, beside its '' pair total, one
 * row per market with the chain's claimable for that market's aTokens alone
 * (getAllUserRewards over them), so the reward is filed under each market it is
 * owed in rather than under one of them. A pair within one market has only the ''
 * row. SQL readers summing an account's rewards read the '' rows only.
 */
export const MM_MARKET_ROW_PREFIX = 'market:'

/** The market a reward spanning `markets` files its unsplit part under: core when among them, else the first. */
export const mmPrimaryMarket = (markets: readonly string[]): string =>
  markets.includes('core') ? 'core' : [...markets].sort()[0] ?? 'core'

/**
 * Stored rows → rewards: the '' row per (account, reward) carries the totals, the
 * asset rows its legs; a pair with per-market rows becomes one reward per market
 * (that market's claimable and legs, the pair's reconciliation), so its amounts
 * sum to the pair total. Pure.
 */
export function mmIncentiveRewardsFromStored(rows: StoredRow[]): MmIncentiveReward[] {
  const byKey = new Map<string, MmIncentiveReward>()
  const markets = new Map<string, StoredRow[]>()
  const legs: StoredRow[] = []
  const distributor: MmIncentiveReward[] = []
  for (const r of rows) {
    const pair = `${r.account_id}|${r.reward_asset_id}`
    if (r.asset_address.startsWith(DISTRIBUTOR_ROW_PREFIX)) {
      distributor.push({
        source: 'distributor', accountId: r.account_id, holder: r.holder, marketKey: r.market_key, rewardAssetId: Number(r.reward_asset_id), rewardAddress: r.reward_address,
        claimable: big(r.claimable_s), model: big(r.model_s), accrued: 0n, reconciled: true, belowExistentialDeposit: Number(r.below_ed) === 1, legs: [],
      })
      continue
    }
    if (r.asset_address.startsWith(MM_MARKET_ROW_PREFIX)) { (markets.get(pair) ?? markets.set(pair, []).get(pair)!).push(r); continue }
    if (r.asset_address !== '') { legs.push(r); continue }
    byKey.set(pair, {
      source: 'controller', accountId: r.account_id, holder: r.holder, marketKey: r.market_key, rewardAssetId: Number(r.reward_asset_id), rewardAddress: r.reward_address,
      claimable: big(r.claimable_s), model: big(r.model_s), accrued: big(r.accrued_s),
      reconciled: Number(r.reconciled) === 1, belowExistentialDeposit: Number(r.below_ed) === 1, legs: [],
    })
  }
  const out: MmIncentiveReward[] = []
  for (const [pair, total] of byKey) {
    const pairLegs = legs.filter(r => `${r.account_id}|${r.reward_asset_id}` === pair)
    const leg = (r: StoredRow): MmIncentiveLeg => ({
      assetAddress: r.asset_address, scaledBalance: big(r.scaled_s), userIndex: big(r.user_index_s), assetIndex: big(r.asset_index_s), pending: big(r.pending_s),
    })
    const split = markets.get(pair)
    if (!split?.length) { out.push({ ...total, legs: pairLegs.map(leg) }); continue }
    for (const m of split) {
      out.push({
        ...total, marketKey: m.market_key, claimable: big(m.claimable_s), model: big(m.model_s), accrued: big(m.accrued_s),
        legs: pairLegs.filter(r => r.market_key === m.market_key).map(leg),
      })
    }
  }
  return [...out, ...distributor]
}

/** The key withPostSnapshotClaims matches a reward's claims by: its payer, holder and reward address, lowercase. */
export const postSnapshotClaimKey = (source: MmIncentiveSource, holder: string, reward: string): string => `${source}|${holder.toLowerCase()}|${reward.toLowerCase()}`

/**
 * The rewards brought forward over the claims indexed after the snapshot block
 * (the controller's RewardsClaimed, the distributor's Claimed — each against its
 * own payer's rewards): per (payer, holder, reward) the claimed amount is
 * subtracted, floored at zero — across a split pair's markets in order — so a
 * reward claimed since the snapshot is not counted again beside the wallet
 * balance it became (a claim pays at least what the snapshot showed, so a claimed
 * pair reads 0). Keyed by postSnapshotClaimKey. Nothing is added: accrual since
 * the snapshot waits for the next generation. Pure.
 */
export function withPostSnapshotClaims(rewards: MmIncentiveReward[], claimed: ReadonlyMap<string, bigint>): MmIncentiveReward[] {
  if (!claimed.size) return rewards
  const left = new Map(claimed)
  return rewards.map(r => {
    const key = postSnapshotClaimKey(r.source, r.holder, r.rewardAddress)
    const paid = left.get(key) ?? 0n
    if (paid <= 0n) return r
    const take = paid < r.claimable ? paid : r.claimable
    left.set(key, paid - take)
    const claimable = r.claimable - take
    return { ...r, claimable, belowExistentialDeposit: claimable > 0n && r.belowExistentialDeposit }
  })
}

/**
 * Both payers' claims as one relation (src, u, reward, claimed_raw), each replay-
 * deduplicated by its event identity, over `where` — a predicate on user_address
 * and block_height that both tables share.
 */
function claimsAfterSql(where: string): string {
  return `SELECT src, u, reward, sum(amt) AS claimed_raw FROM (
        SELECT 'controller' AS src, user_address AS u, reward_address AS reward, any(amount) AS amt
        FROM price_data.mm_incentive_claims WHERE ${where}
        GROUP BY u, reward, block_height, event_index
        UNION ALL
        SELECT 'distributor' AS src, user_address AS u, reward_address AS reward, any(amount) AS amt
        FROM price_data.mm_distributor_claims WHERE ${where}
        GROUP BY u, reward, block_height, event_index
      ) GROUP BY src, u, reward`
}

/** Both payers' claims after `block` per postSnapshotClaimKey. */
async function loadPostSnapshotClaims(client: ClickHouseClient, holders: string[], block: number): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>()
  if (!holders.length) return out
  const res = await client.query({
    query: `-- mm:incentive-post-snapshot-claims
      SELECT src, u, reward, toString(claimed_raw) AS amount_s FROM (
        ${claimsAfterSql('user_address IN {holders:Array(String)} AND block_height > {block:UInt32}')}
      )`,
    query_params: { holders, block },
    format: 'JSONEachRow',
    clickhouse_settings: { log_comment: 'mm:incentive-post-snapshot-claims' },
  })
  for (const r of await res.json<{ src?: string; u?: string; reward?: string; amount_s?: string }>()) {
    if (typeof r.u !== 'string' || typeof r.reward !== 'string' || (r.src !== 'controller' && r.src !== 'distributor')) continue
    out.set(postSnapshotClaimKey(r.src, r.u, r.reward), big(r.amount_s))
  }
  return out
}

/**
 * SQL for readers that aggregate the snapshot in ClickHouse (the accounts
 * directory): one row per payer and (holder, reward) total of `generationSql`'s
 * generation — the controller's pair total and the distributor's row, so a holder
 * owed one reward by both has two rows — with `account_id` (the holder's ETH-form
 * id), `reward_asset_id` and `counted_raw`, the claimable less its payer's claims
 * indexed after the snapshot block, floored at zero: withPostSnapshotClaims
 * restated once for SQL.
 */
export function mmCountedIncentiveRowsSql(generationSql: string): string {
  const rows = `SELECT *, if(asset_address = '', 'controller', 'distributor') AS src FROM price_data.mm_incentive_snapshots
    WHERE snapshot_id = ${generationSql} AND (asset_address = '' OR startsWith(asset_address, '${DISTRIBUTOR_ROW_PREFIX}'))`
  return `SELECT i.account_id AS account_id, i.reward_asset_id AS reward_asset_id,
      toUInt256(greatest(toInt256(i.claimable_raw) - toInt256(ifNull(c.claimed_raw, 0)), toInt256(0))) AS counted_raw
    FROM (${rows}) i
    LEFT JOIN (
      ${claimsAfterSql(`user_address IN (SELECT holder FROM (${rows}))
          AND block_height > (SELECT max(snapshot_block) FROM (${rows}))`)}
    ) c ON c.src = i.src AND c.u = i.holder AND c.reward = i.reward_address`
}

/**
 * The current generation's rewards for `h160s`, by the table's primary-key
 * prefix (snapshot_id, account_id). Like loadLmRewards, the rows statement pins
 * the generation itself, so it can never name one the refresher has since
 * dropped; the pointer read serves only the staleness gate and the block of an
 * account with no rows. The rewards are then brought forward over the claims
 * indexed after the snapshot block (withPostSnapshotClaims).
 */
export async function loadMmIncentives(client: ClickHouseClient, h160s: string[], opts: { maxAgeSeconds?: number } = {}): Promise<MmIncentiveSnapshotView> {
  // The age gate is the CURRENT figure's; the incentive history reads the newest
  // generation whatever its age (maxAgeSeconds: Infinity) for its reconciliation
  // flags only — never for an amount.
  const maxAge = opts.maxAgeSeconds ?? MM_INCENTIVE_MAX_AGE_SECONDS
  const state = await client.query({
    query: `-- mm:incentive-snapshot-state
      SELECT argMax(snapshot_id, computed_at) AS snapshot_id, argMax(block_height, computed_at) AS block_height,
        toUInt32(greatest(0, dateDiff('second', max(computed_at), now()))) AS age_seconds
      FROM price_data.mm_incentive_snapshot_state WHERE snapshot_key = 'current'`,
    format: 'JSONEachRow',
    clickhouse_settings: { log_comment: 'mm:incentive-snapshot-state' },
  })
  const pointer = (await state.json<{ snapshot_id: string; block_height: number; age_seconds: number }>())[0]
  if (!pointer?.snapshot_id || Number(pointer.age_seconds) > maxAge) return { asOfBlock: null, rewards: [] }
  const accs = [...new Set(h160s.map(h => h.toLowerCase()))].filter(h => /^0x[0-9a-f]{40}$/.test(h)).map(mmIncentiveAccountForm)
  if (!accs.length) return { asOfBlock: Number(pointer.block_height), rewards: [] }
  const res = await client.query({
    query: `-- mm:incentive-snapshot-rows
      SELECT account_id, holder, reward_asset_id, reward_address, asset_address, market_key,
        toString(claimable_raw) AS claimable_s, toString(model_raw) AS model_s, toString(accrued_raw) AS accrued_s,
        toString(pending_raw) AS pending_s, toString(scaled_balance) AS scaled_s, toString(user_index) AS user_index_s,
        toString(asset_index) AS asset_index_s, reconciled, below_ed, snapshot_block
      FROM price_data.mm_incentive_snapshots
      WHERE snapshot_id = (
          SELECT argMax(snapshot_id, computed_at) FROM price_data.mm_incentive_snapshot_state WHERE snapshot_key = 'current'
        )
        AND account_id IN {accs:Array(String)}
      ORDER BY account_id, reward_asset_id, asset_address`,
    query_params: { accs },
    format: 'JSONEachRow',
    clickhouse_settings: { log_comment: 'mm:incentive-snapshot-rows' },
  })
  const stored = await res.json<StoredRow>()
  if (!stored.length) return { asOfBlock: Number(pointer.block_height), rewards: [] }
  const asOfBlock = Number(stored[0].snapshot_block)
  const rewards = mmIncentiveRewardsFromStored(stored)
  const holders = [...new Set(rewards.map(r => r.holder.toLowerCase()))].sort()
  return { asOfBlock, rewards: withPostSnapshotClaims(rewards, await loadPostSnapshotClaims(client, holders, asOfBlock)) }
}
