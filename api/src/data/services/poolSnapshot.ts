import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { iso } from '../schemas/common.ts'

// The current state of every pool, from the newest raw_block_snapshots row.
// The indexer writes one snapshot per block (omnipool assets, stableswap pools,
// XYK pools — the same payload the 600-block state-history MVs sample), so
// reading the newest row is a 3 ms point read that is exact at the indexed
// head, where folding the histories was three scans (up to 3.7 M rows for XYK)
// for a state up to 600 blocks old. Held for one block interval; every
// current-state surface (/v1/pools, TVL, LP positions) reads this one object.

export interface OmnipoolAssetSnapshot { assetId: number; reserve: bigint; hubReserve: bigint; shares: bigint; protocolShares: bigint }
export interface StableswapPoolSnapshot {
  poolId: number
  assetIds: number[]
  reserves: bigint[]
  amplification: number
  initialAmplification: number
  finalAmplification: number
  initialBlock: number
  finalBlock: number
  feePermill: number
  totalIssuance: bigint
}
export interface XykPoolSnapshot { poolAccount: string; assetA: number; assetB: number; reserveA: bigint; reserveB: bigint }

export interface PoolSnapshot {
  blockHeight: number
  timestamp: string
  omnipool: Map<number, OmnipoolAssetSnapshot>
  stableswap: Map<number, StableswapPoolSnapshot>
  xyk: Map<string, XykPoolSnapshot>
}

const TTL_MS = 3_000

export function poolSnapshot(client: ClickHouseClient): Promise<PoolSnapshot> {
  return cached('data:pools:snapshot', TTL_MS, () => loadPoolSnapshot(client))
}

interface RawOmnipoolAsset { asset_id: number; reserve: string; hub_reserve: string; shares: string; protocol_shares: string }
interface RawStableswapPool {
  pool_id: number; assets: string | number[]; reserves: string[]; amplification: string | number
  initial_amplification: number; final_amplification: number; initial_block: number; final_block: number
  fee: number; total_issuance: string
}
interface RawXykPool { pool_account: string; asset_a: number; asset_b: number; reserve_a: string; reserve_b: string }
interface Payload {
  omnipool?: { assets?: RawOmnipoolAsset[] }
  stableswap?: { pools?: RawStableswapPool[] }
  xyk?: { pools?: RawXykPool[] }
}

const big = (value: unknown): bigint => {
  const text = String(value ?? '0')
  return /^\d+$/.test(text) ? BigInt(text) : 0n
}

// A stableswap pool's asset list is stored two ways: legacy pools as a hex
// string of one byte per asset id ("0x0a121517" = [10, 18, 21, 23]), newer
// pools as a JSON array — the same rule stableswap_pool_state_history_mv applies.
export function stableswapAssetIds(assets: string | number[] | undefined): number[] {
  if (Array.isArray(assets)) return assets.map(Number)
  if (typeof assets === 'string' && /^0x([0-9a-fA-F]{2})+$/.test(assets)) {
    const out: number[] = []
    for (let i = 2; i < assets.length; i += 2) out.push(parseInt(assets.slice(i, i + 2), 16))
    return out
  }
  return []
}

export function parsePoolSnapshot(blockHeight: number, timestamp: string, payloadJson: string): PoolSnapshot {
  let payload: Payload = {}
  try { payload = JSON.parse(payloadJson) as Payload } catch { /* an unreadable snapshot is an empty state, never invented pools */ }
  const omnipool = new Map<number, OmnipoolAssetSnapshot>()
  for (const a of payload.omnipool?.assets ?? []) {
    omnipool.set(Number(a.asset_id), {
      assetId: Number(a.asset_id), reserve: big(a.reserve), hubReserve: big(a.hub_reserve), shares: big(a.shares), protocolShares: big(a.protocol_shares),
    })
  }
  const stableswap = new Map<number, StableswapPoolSnapshot>()
  for (const p of payload.stableswap?.pools ?? []) {
    stableswap.set(Number(p.pool_id), {
      poolId: Number(p.pool_id),
      assetIds: stableswapAssetIds(p.assets),
      reserves: (p.reserves ?? []).map(big),
      amplification: Number(p.amplification) || 0,
      initialAmplification: Number(p.initial_amplification) || 0,
      finalAmplification: Number(p.final_amplification) || 0,
      initialBlock: Number(p.initial_block) || 0,
      finalBlock: Number(p.final_block) || 0,
      feePermill: Number(p.fee) || 0,
      totalIssuance: big(p.total_issuance),
    })
  }
  const xyk = new Map<string, XykPoolSnapshot>()
  for (const p of payload.xyk?.pools ?? []) {
    const account = String(p.pool_account ?? '').toLowerCase()
    if (!/^0x[0-9a-f]{64}$/.test(account)) continue
    xyk.set(account, { poolAccount: account, assetA: Number(p.asset_a), assetB: Number(p.asset_b), reserveA: big(p.reserve_a), reserveB: big(p.reserve_b) })
  }
  return { blockHeight, timestamp, omnipool, stableswap, xyk }
}

async function loadPoolSnapshot(client: ClickHouseClient): Promise<PoolSnapshot> {
  const res = await client.query({
    query: `-- data:pools:snapshot
        SELECT block_height, toString(block_timestamp) AS ts, payload_json
        FROM price_data.raw_block_snapshots
        WHERE block_height = (SELECT max(block_height) FROM price_data.raw_block_snapshots)
        ORDER BY ingested_at DESC
        LIMIT 1`,
    format: 'JSONEachRow',
  })
  const [row] = await res.json<{ block_height: number; ts: string; payload_json: string }>()
  if (!row) return { blockHeight: 0, timestamp: iso(0), omnipool: new Map(), stableswap: new Map(), xyk: new Map() }
  return parsePoolSnapshot(Number(row.block_height), iso(row.ts), row.payload_json)
}
