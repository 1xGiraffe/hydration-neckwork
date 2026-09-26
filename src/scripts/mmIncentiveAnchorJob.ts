import { writeFileSync } from 'node:fs'
import { BOUNDED_QUERY_SETTINGS, type ClickHouseClient } from '../db/client.js'
import { toClickHouseDateTime } from '../raw/json.js'
import { getCompletedRawRanges, missingRawCoverage } from '../raw/ranges.js'
import { unionCandidates, type AnchorMode, type EthCall } from './atokenAnchor.js'
import {
  CONTROLLER_LOGS_FROM, INCENTIVE_TOPIC, NOTHING_ANCHORED, REWARDS_CONTROLLER, incentiveKeysToRead, readIncentiveAnchorKeys, verifyIncentiveAnchor,
  type AnchoredIncentiveKeys, type IncentiveAnchorRow, type Programme,
} from './mmIncentiveAnchor.js'

// The ClickHouse- and RPC-bound half of the money-market incentive ANCHOR (see
// mmIncentiveAnchor.ts for why and what): its candidate set, its table, its
// ingestion-range gate and its capture / verify runs. Shared by the
// anchors loop (snapshot-atoken-anchors.ts --loop, the `atoken-anchor` service),
// which captures it whole once its gate passes and tops it up every cycle after,
// and the manual CLI (snapshot-mm-incentive-anchors.ts).
//
// Candidates (a user can hold an accrual at B0 without holding any incentivized
// aToken there, so balance holders alone are not enough): every address that ever
// appears as a user in a controller log (Accrued, RewardsClaimed), every holder in
// the aToken anchor of a programme asset, every participant of a programme asset's
// own logs, every holder in its contract-first scaled deltas, and every account a
// Substrate transfer or swap of the registry asset over a programme asset (GDOT =
// asset 69 over aGDOT) names at or before B0, as the EVM side keys it (the first
// 20 bytes of the AccountId32); the count per source is logged. The first four are
// fed by EVM logs whose coverage before B0 is partial; the Substrate legs are
// MV-fed from raw_events, which does not share those gaps — measured at B0: 155
// users named by the legs alone, 18 of them with a non-zero anchor state (several
// an unclaimed accrual no surface could publish, since a user the sources do not
// name is no candidate of the mm-incentives refresher either). The collateral
// sweep and the pool's decoded events, the aToken anchor's other sources, named
// no one the four did not. Programmes: those an AssetConfigUpdated configured at
// or before B0.

export interface IncentiveAnchorJob {
  readonly anchorBlock: number
  anchorRowCount(): Promise<number>
  /**
   * The gaps in raw ingestion from CONTROLLER_LOGS_FROM (the backfill low-water,
   * below the controller's first log) to B0; the loop's first capture waits for
   * none, so the candidate set is never read from a partial backfill.
   */
  controllerLogGaps(): Promise<Array<{ fromBlock: number; toBlock: number }>>
  readAnchorRows(): Promise<IncentiveAnchorRow[]>
  /**
   * Read the anchor at B0 and (unless dryRun) insert it. 'full': every key of every
   * candidate; 'top-up': the keys the table holds no row for (incentiveKeysToRead).
   */
  capture(opts: { dryRun: boolean; mode: AnchorMode; outFile?: string | null }): Promise<void>
  /** Re-read every stored row at its anchor block; true when all match (and there are rows). */
  verify(): Promise<boolean>
}

export function createIncentiveAnchorJob(deps: { client: ClickHouseClient; ethCall: EthCall; anchorBlock: number; rpcUrl: string }): IncentiveAnchorJob {
  const { client, ethCall, rpcUrl } = deps
  const B0 = deps.anchorBlock

  async function rows<T>(query: string, params: Record<string, unknown> = {}): Promise<T[]> {
    const res = await client.query({ query, query_params: params, format: 'JSONEachRow', clickhouse_settings: BOUNDED_QUERY_SETTINGS })
    return res.json<T>()
  }

  /** Programmes configured at or before `block`, from the controller's AssetConfigUpdated logs. */
  async function programmesAt(block: number): Promise<Programme[]> {
    return rows<{ asset: string; reward: string }>(`
      SELECT DISTINCT lower(concat('0x', substring(topics[2], 27, 40))) AS asset, lower(concat('0x', substring(topics[3], 27, 40))) AS reward
      FROM price_data.raw_evm_logs
      PREWHERE contract_address = {c:String} AND topic0 = {t:String} AND block_height <= {b:UInt32} AND length(topics) = 3
      ORDER BY asset, reward`, { c: REWARDS_CONTROLLER, t: INCENTIVE_TOPIC.assetConfigUpdated, b: block })
  }

  async function candidateUsers(programmeAssets: string[]): Promise<{ users: string[]; counts: Record<string, number> }> {
    const col = (list: { u: string }[]) => list.map(r => r.u)
    const registryAsset = `SELECT asset_id FROM price_data.assets FINAL WHERE lower(evm_address) IN {assets:Array(String)}`
    const [logUsers, anchorHolders, logParticipants, deltaHolders, registryUsers] = await Promise.all([
      rows<{ u: string }>(`
        SELECT DISTINCT lower(concat('0x', substring(if(topic0 = {acc:String}, topics[4], topics[2]), 27, 40))) AS u
        FROM price_data.raw_evm_logs
        PREWHERE contract_address = {c:String} AND topic0 IN ({acc:String}, {claim:String}) AND length(topics) = 4`,
      { c: REWARDS_CONTROLLER, acc: INCENTIVE_TOPIC.accrued, claim: INCENTIVE_TOPIC.rewardsClaimed }),
      programmeAssets.length
        ? rows<{ u: string }>(`SELECT DISTINCT lower(holder) AS u FROM price_data.atoken_scaled_anchor FINAL
            WHERE contract_address IN {assets:Array(String)} AND holder != ''`, { assets: programmeAssets })
        : Promise.resolve([]),
      programmeAssets.length
        ? rows<{ u: string }>(`SELECT DISTINCT lower(arrayJoin(participants)) AS u FROM price_data.raw_evm_logs
            PREWHERE contract_address IN {assets:Array(String)}`, { assets: programmeAssets })
        : Promise.resolve([]),
      programmeAssets.length
        ? rows<{ u: string }>(`SELECT DISTINCT lower(holder) AS u FROM price_data.atoken_scaled_deltas_by_contract
            WHERE contract_address IN {assets:Array(String)}`, { assets: programmeAssets })
        : Promise.resolve([]),
      programmeAssets.length
        ? rows<{ u: string }>(`SELECT DISTINCT lower(substring(acc, 1, 42)) AS u FROM (
            SELECT from_account AS acc FROM price_data.transfer_activity WHERE asset_id IN (${registryAsset}) AND block_height <= {b0:UInt32}
            UNION ALL SELECT to_account AS acc FROM price_data.transfer_activity WHERE asset_id IN (${registryAsset}) AND block_height <= {b0:UInt32}
            UNION ALL SELECT who AS acc FROM price_data.asset_swap_activity WHERE asset_id IN (${registryAsset}) AND block_height <= {b0:UInt32}
          ) WHERE length(acc) = 66`, { assets: programmeAssets, b0: B0 })
        : Promise.resolve([]),
    ])
    const union = unionCandidates({
      controller_logs: col(logUsers), atoken_anchor: col(anchorHolders), asset_logs: col(logParticipants), scaled_deltas: col(deltaHolders), registry: col(registryUsers),
    })
    return { users: union.holders, counts: union.counts }
  }

  /** What the table already holds, per user and per programme — what a top-up skips. */
  async function anchoredKeys(): Promise<AnchoredIncentiveKeys> {
    const list = await rows<{ u: string; a: string; r: string }>(`
      SELECT DISTINCT lower(user_address) AS u, lower(asset_address) AS a, lower(reward_address) AS r FROM price_data.mm_incentive_anchor FINAL`)
    const users = new Set<string>()
    const programmes = new Set<string>()
    for (const k of list) {
      if (k.u === '') programmes.add(`${k.a}|${k.r}`)
      else users.add(k.u)
    }
    return { users, programmes }
  }

  async function readAnchorRows(): Promise<IncentiveAnchorRow[]> {
    const list = await rows<IncentiveAnchorRow>(`
      SELECT user_address, asset_address, reward_address, toString(value) AS value, anchor_block
      FROM price_data.mm_incentive_anchor FINAL ORDER BY user_address, asset_address, reward_address`)
    return list.map(r => ({ ...r, anchor_block: Number(r.anchor_block) }))
  }

  async function insertRows(anchorRows: IncentiveAnchorRow[]): Promise<void> {
    const updated_at = toClickHouseDateTime(Date.now())
    for (let i = 0; i < anchorRows.length; i += 5000) {
      await client.insert({ table: 'price_data.mm_incentive_anchor', values: anchorRows.slice(i, i + 5000).map(r => ({ ...r, updated_at })), format: 'JSONEachRow' })
    }
  }

  async function programmesOrThrow(): Promise<Programme[]> {
    const programmes = await programmesAt(B0)
    if (!programmes.length) throw new Error(`[mm-incentive-anchor] no incentive programme configured at or before ${B0} in the indexed logs`)
    return programmes
  }

  return {
    anchorBlock: B0,

    async anchorRowCount() {
      return Number((await rows<{ c: string }>('SELECT count() AS c FROM price_data.mm_incentive_anchor'))[0]?.c ?? 0)
    },

    // Bounded by the range table alone.
    async controllerLogGaps() {
      return missingRawCoverage(CONTROLLER_LOGS_FROM, B0, await getCompletedRawRanges(client, CONTROLLER_LOGS_FROM, B0))
    },

    readAnchorRows,

    // A top-up reads only the keys without a row (incentiveKeysToRead): every key
    // of a candidate the table holds no row for — one named since the last capture,
    // or one that read zero everywhere before (a post-B0 user), which is one call
    // per key — and a programme index row the table lacks; a full capture reads them
    // all. Either inserts what read non-zero under the same key, so a repeated row
    // replaces itself.
    async capture({ dryRun, mode, outFile }) {
      const startedAt = Date.now()
      const programmes = await programmesOrThrow()
      const candidates = await candidateUsers([...new Set(programmes.map(p => p.asset))])
      const anchored = mode === 'top-up' ? await anchoredKeys() : NOTHING_ANCHORED
      const keys = incentiveKeysToRead(candidates.users, programmes, anchored, mode)
      const usersRead = new Set(keys.map(k => k.user_address).filter(u => u !== '')).size
      console.log(JSON.stringify({ type: 'mm_incentive_anchor_start', mode, dry_run: dryRun, anchor_block: B0, rpc_url: rpcUrl, programmes, candidates: candidates.users.length, anchored_users: anchored.users.size, users_read: usersRead, sources: candidates.counts }))
      const anchorRows = await readIncentiveAnchorKeys(keys, B0, ethCall)
      const summary = {
        rows: anchorRows.length,
        programme_rows: anchorRows.filter(r => r.user_address === '').length,
        accrual_rows: anchorRows.filter(r => r.user_address !== '' && r.asset_address === '').length,
        user_index_rows: anchorRows.filter(r => r.user_address !== '' && r.asset_address !== '').length,
        users_with_accrual: new Set(anchorRows.filter(r => r.user_address !== '' && r.asset_address === '').map(r => r.user_address)).size,
        users_anchored: new Set(anchorRows.filter(r => r.user_address !== '').map(r => r.user_address)).size,
      }
      if (outFile) writeFileSync(outFile, anchorRows.map(r => JSON.stringify(r)).join('\n') + '\n')
      if (!dryRun && anchorRows.length) await insertRows(anchorRows)
      console.log(JSON.stringify({ type: 'mm_incentive_anchor_done', mode, dry_run: dryRun, anchor_block: B0, calls: keys.length, ...summary, seconds: Math.round((Date.now() - startedAt) / 1000) }, null, 2))
    },

    async verify() {
      const stored = await readAnchorRows()
      const result = await verifyIncentiveAnchor(stored, ethCall)
      console.log(JSON.stringify({ type: 'mm_incentive_anchor_verify', table_rows: stored.length, checked: result.checked, matched: result.matched, mismatched: result.mismatches.length, first_mismatches: result.mismatches.slice(0, 5) }, null, 2))
      return stored.length > 0 && result.mismatches.length === 0
    },
  }
}
