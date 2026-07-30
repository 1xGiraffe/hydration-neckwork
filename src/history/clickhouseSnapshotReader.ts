import { createHash } from 'node:crypto'
import { createClickHouseClient, type ClickHouseClient } from '../db/client.js'
import type { AssetRow } from '../db/schema.ts'
import type { OmnipoolAssetState, StableswapPool, XYKPool } from '../price/types.ts'
import type { SnapshotPayload } from '../raw/types.ts'
import {
  assertFinalizedRawCoverage,
  getCompletedRawRanges,
} from '../raw/ranges.js'
import { deriveStableswapPoolAccount } from '../util/account.js'
import { u8aToHex } from '@polkadot/util'

interface SnapshotRow {
  block_height: number
  payload_json: string
}

interface ParseSnapshotOptions {
  nativeAssetRow?: AssetRow
}

export interface HistoricalSnapshotEntry {
  blockHeight: number
  snapshot: HistoricalSnapshotState
}

export interface HistoricalSnapshotState {
  assetRows: AssetRow[]
  compositionKey: string
  decimals: Map<number, number>
  atokenEquivalences: [number, number][]
  atokenIds: Set<number>
  lpEquivalences: Map<number, number>
  poolAccounts: Set<string>
  omnipoolAssets: Map<number, OmnipoolAssetState>
  xykPools: XYKPool[]
  stableswapPools: StableswapPool[]
  totalIssuances: Map<number, bigint>
}

const stableswapAccountCache = new Map<number, string>()

function getStableswapPoolAccount(poolId: number): string {
  let account = stableswapAccountCache.get(poolId)
  if (account == null) {
    account = u8aToHex(deriveStableswapPoolAccount(poolId))
    stableswapAccountCache.set(poolId, account)
  }
  return account
}

function toBigInt(value: string | number | bigint | null | undefined): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Snapshot integer is not safe: ${value}`)
    }
    return BigInt(value)
  }
  if (value == null || value === '') return 0n
  return BigInt(value)
}

function asArray<T>(value: T[] | '0x' | null | undefined): T[] {
  if (value == null || value === '0x') return []
  return value
}

function toNumber(value: string | number | bigint): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'bigint'
      ? Number(value)
      : /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Snapshot asset id is not a non-negative safe integer: ${String(value)}`)
  }
  return parsed
}

function hashFields(parts: Array<string | number | bigint | null | undefined>): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(String(part ?? ''))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function buildCompositionKey(
  omnipoolAssetItems: SnapshotPayload['omnipool']['assets'],
  xykPoolItems: SnapshotPayload['xyk']['pools'],
  stableswapPoolItems: SnapshotPayload['stableswap']['pools'],
): string {
  const hash = createHash('sha256')

  hash.update(hashFields(['omnipool']))
  for (const asset of omnipoolAssetItems) {
    hash.update(hashFields([asset.asset_id]))
  }

  hash.update(hashFields(['xyk']))
  for (const pool of xykPoolItems) {
    hash.update(hashFields([pool.pool_account, pool.asset_a, pool.asset_b]))
  }

  hash.update(hashFields(['stableswap']))
  for (const pool of stableswapPoolItems) {
    hash.update(hashFields([
      pool.pool_id,
      normalizeAssetIdList(pool.assets).join(','),
      pool.initial_amplification,
      pool.final_amplification,
      pool.initial_block,
      pool.final_block,
      pool.fee,
    ]))
  }

  return hash.digest('hex')
}

export function normalizeAssetIdList(value: unknown): number[] {
  if (value == null || value === '0x') return []

  if (Array.isArray(value)) {
    return value.map(item => toNumber(item as string | number | bigint))
  }

  if (typeof value === 'string' && value.startsWith('0x')) {
    const hex = value.slice(2)
    if (hex.length === 0) return []
    if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) {
      throw new Error(`Malformed hex snapshot asset id list: ${value}`)
    }

    const assetIds: number[] = []
    for (let i = 0; i < hex.length; i += 2) {
      assetIds.push(Number.parseInt(hex.slice(i, i + 2), 16))
    }
    return assetIds
  }

  throw new Error(`Unsupported snapshot asset id list: ${String(value)}`)
}

export function normalizeEquivalenceList(value: unknown): [number, number][] {
  if (value == null || value === '0x') return []

  const result: [number, number][] = []

  const pushPairs = (assetIds: number[]): void => {
    if (assetIds.length % 2 !== 0) {
      throw new Error('Snapshot equivalence list contains an unpaired asset id')
    }
    for (let i = 0; i + 1 < assetIds.length; i += 2) {
      result.push([assetIds[i], assetIds[i + 1]])
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (Array.isArray(item) && item.length >= 2) {
        result.push([
          toNumber(item[0] as string | number | bigint),
          toNumber(item[1] as string | number | bigint),
        ])
        continue
      }

      pushPairs(normalizeAssetIdList(item))
    }

    return result
  }

  pushPairs(normalizeAssetIdList(value))
  return result
}

function parseSnapshot(payloadJson: string, options: ParseSnapshotOptions = {}): HistoricalSnapshotState {
  const payload = JSON.parse(payloadJson) as SnapshotPayload

  const assetItems = asArray(payload.assets.items as SnapshotPayload['assets']['items'] | '0x')
  const atokenEquivalences = normalizeEquivalenceList(payload.assets.atoken_equivalences)
  const lpEquivalenceEntries = normalizeEquivalenceList(payload.assets.lp_equivalences)
  const omnipoolAssetItems = asArray(payload.omnipool.assets as SnapshotPayload['omnipool']['assets'] | '0x')
  const xykPoolItems = asArray(payload.xyk.pools as SnapshotPayload['xyk']['pools'] | '0x')
  const stableswapPoolItems = asArray(payload.stableswap.pools as SnapshotPayload['stableswap']['pools'] | '0x')

  const omnipoolAssets = new Map<number, OmnipoolAssetState>()
  for (const asset of omnipoolAssetItems) {
    omnipoolAssets.set(asset.asset_id, {
      hubReserve: toBigInt(asset.hub_reserve),
      reserve: toBigInt(asset.reserve),
      shares: toBigInt(asset.shares),
      protocolShares: toBigInt(asset.protocol_shares),
      cap: toBigInt(asset.cap),
      tradable: asset.tradable,
    })
  }

  let assetRows: AssetRow[] = assetItems.map(asset => ({
    asset_id: asset.assetId,
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    parachain_id: asset.parachainId ?? null,
    origin_ecosystem: asset.originEcosystem ?? null,
    origin_chain_id: asset.originChainId ?? null,
    origin_asset_id: asset.originAssetId ?? null,
  }))

  const nativeAssetRow = options.nativeAssetRow
  if (
    nativeAssetRow != null &&
    !assetRows.some(asset => asset.asset_id === nativeAssetRow.asset_id) &&
    omnipoolAssets.has(nativeAssetRow.asset_id)
  ) {
    assetRows = [...assetRows, { ...nativeAssetRow }].sort((a, b) => a.asset_id - b.asset_id)
  }

  const decimals = new Map<number, number>()
  for (const row of assetRows) {
    decimals.set(row.asset_id, row.decimals)
  }

  const atokenIds = new Set(atokenEquivalences.map(([, aTokenId]) => aTokenId))
  const lpEquivalences = new Map<number, number>(lpEquivalenceEntries)

  const xykPools: XYKPool[] = xykPoolItems.map(pool => ({
    assetA: pool.asset_a,
    assetB: pool.asset_b,
    reserveA: toBigInt(pool.reserve_a),
    reserveB: toBigInt(pool.reserve_b),
  }))

  const totalIssuances = new Map<number, bigint>()
  const stableswapPools: StableswapPool[] = stableswapPoolItems.map(pool => {
    const assetIds = normalizeAssetIdList(pool.assets)
    const totalIssuance = pool.total_issuance == null ? undefined : toBigInt(pool.total_issuance)
    if (totalIssuance != null) {
      totalIssuances.set(pool.pool_id, totalIssuance)
    }

    return {
      poolId: pool.pool_id,
      assets: assetIds,
      reserves: pool.reserves.map(reserve => toBigInt(reserve)),
      amplification: toBigInt(pool.amplification),
      fee: pool.fee,
      totalIssuance,
      pegMultipliers: pool.peg_multipliers?.map(([numerator, denominator]) => [
        toBigInt(numerator),
        toBigInt(denominator),
      ]),
    }
  })

  const poolAccounts = new Set<string>()
  if (payload.omnipool.account) {
    poolAccounts.add(payload.omnipool.account)
  }
  for (const pool of xykPoolItems) {
    poolAccounts.add(pool.pool_account)
  }
  for (const pool of stableswapPoolItems) {
    poolAccounts.add(getStableswapPoolAccount(pool.pool_id))
  }

  const compositionKey = buildCompositionKey(omnipoolAssetItems, xykPoolItems, stableswapPoolItems)

  return {
    assetRows,
    compositionKey,
    decimals,
    atokenEquivalences,
    atokenIds,
    lpEquivalences,
    poolAccounts,
    omnipoolAssets,
    xykPools,
    stableswapPools,
    totalIssuances,
  }
}

export function diffAssetRows(
  previousRows: AssetRow[] | null,
  currentRows: AssetRow[],
): AssetRow[] {
  if (previousRows == null) {
    return currentRows
  }

  const previousById = new Map(previousRows.map(row => [row.asset_id, row]))

  return currentRows.filter(row => {
    const previous = previousById.get(row.asset_id)
    return previous == null ||
      previous.symbol !== row.symbol ||
      previous.name !== row.name ||
      previous.decimals !== row.decimals ||
      previous.parachain_id !== row.parachain_id
      || previous.origin_ecosystem !== row.origin_ecosystem
      || previous.origin_chain_id !== row.origin_chain_id
      || previous.origin_asset_id !== row.origin_asset_id
  })
}

export class ClickHouseSnapshotReader {
  private readonly client: ClickHouseClient
  private readonly nativeAssetRow?: AssetRow
  private readonly finalizedOnly: boolean

  constructor(options: { client?: ClickHouseClient; nativeAssetRow?: AssetRow; finalizedOnly?: boolean } = {}) {
    this.client = options.client ?? createClickHouseClient()
    this.nativeAssetRow = options.nativeAssetRow
    this.finalizedOnly = options.finalizedOnly ?? false
  }

  async assertFinalizedCoverage(fromBlock: number, toBlock: number): Promise<void> {
    await assertFinalizedRawCoverage(this.client, fromBlock, toBlock)
  }

  async *streamRange(fromBlock: number, toBlock: number): AsyncGenerator<HistoricalSnapshotEntry> {
    const ranges = this.finalizedOnly
      ? await getCompletedRawRanges(this.client, fromBlock, toBlock)
      : [{ fromBlock, toBlock }]

    for (const range of ranges) {
      const result = await this.client.query({
        query: `
          SELECT block_height, payload_json
          FROM price_data.raw_block_snapshots FINAL
          WHERE block_height >= ${range.fromBlock}
            AND block_height <= ${range.toBlock}
          ORDER BY block_height ASC
        `,
        format: 'JSONEachRow',
      })

      try {
        for await (const rows of result.stream<SnapshotRow>()) {
          for (const row of rows) {
            const snapshotRow = row.json<SnapshotRow>()
            yield {
              blockHeight: snapshotRow.block_height,
              snapshot: parseSnapshot(snapshotRow.payload_json, { nativeAssetRow: this.nativeAssetRow }),
            }
          }
        }
      } finally {
        result.close()
      }
    }
  }

  async loadRange(fromBlock: number, toBlock: number): Promise<Map<number, HistoricalSnapshotState>> {
    const snapshots = new Map<number, HistoricalSnapshotState>()

    for await (const entry of this.streamRange(fromBlock, toBlock)) {
      snapshots.set(entry.blockHeight, entry.snapshot)
    }

    return snapshots
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}
