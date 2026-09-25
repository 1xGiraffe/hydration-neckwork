import { writeFileSync } from 'node:fs'
import { BOUNDED_QUERY_SETTINGS, type ClickHouseClient } from '../db/client.js'
import { toClickHouseDateTime } from '../raw/json.js'
import { getCompletedRawRanges, missingRawCoverage } from '../raw/ranges.js'
import { unionCandidates, type EthCall } from './atokenAnchor.js'
import {
  CONTROLLER_LOGS_FROM, INCENTIVE_TOPIC, REWARDS_CONTROLLER, readIncentiveAnchor, verifyIncentiveAnchor,
  type IncentiveAnchorRow, type Programme,
} from './mmIncentiveAnchor.js'

// The ClickHouse- and RPC-bound half of the money-market incentive ANCHOR (see
// mmIncentiveAnchor.ts for why and what): its candidate set, its table, its
// ingestion-range gate and its capture / verify runs. Shared by the
// anchors loop (snapshot-atoken-anchors.ts --loop, the `atoken-anchor` service),
// which captures it once its gate passes, and the manual CLI
// (snapshot-mm-incentive-anchors.ts).
//
// Candidates (a user can hold an accrual at B0 without holding any incentivized
// aToken there, so balance holders alone are not enough): every address that ever
// appears as a user in a controller log (Accrued, RewardsClaimed), every holder in
// the aToken anchor of a programme asset, every participant of a programme asset's
// own logs, and every holder in its contract-first scaled deltas; the count per
// source is logged. Programmes: those an AssetConfigUpdated configured at or before B0.

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
  /** Read the anchor at B0 and (unless dryRun) insert it. */
  capture(opts: { dryRun: boolean; outFile?: string | null }): Promise<void>
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
    const [logUsers, anchorHolders, logParticipants, deltaHolders] = await Promise.all([
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
    ])
    const union = unionCandidates({
      controller_logs: col(logUsers), atoken_anchor: col(anchorHolders), asset_logs: col(logParticipants), scaled_deltas: col(deltaHolders),
    })
    return { users: union.holders, counts: union.counts }
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

    async capture({ dryRun, outFile }) {
      const startedAt = Date.now()
      const programmes = await programmesOrThrow()
      const candidates = await candidateUsers([...new Set(programmes.map(p => p.asset))])
      console.log(JSON.stringify({ type: 'mm_incentive_anchor_start', dry_run: dryRun, anchor_block: B0, rpc_url: rpcUrl, programmes, candidates: candidates.users.length, sources: candidates.counts }))
      const anchorRows = await readIncentiveAnchor(candidates.users, programmes, B0, ethCall)
      const summary = {
        rows: anchorRows.length,
        programme_rows: anchorRows.filter(r => r.user_address === '').length,
        accrual_rows: anchorRows.filter(r => r.user_address !== '' && r.asset_address === '').length,
        user_index_rows: anchorRows.filter(r => r.user_address !== '' && r.asset_address !== '').length,
        users_with_accrual: new Set(anchorRows.filter(r => r.user_address !== '' && r.asset_address === '').map(r => r.user_address)).size,
      }
      if (outFile) writeFileSync(outFile, anchorRows.map(r => JSON.stringify(r)).join('\n') + '\n')
      if (!dryRun) await insertRows(anchorRows)
      console.log(JSON.stringify({ type: 'mm_incentive_anchor_done', dry_run: dryRun, anchor_block: B0, calls: candidates.users.length * (new Set(programmes.map(p => p.reward)).size + programmes.length) + programmes.length, ...summary, seconds: Math.round((Date.now() - startedAt) / 1000) }, null, 2))
    },

    async verify() {
      const stored = await readAnchorRows()
      const result = await verifyIncentiveAnchor(stored, ethCall)
      console.log(JSON.stringify({ type: 'mm_incentive_anchor_verify', table_rows: stored.length, checked: result.checked, matched: result.matched, mismatched: result.mismatches.length, first_mismatches: result.mismatches.slice(0, 5) }, null, 2))
      return stored.length > 0 && result.mismatches.length === 0
    },
  }
}
