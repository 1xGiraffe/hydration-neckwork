import { createClickHouseClient } from '../db/client.js'
import { config } from '../config.js'
import { toClickHouseDateTime } from '../raw/json.js'
import { moneyMarketPools } from '../raw/moneyMarket.js'
import { hasFlag, integerOption } from '../util/cliArgs.js'

// aToken / variable-debt scaled-balance ANCHOR snapshot.
//
// aTokens (aDOT=1001, …) and variable-debt tokens are Aave scaled-balance ERC-20s.
// Their current balance is reconstructed by the API from indexed Mint/Burn/
// BalanceTransfer events without per-request RPC. Earlier EVM-log coverage is
// incomplete, so a node-sourced balanceOf at pinned block B0 establishes the
// scaled balance and indexed post-B0 event deltas carry it forward:
//
//   balance = ( scaled_anchor + Σ scaled_delta(block > B0) ) · index_now / RAY
//
// The anchor is idempotent and reproducible because balanceOf@B0 is deterministic
// archive state. An empty anchor table remains explicitly pending until this job
// establishes it; event-only sums are never presented as complete balances.
//
// Usage:
//   npx tsx src/scripts/snapshot-atoken-anchors.ts [--dry-run] [--anchor-block=8200000]
//   npx tsx src/scripts/snapshot-atoken-anchors.ts --loop [--refresh-hours=6] [--force]
//
// --loop (service mode): each cycle refreshes the reserve map (cheap; catches newly
// added reserves) and computes the balanceOf@B0 anchor when the anchor table is
// empty. --force recomputes every cycle.

const RAY = 10n ** 27n
const SEL = { reservesList: 'd1946dbc', reserveData: '35ea6a75', balanceOf: '70a08231', totalSupply: '18160ddd' }
const RPC_URL = process.env.RAW_ATOKEN_ANCHOR_RPC_URL?.trim() || config.RPC_URL
const ZERO_H160 = '0x0000000000000000000000000000000000000000'

const dryRun = hasFlag('dry-run')
const loop = hasFlag('loop')
const force = hasFlag('force')
const refreshHours = integerOption('refresh-hours', 6, { min: 1 })
const B0 = integerOption('anchor-block', 8_200_000, { min: 1 })
const blockTag = `0x${B0.toString(16)}`

const client = createClickHouseClient()
const pad = (h160: string) => h160.slice(2).toLowerCase().padStart(64, '0')

// Batched eth_call at `block` (default B0). Returns results keyed by request index
// (null on failure). The reserve MAP is read at 'latest' (all current reserves +
// their stable aToken/vDebt addresses); balances/totalSupply are read at B0.
async function ethCallBatchAt(calls: { to: string; data: string }[], block: string = blockTag): Promise<(string | null)[]> {
  const out: (string | null)[] = new Array(calls.length).fill(null)
  const CHUNK = 50
  for (let start = 0; start < calls.length; start += CHUNK) {
    const chunk = calls.slice(start, start + CHUNK)
    const body = chunk.map((c, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to: c.to, data: c.data }, block] }))
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 30_000)
      try {
        const res = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal, body: JSON.stringify(body) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json() as { id: number; result?: string }[]
        if (!Array.isArray(json)) throw new Error('non-array batch response')
        for (const r of json) if (typeof r.id === 'number' && r.result) out[start + r.id] = r.result
        break
      } catch (err) {
        if (attempt === 2) console.error(`[atoken-anchor] batch ${start} failed after retries:`, err instanceof Error ? err.message : err)
        else await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
      } finally { clearTimeout(timer) }
    }
  }
  return out
}

async function readReserveMap(): Promise<{ reserve: string; atoken: string; vdebt: string; pool: string; marketKey: string }[]> {
  const pools = moneyMarketPools()
  const rows: { reserve: string; atoken: string; vdebt: string; pool: string; marketKey: string }[] = []
  for (const { poolProxy, marketKey } of pools) {
    const [listRes] = await ethCallBatchAt([{ to: poolProxy, data: `0x${SEL.reservesList}` }], 'latest')
    if (!listRes) { console.error(`[atoken-anchor] reservesList failed for pool ${poolProxy}`); continue }
    const lh = listRes.slice(2)
    const n = parseInt(lh.slice(64, 128), 16)
    const reserves: string[] = []
    for (let i = 0; i < n && i < 128; i++) reserves.push('0x' + lh.slice(128 + i * 64 + 24, 128 + (i + 1) * 64))
    const data = await ethCallBatchAt(reserves.map(r => ({ to: poolProxy, data: `0x${SEL.reserveData}${pad(r)}` })), 'latest')
    reserves.forEach((reserve, i) => {
      const d = data[i]; if (!d) return
      const w = (j: number) => d.slice(2).slice(j * 64, j * 64 + 64)
      rows.push({ reserve, atoken: '0x' + w(8).slice(24), vdebt: '0x' + w(10).slice(24), pool: poolProxy, marketKey })
    })
  }
  return rows
}

// liquidityIndex / variableBorrowIndex per reserve at block ≤ B0 (from indexed events).
// Reserves with no ReserveDataUpdated ≤ B0 did not exist at B0 → no anchor (balance 0;
// the API's post-B0 delta sum covers their entire history).
async function reserveIndicesAtB0(): Promise<Map<string, { liq: bigint; vbi: bigint }>> {
  const res = await client.query({
    query: `
      SELECT lower(if(pool_address = '', contract_address, pool_address)) AS pool,
        lower(reserve_address) AS reserve,
        argMax(JSONExtractString(decoded_args_json, 'liquidityIndex'), block_height) AS liq,
        argMax(JSONExtractString(decoded_args_json, 'variableBorrowIndex'), block_height) AS vbi
      FROM price_data.raw_money_market_reserves
      WHERE event_name = 'ReserveDataUpdated' AND block_height <= {b0:UInt32}
      GROUP BY pool, reserve`,
    query_params: { b0: B0 }, format: 'JSONEachRow',
  })
  const m = new Map<string, { liq: bigint; vbi: bigint }>()
  for (const r of await res.json<{ pool: string; reserve: string; liq: string; vbi: string }>()) {
    m.set(`${r.pool}:${r.reserve}`, { liq: BigInt(r.liq || '0'), vbi: BigInt(r.vbi || '0') })
  }
  return m
}

// Every address that ever appeared in a Transfer of `contract` (candidate holder set).
async function candidateHolders(contract: string): Promise<string[]> {
  const res = await client.query({
    query: `SELECT DISTINCT arrayJoin(participants) AS h FROM price_data.raw_evm_logs
            WHERE contract_address = {c:String} AND event_name = 'Transfer' AND h != {z:String}`,
    query_params: { c: contract, z: ZERO_H160 }, format: 'JSONEachRow',
  })
  return (await res.json<{ h: string }>()).map(r => r.h.toLowerCase()).filter(h => /^0x[0-9a-f]{40}$/.test(h))
}

interface AnchorRow { contract_address: string; holder: string; scaled_balance: string; anchor_block: number }

async function anchorForContract(contract: string, index: bigint): Promise<AnchorRow[]> {
  if (index <= 0n) return []
  const holders = await candidateHolders(contract)
  const rows: AnchorRow[] = []
  // totalSupply@B0 (holder = '')
  const [tsHex] = await ethCallBatchAt([{ to: contract, data: `0x${SEL.totalSupply}` }])
  if (tsHex && tsHex !== '0x') {
    const scaled = (BigInt(tsHex) * RAY) / index
    if (scaled > 0n) rows.push({ contract_address: contract, holder: '', scaled_balance: scaled.toString(), anchor_block: B0 })
  }
  if (holders.length) {
    const bals = await ethCallBatchAt(holders.map(h => ({ to: contract, data: `0x${SEL.balanceOf}${pad(h)}` })))
    bals.forEach((b, i) => {
      if (!b || b === '0x') return
      let raw: bigint
      try { raw = BigInt(b) } catch { return }
      if (raw <= 0n) return
      const scaled = (raw * RAY) / index
      if (scaled > 0n) rows.push({ contract_address: contract, holder: holders[i], scaled_balance: scaled.toString(), anchor_block: B0 })
    })
  }
  return rows
}

async function anchorRowCount(): Promise<number> {
  const res = await client.query({ query: `SELECT count() AS c FROM price_data.atoken_scaled_anchor`, format: 'JSONEachRow' })
  return Number((await res.json<{ c: string | number }>())[0]?.c ?? 0)
}

async function runOnce(): Promise<void> {
  const startedAt = Date.now()
  console.log(JSON.stringify({ type: 'atoken_anchor_start', dry_run: dryRun, anchor_block: B0, rpc_url: RPC_URL }))

  // Reserve map is refreshed every run (cheap; picks up newly-added reserves).
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

  // Anchor rows are pinned at B0, so recomputing yields identical data. Only (re)build
  // them when the table is empty (fresh install / post-reindex) or --force. This makes
  // the anchor self-re-establish after a wipe & reindex with no manual step.
  const existing = dryRun ? 0 : await anchorRowCount()
  if (existing > 0 && !force) {
    console.log(JSON.stringify({ type: 'atoken_anchor_done', skipped_anchor: true, reason: 'anchor already present', map_rows: mapRows.length, existing_anchor_rows: existing, seconds: Math.round((Date.now() - startedAt) / 1000) }))
    return
  }

  const indices = await reserveIndicesAtB0()
  const anchorRows: AnchorRow[] = []
  for (const r of reserveMap) {
    const idx = indices.get(`${r.pool.toLowerCase()}:${r.reserve.toLowerCase()}`)
    if (!idx) { console.log(`[atoken-anchor] reserve ${r.reserve} has no index ≤ B0 (post-B0 reserve); anchor skipped`); continue }
    anchorRows.push(...await anchorForContract(r.atoken.toLowerCase(), idx.liq))
    anchorRows.push(...await anchorForContract(r.vdebt.toLowerCase(), idx.vbi))
  }
  const holderRows = anchorRows.filter(r => r.holder !== '').length
  console.log(JSON.stringify({ type: 'atoken_anchor_computed', reserves: reserveMap.length, map_rows: mapRows.length, anchor_rows: anchorRows.length, holder_rows: holderRows }))

  if (!dryRun) {
    const updated_at = toClickHouseDateTime(Date.now())
    for (let i = 0; i < anchorRows.length; i += 5000) {
      await client.insert({
        table: 'price_data.atoken_scaled_anchor',
        values: anchorRows.slice(i, i + 5000).map(r => ({ ...r, updated_at })),
        format: 'JSONEachRow',
      })
    }
  }
  console.log(JSON.stringify({ type: 'atoken_anchor_done', dry_run: dryRun, anchor_block: B0, reserves: reserveMap.length, anchor_rows: anchorRows.length, seconds: Math.round((Date.now() - startedAt) / 1000) }, null, 2))
}

async function main(): Promise<void> {
  if (!loop) { await runOnce(); return }
  const intervalMs = Math.max(1, refreshHours) * 3_600_000
  for (;;) {
    try { await runOnce() } catch (err) { console.error(err) }
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(async () => { if (!loop) await client.close() })
