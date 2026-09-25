import { BOUNDED_QUERY_SETTINGS, createClickHouseClient } from '../db/client.js'
import { config } from '../config.js'
import { toClickHouseDateTime } from '../raw/json.js'
import { moneyMarketPools } from '../raw/moneyMarket.js'
import { getCompletedRawRanges, missingRawCoverage } from '../raw/ranges.js'
import { hasFlag, integerOption, optionalIntegerOption } from '../util/cliArgs.js'
import {
  MM_LOGS_FROM, SEL, anchorForContract, makeEthCallBatch, padAddress, unionCandidates, verificationSample, verifyAnchors,
  type AnchorRow,
} from './atokenAnchor.js'
import { atokenAnchorDecision, runAnchorCycle } from './anchorLoop.js'
import { CONTROLLER_LOGS_FROM } from './mmIncentiveAnchor.js'
import { createIncentiveAnchorJob } from './mmIncentiveAnchorJob.js'
import { reconcileLmEntries } from './lmEntryCapture.js'
import { createLmCaptureChain, createLmCaptureSink, createLmCaptureSource, createLmReconcileSource } from './lmEntryPorts.js'
import { createSnapshotRpcClient } from './snapshotRuntime.js'

// aToken / variable-debt scaled-balance ANCHOR snapshot.
//
// aTokens (aDOT=1001, …) and variable-debt tokens are Aave scaled-balance ERC-20s.
// Their current balance is reconstructed by the API from indexed Mint/Burn/
// BalanceTransfer events without per-request RPC. Earlier EVM-log coverage is
// incomplete, so a node-sourced scaled balance at pinned block B0 establishes the
// base and indexed post-B0 event deltas carry it forward:
//
//   balance = ( scaled_anchor + Σ scaled_delta(block > B0) ) · index_now / RAY
//
// scaled_anchor is read directly — scaledBalanceOf(holder)@B0, and
// scaledTotalSupply()@B0 for the holder = '' total row — never derived from
// balanceOf by dividing an index back out (atokenAnchor.ts says why that is not
// an inverse). It is idempotent and reproducible because archive state
// at B0 is deterministic. An empty anchor table remains explicitly pending until
// this job establishes it; event-only sums are never presented as complete.
//
// Usage:
//   npx tsx src/scripts/snapshot-atoken-anchors.ts [--dry-run] [--anchor-block=8200000]
//   npx tsx src/scripts/snapshot-atoken-anchors.ts --loop [--refresh-hours=6] [--force] [--force-incentive]
//   npx tsx src/scripts/snapshot-atoken-anchors.ts --verify [--verify-sample=200]
//
// --loop (service mode, the `atoken-anchor` service) runs BOTH B0 anchors, each on
// its own gate (anchorLoop.ts): each cycle refreshes the reserve map (cheap; catches
// newly added reserves) and captures this anchor at --anchor-block when its table is
// empty (--force: every cycle) and raw ingestion has completed every block from
// MM_LOGS_FROM to B0 (the candidate holders are read from that raw; --force does
// not lift this gate); then captures the money-market incentive anchor
// (mm_incentive_anchor, mmIncentiveAnchorJob.ts) when its table is empty (or under
// --force-incentive) and raw ingestion has completed its controller's logs. The
// incentive anchor's manual modes (--verify, a one-off capture) are
// snapshot-mm-incentive-anchors.ts. Last, every cycle, it reconciles the
// liquidity-mining entry capture (raw_lm_farm_entries): each block with an open
// raw_parser_warnings row of parser raw_lm_farm_entries, and each block the full
// check finds without its entry rows, is re-read from the archive node and its
// missing rows inserted (reconcileLmEntries; the manual tool is
// snapshot-lm-entries.ts). RPC_URL must be an ARCHIVE node for that port: it reads
// state at historical hashes (compose: node-full, run with --state-pruning archive).
// Without --loop this script is the aToken anchor alone, on the same gates.
//
// --verify: read-only; checks every '' row plus --verify-sample holder rows of the
// table as it stands against scaledBalanceOf/scaledTotalSupply at their anchor block.
// Exits non-zero on any mismatch.

const RPC_URL = config.RPC_URL

const dryRun = hasFlag('dry-run')
const loop = hasFlag('loop')
const force = hasFlag('force')
const forceIncentive = hasFlag('force-incentive')
const verifyOnly = hasFlag('verify')
const refreshHours = integerOption('refresh-hours', 6, { min: 1 })
const explicitAnchorBlock = optionalIntegerOption('anchor-block', { min: 1 })
const B0 = explicitAnchorBlock ?? 8_200_000
const verifySampleSize = integerOption('verify-sample', 200, { min: 0 })

const client = createClickHouseClient()
const ethCall = makeEthCallBatch(RPC_URL)
const incentiveEthCall = makeEthCallBatch(RPC_URL, fetch, { label: 'mm-incentive-anchor' })

async function readReserveMap(): Promise<{ reserve: string; atoken: string; vdebt: string; pool: string; marketKey: string }[]> {
  const pools = moneyMarketPools()
  const rows: { reserve: string; atoken: string; vdebt: string; pool: string; marketKey: string }[] = []
  for (const { poolProxy, marketKey } of pools) {
    // The reserve MAP is read at 'latest' (all current reserves + their stable
    // aToken/vDebt addresses). A pool that cannot be read must not silently drop out
    // of the map: it feeds every downstream reconstruction. ethCall throws on failure.
    const [listRes] = await ethCall([{ to: poolProxy, data: `0x${SEL.reservesList}` }], 'latest')
    const lh = listRes.slice(2)
    const n = parseInt(lh.slice(64, 128), 16)
    const reserves: string[] = []
    for (let i = 0; i < n && i < 128; i++) reserves.push('0x' + lh.slice(128 + i * 64 + 24, 128 + (i + 1) * 64))
    const data = await ethCall(reserves.map(r => ({ to: poolProxy, data: `0x${SEL.reserveData}${padAddress(r)}` })), 'latest')
    reserves.forEach((reserve, i) => {
      const d = data[i]
      if (d === '0x') return   // reserve not configured at this block
      const w = (j: number) => d.slice(2).slice(j * 64, j * 64 + 64)
      rows.push({ reserve, atoken: '0x' + w(8).slice(24), vdebt: '0x' + w(10).slice(24), pool: poolProxy, marketKey })
    })
  }
  return rows
}

// Every address any exact source names as a possible holder of `contract` at B0
// (unionCandidates says why no one source is enough):
//   logs       — every participant of any of the contract's own EVM logs (Transfer,
//                Mint, Burn, BalanceTransfer; a non-holder simply reads 0);
//   deltas     — every holder in the contract-first scaled-delta model;
//   accruals   — every user of an indexed RewardsController Accrued on this asset,
//                pre- and post-B0 (a claim or balance change re-emits it);
//   incentive  — every user with an incentive-anchor row for this asset (the
//                controller's own getUserAssetIndex at B0 was non-zero).
async function candidateHolders(contract: string): Promise<{ holders: string[]; counts: Record<string, number> }> {
  const read = async (query: string): Promise<string[]> => {
    const res = await client.query({ query, query_params: { c: contract }, format: 'JSONEachRow', clickhouse_settings: BOUNDED_QUERY_SETTINGS })
    return (await res.json<{ h: string }>()).map(r => r.h)
  }
  const [logs, deltas, accruals, incentive] = await Promise.all([
    read(`SELECT DISTINCT lower(arrayJoin(participants)) AS h FROM price_data.raw_evm_logs PREWHERE contract_address = {c:String}`),
    read(`SELECT DISTINCT lower(holder) AS h FROM price_data.atoken_scaled_deltas_by_contract WHERE contract_address = {c:String}`),
    read(`SELECT DISTINCT user_address AS h FROM price_data.mm_incentive_accruals WHERE asset_address = {c:String}`),
    read(`SELECT DISTINCT user_address AS h FROM price_data.mm_incentive_anchor WHERE asset_address = {c:String} AND user_address != ''`),
  ])
  return unionCandidates({ logs, deltas, accruals, incentive })
}

// Bounded by the range table alone.
async function logGaps(): Promise<Array<{ fromBlock: number; toBlock: number }>> {
  return missingRawCoverage(MM_LOGS_FROM, B0, await getCompletedRawRanges(client, MM_LOGS_FROM, B0))
}

async function anchorRowCount(): Promise<number> {
  const res = await client.query({ query: `SELECT count() AS c FROM price_data.atoken_scaled_anchor`, format: 'JSONEachRow' })
  return Number((await res.json<{ c: string | number }>())[0]?.c ?? 0)
}

async function readAnchorRows(): Promise<AnchorRow[]> {
  const res = await client.query({
    query: `SELECT contract_address, holder, toString(scaled_balance) AS scaled_balance, anchor_block
            FROM price_data.atoken_scaled_anchor FINAL ORDER BY contract_address, holder`,
    format: 'JSONEachRow',
  })
  return (await res.json<AnchorRow>()).map(r => ({ ...r, anchor_block: Number(r.anchor_block) }))
}

async function insertAnchorRows(rows: AnchorRow[]): Promise<void> {
  const updated_at = toClickHouseDateTime(Date.now())
  for (let i = 0; i < rows.length; i += 5000) {
    await client.insert({
      table: 'price_data.atoken_scaled_anchor',
      values: rows.slice(i, i + 5000).map(r => ({ ...r, updated_at })),
      format: 'JSONEachRow',
    })
  }
}

async function runVerify(rows: AnchorRow[], label: string): Promise<boolean> {
  const sample = verificationSample(rows, verifySampleSize)
  const result = await verifyAnchors(sample, ethCall)
  console.log(JSON.stringify({ type: 'atoken_anchor_verify', label, table_rows: rows.length, checked: result.checked, matched: result.matched, mismatched: result.mismatches.length, first_mismatches: result.mismatches.slice(0, 5) }, null, 2))
  return result.mismatches.length === 0
}

type ReserveMap = Awaited<ReturnType<typeof readReserveMap>>

// Reserve map is refreshed every run (cheap; picks up newly-added reserves).
async function refreshReserveMap(): Promise<ReserveMap> {
  const reserveMap = await readReserveMap()
  if (!reserveMap.length) throw new Error('no reserves resolved from reserveData — aborting (would leave map/anchor empty)')
  const mapRows = reserveMap.map(r => ({
    asset_address: r.reserve.toLowerCase(), atoken: r.atoken.toLowerCase(), vdebt: r.vdebt.toLowerCase(),
    pool_proxy: r.pool.toLowerCase(), market_key: r.marketKey,
  }))
  if (!dryRun) {
    const updated_at = toClickHouseDateTime(Date.now())
    await client.insert({ table: 'price_data.atoken_reserve_map', values: mapRows.map(r => ({ ...r, updated_at })), format: 'JSONEachRow' })
  }
  return reserveMap
}

// A contract with no code at B0 (a reserve added later) returns empty and yields no
// rows: its whole history is in the post-B0 deltas.
async function captureAnchor(reserveMap: ReserveMap, startedAt: number): Promise<void> {
  const anchorRows: AnchorRow[] = []
  for (const r of reserveMap) {
    for (const contract of [r.atoken.toLowerCase(), r.vdebt.toLowerCase()]) {
      const candidates = await candidateHolders(contract)
      console.log(JSON.stringify({ type: 'atoken_anchor_candidates', contract, candidates: candidates.holders.length, sources: candidates.counts }))
      anchorRows.push(...await anchorForContract(contract, candidates.holders, B0, ethCall))
    }
  }
  const holderRows = anchorRows.filter(r => r.holder !== '').length
  console.log(JSON.stringify({ type: 'atoken_anchor_computed', reserves: reserveMap.length, map_rows: reserveMap.length, anchor_rows: anchorRows.length, holder_rows: holderRows }))

  if (!dryRun) await insertAnchorRows(anchorRows)
  console.log(JSON.stringify({ type: 'atoken_anchor_done', dry_run: dryRun, anchor_block: B0, reserves: reserveMap.length, anchor_rows: anchorRows.length, seconds: Math.round((Date.now() - startedAt) / 1000) }, null, 2))
}

async function runOnce(): Promise<void> {
  const startedAt = Date.now()
  console.log(JSON.stringify({ type: 'atoken_anchor_start', dry_run: dryRun, anchor_block: B0, rpc_url: RPC_URL }))
  const reserveMap = await refreshReserveMap()

  // Anchor rows are pinned at B0, so recomputing yields identical data. Only (re)build
  // them when the table is empty (fresh install / post-reindex) or --force, and only
  // once raw covers MM_LOGS_FROM..B0 (anchorLoop.ts). This makes the anchor
  // self-re-establish after a wipe & reindex with no manual step. A dry run writes
  // nothing, so what the table holds cannot skip it.
  const decision = await atokenAnchorDecision({ anchorRowCount, logGaps }, force || dryRun, MM_LOGS_FROM, B0)
  if (!decision.capture) {
    console.log(JSON.stringify({ type: 'atoken_anchor_done', skipped_anchor: true, reason: decision.reason, ...decision.detail, map_rows: reserveMap.length, seconds: Math.round((Date.now() - startedAt) / 1000) }))
    return
  }
  await captureAnchor(reserveMap, startedAt)
}

// One --loop cycle: both anchors, each on its own gate (anchorLoop.ts).
// Warnings and full-check blocks re-read per cycle, each: beyond it the next cycle
// continues (the pass reports `truncated`).
const LM_RECONCILE_LIMIT = 2_000
// Created on first use and kept: the chain port caches one runtime per spec.
let lmChain: ReturnType<typeof createLmCaptureChain> | null = null

async function runLoopCycle(): Promise<void> {
  const startedAt = Date.now()
  console.log(JSON.stringify({ type: 'atoken_anchor_start', dry_run: dryRun, anchor_block: B0, rpc_url: RPC_URL }))
  let reserveMap: ReserveMap = []
  const incentive = createIncentiveAnchorJob({ client, ethCall: incentiveEthCall, anchorBlock: B0, rpcUrl: RPC_URL })
  await runAnchorCycle({
    atoken: {
      refreshReserveMap: async () => { reserveMap = await refreshReserveMap() },
      anchorRowCount,
      logGaps,
      capture: () => captureAnchor(reserveMap, startedAt),
    },
    incentive: {
      anchorRowCount: () => incentive.anchorRowCount(),
      controllerLogGaps: () => incentive.controllerLogGaps(),
      capture: () => incentive.capture({ dryRun }),
    },
    lmEntries: {
      reconcile: () => {
        lmChain ??= createLmCaptureChain(createSnapshotRpcClient(RPC_URL))
        return reconcileLmEntries(createLmReconcileSource(client), {
          source: createLmCaptureSource(client, { missingTableIsEmpty: dryRun }),
          chain: lmChain,
          sink: createLmCaptureSink(client),
        }, { dryRun, concurrency: 4, limit: LM_RECONCILE_LIMIT })
      },
    },
  }, {
    // A dry run writes nothing, so what the table holds cannot skip it (as runOnce).
    forceAtoken: force || dryRun,
    forceIncentive: forceIncentive || dryRun,
    atokenLogsFrom: MM_LOGS_FROM,
    incentiveLogsFrom: CONTROLLER_LOGS_FROM,
    anchorBlock: B0,
  }, record => console.log(JSON.stringify(record)))
}

async function main(): Promise<void> {
  if (verifyOnly) {
    if (!await runVerify(await readAnchorRows(), 'table')) process.exitCode = 1
    return
  }
  if (!loop) { await runOnce(); return }
  const intervalMs = Math.max(1, refreshHours) * 3_600_000
  for (;;) {
    try { await runLoopCycle() } catch (err) { console.error(err) }
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(async () => { if (!loop) await client.close() })
