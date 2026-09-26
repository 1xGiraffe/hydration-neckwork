import { BOUNDED_QUERY_SETTINGS, createClickHouseClient } from '../db/client.js'
import { config } from '../config.js'
import { toClickHouseDateTime } from '../raw/json.js'
import { moneyMarketDefinitions, moneyMarketPools } from '../raw/moneyMarket.js'
import { getCompletedRawRanges, missingRawCoverage } from '../raw/ranges.js'
import { hasFlag, integerOption, optionalIntegerOption } from '../util/cliArgs.js'
import {
  MM_LOGS_FROM, SEL, anchorKeysToRead, anchorRowsForKeys, makeEthCallBatch, padAddress, unionCandidates, verificationSample, verifyAnchors,
  type AnchorMode, type AnchorRow,
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
// The post-B0 deltas are complete — every aToken move since B0 carries the
// contract's own logs, Substrate-dispatched ones included (Currencies.transfer of a
// registry asset over an aToken, a router or Omnipool leg, a DCA fill), measured at
// block 15,047,000: the chain's scaledTotalSupply equalled the B0 total plus every
// indexed delta for all 43 live contracts, and no holder with a row drifted. What
// the log-fed candidate sources miss is a holder who received BEFORE B0, inside a
// gap of the pre-B0 log coverage, and never moved since: 79 such holders (77 aGDOT,
// one aUSDT, one atBTC) summed exactly to each contract's total-minus-holders gap.
// So the anchor is captured whole once and then TOPPED UP every cycle: a candidate
// any source has named since — the collateral sweep, a Substrate leg of the
// registry asset over the aToken, a later-indexed log — that has no row yet is
// read at B0 and anchored (anchorKeysToRead), so a missed holder waits one cycle
// after a source names it, never for a re-capture.
//
// Usage:
//   npx tsx src/scripts/snapshot-atoken-anchors.ts [--dry-run] [--anchor-block=8200000]
//   npx tsx src/scripts/snapshot-atoken-anchors.ts --loop [--refresh-hours=6] [--force] [--force-incentive]
//   npx tsx src/scripts/snapshot-atoken-anchors.ts --verify [--verify-sample=200]
//
// --loop (service mode, the `atoken-anchor` service) runs BOTH B0 anchors, each on
// its own gate (anchorLoop.ts): each cycle refreshes the reserve map (cheap; catches
// newly added reserves) and, once raw ingestion has completed every block from
// MM_LOGS_FROM to B0 (the candidate holders are read from that raw; --force does
// not lift this gate), captures this anchor at --anchor-block whole when its table
// is empty (--force: every cycle) and tops it up otherwise; then the money-market
// incentive anchor (mm_incentive_anchor, mmIncentiveAnchorJob.ts) the same way on
// its own gate — whole when its table is empty (or under --force-incentive), a
// top-up otherwise, once raw ingestion has completed its controller's logs. The
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

// The pool's own candidate sources, read once per capture and keyed per reserve —
// a user the pool names on reserve R is a possible holder of aR / vdebtR, and a
// non-holder reads 0 at the cost of one call. (Keyed per pool instead they would
// name every swept user for every contract: 290k reads a cycle, against ~16k.)
//   collateral — every user whose swept usage-as-collateral bitmap has the bit set
//                on the reserve (money_market_collateral_anchor: written by the
//                api's snapshot-money-market refresher for every user with a live
//                position or any collateral event, so a fresh database fills it
//                within that refresher's cadence; the bit means a balance, so it
//                names the aToken's holder — a variable-debt token has no bit);
//   events     — every user a decoded money-market event names on the reserve
//                (raw_money_market_events.asset_address: Supply, Borrow, Repay, a
//                liquidation, the collateral events) or through the contract's own
//                events, attributed to the pool by the emitting contract.
// Both name a holder the money market's own aToken logs do not: the pool read its
// position (a borrow, a liquidation, the bitmap) after the pre-B0 log gap in which
// the aToken arrived.
interface PoolCandidates {
  /** `${pool}:${reserve}` → users with the collateral bit set on the reserve. */
  collateralByReserve: Map<string, string[]>
  /** `${pool}:${reserve}` → users named by an event on the reserve. */
  eventsByReserve: Map<string, string[]>
  /** contract → users named by an event the contract emitted. */
  eventsByContract: Map<string, string[]>
}

async function poolCandidates(reserveMap: ReserveMap): Promise<PoolCandidates> {
  const poolOf = new Map<string, string>()
  for (const r of reserveMap) {
    const pool = r.pool.toLowerCase()
    for (const contract of [pool, r.atoken.toLowerCase(), r.vdebt.toLowerCase()]) poolOf.set(contract, pool)
  }
  for (const market of moneyMarketDefinitions()) {
    for (const contract of [market.poolProxy, ...market.contracts]) poolOf.set(contract.toLowerCase(), market.poolProxy.toLowerCase())
  }
  const push = (map: Map<string, string[]>, key: string, h: string): void => {
    let list = map.get(key)
    if (!list) map.set(key, list = [])
    list.push(h)
  }
  const rows = async <T>(query: string): Promise<T[]> => {
    const res = await client.query({ query, format: 'JSONEachRow', clickhouse_settings: BOUNDED_QUERY_SETTINGS })
    return res.json<T>()
  }
  const [collateral, events] = await Promise.all([
    // No FINAL: an older row with the bit set beside a newer one without only
    // over-includes, which costs one read and never a holder.
    rows<{ p: string; r: string; h: string }>(`SELECT DISTINCT lower(pool_address) AS p, lower(reserve_address) AS r, lower(user_address) AS h
      FROM price_data.money_market_collateral_anchor WHERE enabled = 1`),
    rows<{ c: string; r: string; h: string }>(`SELECT DISTINCT lower(contract_address) AS c, lower(ifNull(asset_address, '')) AS r, lower(user_address) AS h
      FROM price_data.raw_money_market_events WHERE user_address IS NOT NULL AND user_address != ''`),
  ])
  const out: PoolCandidates = { collateralByReserve: new Map(), eventsByReserve: new Map(), eventsByContract: new Map() }
  for (const row of collateral) push(out.collateralByReserve, `${row.p}:${row.r}`, row.h)
  for (const row of events) {
    push(out.eventsByContract, row.c, row.h)
    const pool = poolOf.get(row.c)
    if (pool && row.r) push(out.eventsByReserve, `${pool}:${row.r}`, row.h)
  }
  return out
}

// Every address any exact source names as a possible holder of `contract` at B0
// (unionCandidates says why no one source is enough):
//   logs       — every participant of any of the contract's own EVM logs (Transfer,
//                Mint, Burn, BalanceTransfer; a non-holder simply reads 0);
//   deltas     — every holder in the contract-first scaled-delta model;
//   accruals   — every user of an indexed RewardsController Accrued on this asset,
//                pre- and post-B0 (a claim or balance change re-emits it);
//   incentive  — every user with an incentive-anchor row for this asset (the
//                controller's own getUserAssetIndex at B0 was non-zero);
//   collateral, events — the pool's users on this reserve (poolCandidates; the
//                collateral bit names the aToken's holders only);
//   registry   — every account a Substrate transfer or swap of the registry asset
//                whose contract IS this aToken (GDOT = asset 69 over aGDOT) names at
//                or before B0, as the EVM side keys it: the first 20 bytes of the
//                AccountId32, the runtime's own address mapping. The Substrate legs
//                are MV-fed from raw_events, whose coverage the EVM-log gaps do not
//                share.
async function candidateHolders(contract: string, reserve: { pool: string; reserve: string; kind: 'atoken' | 'vdebt' }, pools: PoolCandidates): Promise<{ holders: string[]; counts: Record<string, number> }> {
  const read = async (query: string): Promise<string[]> => {
    const res = await client.query({ query, query_params: { c: contract, b0: B0 }, format: 'JSONEachRow', clickhouse_settings: BOUNDED_QUERY_SETTINGS })
    return (await res.json<{ h: string }>()).map(r => r.h)
  }
  const registryAsset = `SELECT asset_id FROM price_data.assets FINAL WHERE lower(evm_address) = {c:String}`
  const [logs, deltas, accruals, incentive, registry] = await Promise.all([
    read(`SELECT DISTINCT lower(arrayJoin(participants)) AS h FROM price_data.raw_evm_logs PREWHERE contract_address = {c:String}`),
    read(`SELECT DISTINCT lower(holder) AS h FROM price_data.atoken_scaled_deltas_by_contract WHERE contract_address = {c:String}`),
    read(`SELECT DISTINCT user_address AS h FROM price_data.mm_incentive_accruals WHERE asset_address = {c:String}`),
    read(`SELECT DISTINCT user_address AS h FROM price_data.mm_incentive_anchor WHERE asset_address = {c:String} AND user_address != ''`),
    read(`SELECT DISTINCT lower(substring(acc, 1, 42)) AS h FROM (
            SELECT from_account AS acc FROM price_data.transfer_activity WHERE asset_id IN (${registryAsset}) AND block_height <= {b0:UInt32}
            UNION ALL SELECT to_account AS acc FROM price_data.transfer_activity WHERE asset_id IN (${registryAsset}) AND block_height <= {b0:UInt32}
            UNION ALL SELECT who AS acc FROM price_data.asset_swap_activity WHERE asset_id IN (${registryAsset}) AND block_height <= {b0:UInt32}
          ) WHERE length(acc) = 66`),
  ])
  const reserveKey = `${reserve.pool}:${reserve.reserve}`
  return unionCandidates({
    logs, deltas, accruals, incentive,
    collateral: reserve.kind === 'atoken' ? pools.collateralByReserve.get(reserveKey) ?? [] : [],
    events: [...pools.eventsByReserve.get(reserveKey) ?? [], ...pools.eventsByContract.get(contract) ?? []],
    registry,
  })
}

/** The keys the table already holds, per contract — what a top-up skips. */
async function anchoredKeys(): Promise<Map<string, Set<string>>> {
  const res = await client.query({
    query: `SELECT lower(contract_address) AS c, lower(holder) AS h FROM price_data.atoken_scaled_anchor FINAL`,
    format: 'JSONEachRow',
  })
  const out = new Map<string, Set<string>>()
  for (const row of await res.json<{ c: string; h: string }>()) {
    let set = out.get(row.c)
    if (!set) out.set(row.c, set = new Set())
    set.add(row.h)
  }
  return out
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
// rows: its whole history is in the post-B0 deltas. A top-up reads only the keys
// without a row (anchorKeysToRead) — the candidates named since the last capture,
// plus every candidate that read zero before (a post-B0 holder), which is one call
// each; a full capture reads them all. Either inserts what read non-zero, under the
// same (contract, holder) key, so a repeated row replaces itself.
async function captureAnchor(reserveMap: ReserveMap, startedAt: number, mode: AnchorMode): Promise<void> {
  const anchored = mode === 'top-up' ? await anchoredKeys() : new Map<string, Set<string>>()
  const pools = await poolCandidates(reserveMap)
  const anchorRows: AnchorRow[] = []
  let candidateCount = 0
  let readCount = 0
  for (const r of reserveMap) {
    for (const kind of ['atoken', 'vdebt'] as const) {
      const contract = r[kind].toLowerCase()
      const candidates = await candidateHolders(contract, { pool: r.pool.toLowerCase(), reserve: r.reserve.toLowerCase(), kind }, pools)
      const keys = anchorKeysToRead(candidates.holders, anchored.get(contract) ?? new Set<string>(), mode)
      candidateCount += candidates.holders.length
      readCount += keys.length
      const rows = await anchorRowsForKeys(contract, keys, B0, ethCall)
      // Per contract only where something was read into the table: a full capture,
      // or a top-up that found a holder (the steady state is one summary line).
      if (mode === 'full' || rows.length) {
        console.log(JSON.stringify({ type: 'atoken_anchor_candidates', mode, contract, candidates: candidates.holders.length, read: keys.length, anchored: rows.length, sources: candidates.counts }))
      }
      anchorRows.push(...rows)
    }
  }
  const holderRows = anchorRows.filter(r => r.holder !== '').length
  console.log(JSON.stringify({ type: 'atoken_anchor_computed', mode, reserves: reserveMap.length, map_rows: reserveMap.length, candidates: candidateCount, read: readCount, anchor_rows: anchorRows.length, holder_rows: holderRows }))

  if (!dryRun && anchorRows.length) await insertAnchorRows(anchorRows)
  console.log(JSON.stringify({ type: 'atoken_anchor_done', mode, dry_run: dryRun, anchor_block: B0, reserves: reserveMap.length, anchor_rows: anchorRows.length, seconds: Math.round((Date.now() - startedAt) / 1000) }, null, 2))
}

async function runOnce(): Promise<void> {
  const startedAt = Date.now()
  console.log(JSON.stringify({ type: 'atoken_anchor_start', dry_run: dryRun, anchor_block: B0, rpc_url: RPC_URL }))
  const reserveMap = await refreshReserveMap()

  // Anchor rows are pinned at B0, so recomputing yields identical data. Build them
  // whole when the table is empty (fresh install / post-reindex) or --force, top
  // them up otherwise, and only once raw covers MM_LOGS_FROM..B0 (anchorLoop.ts).
  // This makes the anchor self-re-establish after a wipe & reindex with no manual
  // step. A dry run writes nothing, so what the table holds cannot skip it.
  const decision = await atokenAnchorDecision({ anchorRowCount, logGaps }, force || dryRun, MM_LOGS_FROM, B0)
  if (!decision.capture) {
    console.log(JSON.stringify({ type: 'atoken_anchor_done', skipped_anchor: true, reason: decision.reason, ...decision.detail, map_rows: reserveMap.length, seconds: Math.round((Date.now() - startedAt) / 1000) }))
    return
  }
  await captureAnchor(reserveMap, startedAt, decision.mode)
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
      capture: mode => captureAnchor(reserveMap, startedAt, mode),
    },
    incentive: {
      anchorRowCount: () => incentive.anchorRowCount(),
      controllerLogGaps: () => incentive.controllerLogGaps(),
      capture: mode => incentive.capture({ dryRun, mode }),
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
