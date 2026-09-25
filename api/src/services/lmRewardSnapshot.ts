import type { ClickHouseClient } from '../db/client.ts'

// Read side of the unclaimed liquidity-mining reward snapshot
// (`lm_reward_snapshots`, published by the `lm-rewards` refresher in
// lmRewardService.ts). One definition for every surface that states an
// account's CURRENT unclaimed farm rewards — the explorer's account and tag pages,
// the Data API's /liquidity/positions, the public /v1/accounts/balances and
// the accounts directory — so no two of them can read it two ways.
//
// A row is one farm entry: (deposit, yield farm). `claimable` is what one
// `claim_rewards(deposit, yield farm)` would pay at the snapshot block — the
// loyalty-adjusted reward less what the entry already claimed. `projected`
// says it was brought to that block: always for a stopped or terminated farm
// (their reward stopped accruing) and for an active farm synced in the current
// period; for an active farm it requires the runtime's own projection of the
// farm's rpvs at the head (a DryRunApi claim). An active farm whose projection
// failed that cycle keeps its value as of the farm's last on-chain sync —
// stated as `projected: false`, a firm lower bound, never an estimate.
// Every read then subtracts what the indexed events say left the entry after the
// snapshot block (claims, withdrawals), and an entry whose claim cannot reach its
// owner (below the existential deposit, owner holding less) counts 0 while its
// amount stays visible (`payable`, lmCountedClaimable).
//
// A LEAF over the one table (plus its state pointer and the deposit-farm events
// after its block), so the Data API can import it.

export type LmPallet = 'omnipool' | 'xyk'
export type LmFarmState = 'active' | 'stopped' | 'terminated'

export interface LmRewardRow {
  accountId: string
  pallet: LmPallet
  depositId: string
  yieldFarmId: number
  globalFarmId: number
  /** Omnipool: the incentivized asset id; XYK: the pool account (hex AccountId32). */
  poolKey: string
  /** The Omnipool position NFT the deposit locks; null for XYK. */
  positionId: string | null
  /** The XYK pool's LP share asset; null for Omnipool. */
  lpAssetId: number | null
  rewardAssetId: number
  farmState: LmFarmState
  claimable: bigint
  projected: boolean
  maxReward: bigint
  forfeitIfWithdrawnNow: bigint
  /** FixedU128 inner of the loyalty multiplier (1e18 = 100%). */
  loyalty: bigint
  /** The yield farm's last on-chain sync, in its periods (relay blocks / blocks_per_period). */
  farmUpdatedAtPeriod: number
  currentPeriod: number
  /**
   * 0 < claimable < the reward asset's existential deposit (AssetRegistry's, the
   * one the pallet compares against). Such a claim reaches the owner only while
   * the owner's free balance of the asset is at least that deposit — see `payable`.
   */
  belowExistentialDeposit: boolean
  /**
   * Whether a claim now pays the owner: false exactly when the amount is below
   * the existential deposit AND the owner's free balance of the reward asset
   * (Currencies::free_balance at the snapshot block — the pallet's own check) is
   * below it too. The pallet then sends the reward to the treasury: `claim_rewards`
   * reverts (ZeroClaimedRewards) and a withdraw pays it away. An unpayable entry
   * keeps its `claimable` visible but counts 0 in every value (lmCountedClaimable).
   */
  payable: boolean
}

/** The amount an entry adds to an account's value: its claimable when a claim pays the owner, else 0. */
export const lmCountedClaimable = (r: Pick<LmRewardRow, 'claimable' | 'payable'>): bigint => (r.payable ? r.claimable : 0n)

export interface LmRewardSnapshot {
  /** The block the snapshot was read at; null while no snapshot has been published. */
  asOfBlock: number | null
  rows: LmRewardRow[]
}

export interface StoredLmRewardRow {
  account_id: string; pallet: string; deposit_id: string; yield_farm_id: number; global_farm_id: number
  pool_key: string; position_id: string; lp_asset_id: number | null; reward_asset_id: number; farm_state: string
  settled_s: string; projected_s: string | null; max_reward_s: string; forfeit_s: string
  loyalty_s: string; farm_updated_at_period: number; current_period: number
  below_ed: number; snapshot_block: number
}

const big = (v: unknown): bigint => (/^\d+$/.test(String(v ?? '')) ? BigInt(String(v)) : 0n)

// `below_ed` is a three-state code: 0 — not below the existential deposit; 1 —
// below it, and the owner holds at least that deposit of the reward asset (the
// claim pays the owner); 2 — below it and the owner holds less (the claim pays the
// owner nothing). A generation written before the owner-balance read has only 0/1.
export const LM_BELOW_ED_UNPAYABLE = 2

export function lmRewardRowFromStored(r: StoredLmRewardRow): LmRewardRow {
  const projected = r.projected_s != null
  return {
    accountId: r.account_id,
    pallet: r.pallet === 'xyk' ? 'xyk' : 'omnipool',
    depositId: String(r.deposit_id),
    yieldFarmId: Number(r.yield_farm_id),
    globalFarmId: Number(r.global_farm_id),
    poolKey: r.pool_key,
    positionId: r.position_id ? String(r.position_id) : null,
    lpAssetId: r.lp_asset_id == null ? null : Number(r.lp_asset_id),
    rewardAssetId: Number(r.reward_asset_id),
    farmState: r.farm_state === 'terminated' ? 'terminated' : r.farm_state === 'stopped' ? 'stopped' : 'active',
    claimable: big(projected ? r.projected_s : r.settled_s),
    projected,
    maxReward: big(r.max_reward_s),
    forfeitIfWithdrawnNow: big(r.forfeit_s),
    loyalty: big(r.loyalty_s),
    farmUpdatedAtPeriod: Number(r.farm_updated_at_period),
    currentPeriod: Number(r.current_period),
    belowExistentialDeposit: Number(r.below_ed) > 0,
    payable: Number(r.below_ed) !== LM_BELOW_ED_UNPAYABLE,
  }
}

/** One post-snapshot deposit-farm event (lm_deposit_farm_events), deduplicated by its identity. */
export interface LmPostSnapshotEvent {
  pallet: LmPallet
  depositId: string
  /** 0 for DepositDestroyed, which names no yield farm. */
  yieldFarmId: number
  kind: 'claimed' | 'withdrawn' | 'destroyed'
  amount: bigint
}

/**
 * The snapshot's rows brought forward over what the chain did to them AFTER the
 * snapshot block, from the indexed deposit-farm events: an entry's
 * `RewardClaimed` amounts since are subtracted from its claimable, floored at
 * zero (a claim pays everything claimable at its block, which is never less than
 * the snapshot's amount, so a claimed entry reads 0 — never the reward twice, once
 * in the wallet and once still unclaimed); an entry withdrawn from its yield farm
 * or a deposit destroyed since is gone and reads 0. Nothing is ADDED: accrual
 * since the snapshot waits for the next generation. Pure.
 */
export function withPostSnapshotEvents(rows: LmRewardRow[], events: LmPostSnapshotEvent[]): LmRewardRow[] {
  if (!events.length) return rows
  const claimed = new Map<string, bigint>()
  const gone = new Set<string>()
  for (const e of events) {
    const entry = `${e.pallet}|${e.depositId}|${e.yieldFarmId}`
    if (e.kind === 'claimed') claimed.set(entry, (claimed.get(entry) ?? 0n) + e.amount)
    else if (e.kind === 'withdrawn') gone.add(entry)
    else gone.add(`${e.pallet}|${e.depositId}|*`)
  }
  return rows.map(r => {
    const entry = `${r.pallet}|${r.depositId}|${r.yieldFarmId}`
    const paid = claimed.get(entry) ?? 0n
    if (!paid && !gone.has(entry) && !gone.has(`${r.pallet}|${r.depositId}|*`)) return r
    const left = gone.has(entry) || gone.has(`${r.pallet}|${r.depositId}|*`) ? 0n : r.claimable > paid ? r.claimable - paid : 0n
    return { ...r, claimable: left, belowExistentialDeposit: left > 0n && r.belowExistentialDeposit }
  })
}

const LM_EVENT_KINDS = new Set(['claimed', 'withdrawn', 'destroyed'])

/** The deposit-farm events after `block` for the deposits of `rows` (every row shares the generation's block). */
async function loadPostSnapshotEvents(client: ClickHouseClient, rows: LmRewardRow[], block: number): Promise<LmPostSnapshotEvent[]> {
  const deposits = [...new Set(rows.map(r => r.depositId))].sort()
  if (!deposits.length) return []
  const res = await client.query({
    query: `-- lm:reward-post-snapshot-events
      SELECT pallet, deposit_id, any(yield_farm_id) AS yield_farm_id, any(event_kind) AS kind, toString(any(amount)) AS amount_s
      FROM price_data.lm_deposit_farm_events
      WHERE pallet IN ('omnipool', 'xyk') AND deposit_id IN {deposits:Array(String)} AND block_height > {block:UInt32}
        AND event_kind IN ('claimed', 'withdrawn', 'destroyed')
      GROUP BY pallet, deposit_id, block_height, event_index`,
    query_params: { deposits, block },
    format: 'JSONEachRow',
    clickhouse_settings: { log_comment: 'lm:reward-post-snapshot-events' },
  })
  const out: LmPostSnapshotEvent[] = []
  for (const e of await res.json<{ pallet: string; deposit_id: string; yield_farm_id: number; kind: string; amount_s: string }>()) {
    if (!LM_EVENT_KINDS.has(e.kind) || (e.pallet !== 'omnipool' && e.pallet !== 'xyk')) continue
    out.push({ pallet: e.pallet, depositId: String(e.deposit_id), yieldFarmId: Number(e.yield_farm_id), kind: e.kind as LmPostSnapshotEvent['kind'], amount: big(e.amount_s) })
  }
  return out
}

// Above this pointer age the snapshot is not published at all: the refresher
// runs every ~2 minutes, so 15 minutes is several failed cycles in a row (node
// down, reads failing), and a figure that old reads as current when it is not.
export const LM_REWARD_MAX_AGE_SECONDS = 15 * 60

/**
 * SQL for readers that aggregate the snapshot in ClickHouse rather than per
 * account (the accounts directory): the current generation's snapshot_id, or ''
 * — which names no partition — when none is published or its pointer is older
 * than LM_REWARD_MAX_AGE_SECONDS. The same gate loadLmRewards applies, so a
 * directory row and the account page it links to take the rewards in or leave
 * them out together.
 */
export function currentLmRewardGenerationSql(): string {
  return `(SELECT if(count() > 0 AND dateDiff('second', max(computed_at), now()) <= ${LM_REWARD_MAX_AGE_SECONDS},
      argMax(snapshot_id, computed_at), '')
    FROM price_data.lm_reward_snapshot_state WHERE snapshot_key = 'current')`
}

/**
 * SQL for one snapshot row's claimable-now amount (raw units of reward_asset_id):
 * the runtime-projected amount where the projection succeeded, else the settled
 * one — lmRewardRowFromStored's rule, restated once for SQL readers.
 */
export const LM_CLAIMABLE_RAW_SQL = 'ifNull(claimable_projected_raw, claimable_settled_raw)'

/**
 * SQL for readers that aggregate the snapshot in ClickHouse (the accounts
 * directory): one row per snapshot entry of `generationSql`'s generation —
 * `account_id`, `reward_asset_id` and `counted_raw`, the amount the entry adds to
 * the account's value. It restates loadLmRewards' rules once for SQL: an unpayable
 * entry (below_ed = 2) counts 0, and the entry is brought forward over the
 * indexed deposit-farm events after the snapshot block (withPostSnapshotEvents) —
 * RewardClaimed amounts subtracted and floored at zero, a withdrawn entry or a
 * destroyed deposit 0. The event read is bounded by the generation's own deposit
 * ids, a prefix of the event table's key.
 */
export function lmCountedRewardRowsSql(generationSql: string): string {
  const rows = `SELECT * FROM price_data.lm_reward_snapshots WHERE snapshot_id = ${generationSql}`
  return `SELECT r.account_id AS account_id, r.reward_asset_id AS reward_asset_id,
      if(r.below_ed = ${LM_BELOW_ED_UNPAYABLE} OR ifNull(ev.gone, 0) = 1 OR ifNull(evd.gone, 0) = 1, toUInt256(0),
        toUInt256(greatest(toInt256(${LM_CLAIMABLE_RAW_SQL}) - toInt256(ifNull(ev.claimed, 0)), toInt256(0)))) AS counted_raw
    FROM (${rows}) r
    LEFT JOIN (
      SELECT pallet, deposit_id, yield_farm_id, sumIf(amount, kind = 'claimed') AS claimed, toUInt8(countIf(kind = 'withdrawn') > 0) AS gone
      FROM (
        SELECT pallet, deposit_id, any(yield_farm_id) AS yield_farm_id, any(event_kind) AS kind, any(amount) AS amount
        FROM price_data.lm_deposit_farm_events
        WHERE pallet IN ('omnipool', 'xyk') AND deposit_id IN (SELECT deposit_id FROM (${rows}))
          AND block_height > (SELECT max(snapshot_block) FROM (${rows}))
          AND event_kind IN ('claimed', 'withdrawn', 'destroyed')
        GROUP BY pallet, deposit_id, block_height, event_index
      )
      WHERE kind IN ('claimed', 'withdrawn')
      GROUP BY pallet, deposit_id, yield_farm_id
    ) ev ON ev.pallet = r.pallet AND ev.deposit_id = r.deposit_id AND ev.yield_farm_id = r.yield_farm_id
    LEFT JOIN (
      SELECT DISTINCT pallet, deposit_id, toUInt8(1) AS gone
      FROM price_data.lm_deposit_farm_events
      WHERE pallet IN ('omnipool', 'xyk') AND deposit_id IN (SELECT deposit_id FROM (${rows}))
        AND block_height > (SELECT max(snapshot_block) FROM (${rows}))
        AND event_kind = 'destroyed'
    ) evd ON evd.pallet = r.pallet AND evd.deposit_id = r.deposit_id`
}

/**
 * The current generation's rows for `accountIds` (lowercase hex AccountId32),
 * by the table's primary key prefix (snapshot_id, account_id).
 *
 * The rows statement pins the generation itself (a subquery on the pointer), so
 * it can never name a generation the refresher has since dropped — a separate
 * pointer read followed by a rows read could straddle a republish and serve
 * zero rows as "no rewards". The pointer read here serves only the staleness
 * gate and the block of an account with no rows; with rows, the block is the
 * rows' own `snapshot_block`. The rows are then brought forward over the claims,
 * withdrawals and destroyed deposits indexed after that block
 * (withPostSnapshotEvents), so a reward claimed since the snapshot is not counted
 * a second time beside the wallet balance it became.
 */
export async function loadLmRewards(client: ClickHouseClient, accountIds: string[]): Promise<LmRewardSnapshot> {
  const state = await client.query({
    query: `-- lm:reward-snapshot-state
      SELECT argMax(snapshot_id, computed_at) AS snapshot_id, argMax(block_height, computed_at) AS block_height,
        toUInt32(greatest(0, dateDiff('second', max(computed_at), now()))) AS age_seconds
      FROM price_data.lm_reward_snapshot_state WHERE snapshot_key = 'current'`,
    format: 'JSONEachRow',
    // Named in system.query_log, where the SQL comment does not survive.
    clickhouse_settings: { log_comment: 'lm:reward-snapshot-state' },
  })
  const pointer = (await state.json<{ snapshot_id: string; block_height: number; age_seconds: number }>())[0]
  if (!pointer?.snapshot_id) return { asOfBlock: null, rows: [] }
  if (Number(pointer.age_seconds) > LM_REWARD_MAX_AGE_SECONDS) return { asOfBlock: null, rows: [] }
  const accs = [...new Set(accountIds.map(a => a.toLowerCase()))].filter(a => /^0x[0-9a-f]{64}$/.test(a))
  if (!accs.length) return { asOfBlock: Number(pointer.block_height), rows: [] }
  const res = await client.query({
    query: `-- lm:reward-snapshot-rows
      SELECT account_id, pallet, deposit_id, yield_farm_id, global_farm_id, pool_key, position_id, lp_asset_id,
        reward_asset_id, farm_state, toString(claimable_settled_raw) AS settled_s,
        toString(claimable_projected_raw) AS projected_s,
        toString(max_reward_raw) AS max_reward_s, toString(forfeit_raw) AS forfeit_s, toString(loyalty) AS loyalty_s,
        farm_updated_at_period, current_period, below_ed, snapshot_block
      FROM price_data.lm_reward_snapshots
      WHERE snapshot_id = (
          SELECT argMax(snapshot_id, computed_at) FROM price_data.lm_reward_snapshot_state WHERE snapshot_key = 'current'
        )
        AND account_id IN {accs:Array(String)}
      ORDER BY account_id, pallet, deposit_id, yield_farm_id`,
    query_params: { accs },
    format: 'JSONEachRow',
    clickhouse_settings: { log_comment: 'lm:reward-snapshot-rows' },
  })
  const stored = await res.json<StoredLmRewardRow>()
  if (!stored.length) return { asOfBlock: Number(pointer.block_height), rows: [] }
  const asOfBlock = Number(stored[0].snapshot_block)
  const rows = stored.map(lmRewardRowFromStored)
  return { asOfBlock, rows: withPostSnapshotEvents(rows, await loadPostSnapshotEvents(client, rows, asOfBlock)) }
}
