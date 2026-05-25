import { pathToFileURL } from 'node:url'
import { createClickHouseClient, type ClickHouseClient } from '../db/client.js'
import type { PriceRow, TradeVolumeRow } from '../db/schema.js'
import { rebuildOHLCForTimeRange } from '../ohlc/repair.js'

const LEGACY_SWAP_EVENT_NAMES = [
  'Omnipool.SellExecuted',
  'Omnipool.BuyExecuted',
  'XYK.SellExecuted',
  'XYK.BuyExecuted',
  'Stableswap.SellExecuted',
  'Stableswap.BuyExecuted',
] as const

const BROADCAST_SWAP_EVENT_NAMES = [
  'Broadcast.Swapped',
  'Broadcast.Swapped2',
  'Broadcast.Swapped3',
] as const

const ALL_SWAP_EVENT_NAMES = [...LEGACY_SWAP_EVENT_NAMES, ...BROADCAST_SWAP_EVENT_NAMES]
const DEFAULT_CHUNK_SIZE = 5_000
const DEFAULT_SAFETY_LAG_BLOCKS = 100
const DEFAULT_KEY_DELETE_BATCH_SIZE = 5_000
const FALLBACK_UNIFIED_SWAP_FROM_BLOCK = 6_837_786

type RepairTarget = 'trade-volume' | 'prices' | 'ohlc'

interface Args {
  fromBlock?: number
  toBlock?: number
  fromTime?: string
  toTime?: string
  lastHours?: number
  lastDays?: number
  allHistory: boolean
  targets: Set<RepairTarget>
  chunkSize: number
  safetyLagBlocks: number
  apply: boolean
  help: boolean
}

export interface RawEventRow {
  block_height: number
  event_name: string
  args_json: string
}

interface SnapshotRow {
  block_height: number
  payload_json: string
}

interface AssetAmount {
  assetId: number
  amount: bigint
}

export interface DecodedTrade {
  account: string | null
  inputs: AssetAmount[]
  outputs: AssetAmount[]
}

interface TradeLeg extends AssetAmount {
  canonicalAssetId: number
}

export interface AliasState {
  atokenToBase: Map<number, number>
  lpToDisplay: Map<number, number>
  decimals: Map<number, number>
}

export interface PriceVolumeRow {
  asset_id: number
  block_height: number
  native_volume_buy: string
  native_volume_sell: string
  usd_volume_buy: string
  usd_volume_sell: string
}

interface ExistingPriceRow extends PriceRow {
  native_volume_buy: string
  native_volume_sell: string
  usd_volume_buy: string
  usd_volume_sell: string
  hops: number
}

interface RepairChunkResult {
  events: number
  tradeRows: number
  priceKeys: number
}

function parsePositiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function parseTargets(value: string): Set<RepairTarget> {
  const targets = new Set<RepairTarget>()
  for (const rawPart of value.split(',')) {
    const part = rawPart.trim()
    if (part === 'trade-volume' || part === 'prices' || part === 'ohlc') {
      targets.add(part)
      continue
    }
    if (part === 'all') {
      targets.add('trade-volume')
      targets.add('prices')
      targets.add('ohlc')
      continue
    }
    throw new Error(`Unknown repair target: ${part}`)
  }
  return targets
}

export function parseArgs(argv = process.argv.slice(2)): Args {
  const args: Args = {
    allHistory: false,
    targets: parseTargets('all'),
    chunkSize: DEFAULT_CHUNK_SIZE,
    safetyLagBlocks: DEFAULT_SAFETY_LAG_BLOCKS,
    apply: false,
    help: false,
  }

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      args.help = true
    } else if (arg === '--apply') {
      args.apply = true
    } else if (arg === '--all-history') {
      args.allHistory = true
    } else if (arg.startsWith('--from-block=')) {
      args.fromBlock = parsePositiveInt(arg.split('=')[1])
    } else if (arg.startsWith('--to-block=')) {
      args.toBlock = parsePositiveInt(arg.split('=')[1])
    } else if (arg.startsWith('--from-time=')) {
      args.fromTime = arg.slice('--from-time='.length)
    } else if (arg.startsWith('--to-time=')) {
      args.toTime = arg.slice('--to-time='.length)
    } else if (arg.startsWith('--last-hours=')) {
      args.lastHours = parsePositiveNumber(arg.split('=')[1])
    } else if (arg.startsWith('--last-days=')) {
      args.lastDays = parsePositiveNumber(arg.split('=')[1])
    } else if (arg.startsWith('--targets=')) {
      args.targets = parseTargets(arg.slice('--targets='.length))
    } else if (arg === '--skip-ohlc') {
      args.targets.delete('ohlc')
    } else if (arg.startsWith('--chunk-size=')) {
      args.chunkSize = parsePositiveInt(arg.split('=')[1]) ?? args.chunkSize
    } else if (arg.startsWith('--safety-lag-blocks=')) {
      args.safetyLagBlocks = parsePositiveInt(arg.split('=')[1]) ?? args.safetyLagBlocks
    }
  }

  return args
}

function printHelp(): void {
  console.log(`
Volume Repair

Usage:
  npm run repair:volume -- [range] [options]

Ranges, choose one:
  --from-block=N [--to-block=N]       Repair from block N through to-block or the safe tip.
  --from-time=TIME --to-time=TIME     Repair blocks with UTC timestamps in [from, to].
  --last-hours=N                      Repair the latest N hours, capped by the safety lag.
  --last-days=N                       Repair the latest N days, capped by the safety lag.
  --all-history                       Repair all raw swap history, capped by the safety lag.

Options:
  --targets=all|trade-volume,prices,ohlc
                                      What to repair. Default: all.
  --skip-ohlc                         Shortcut for --targets=trade-volume,prices.
  --chunk-size=N                      Blocks per repair chunk. Default: ${DEFAULT_CHUNK_SIZE}.
  --safety-lag-blocks=N               Do not repair the latest N blocks. Default: ${DEFAULT_SAFETY_LAG_BLOCKS}.
  --apply                             Mutate ClickHouse. Without this, the script is a dry run.
  --help, -h                          Print this help message.

Examples:
  npm run repair:volume -- --last-days=1
  npm run repair:volume -- --last-days=1 --apply
  npm run repair:volume -- --from-time="2026-05-25 20:00:00" --to-time="2026-05-25 21:00:00" --apply
`)
}

function normalizeDateTime(value: string): string {
  const trimmed = value.trim()
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed.replace('T', ' ')

  const parsed = new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(trimmed) ? trimmed : `${trimmed}Z`)
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid timestamp: ${value}`)
  return parsed.toISOString().slice(0, 19).replace('T', ' ')
}

export function decimalToScaledBigInt(value: string | number | null | undefined): bigint {
  const normalized = String(value ?? '0')
  const sign = normalized.startsWith('-') ? '-' : ''
  const unsigned = sign ? normalized.slice(1) : normalized
  const [integerPart, rawFraction = ''] = unsigned.split('.')
  const fraction = rawFraction.padEnd(12, '0').slice(0, 12)
  return BigInt(`${sign}${integerPart || '0'}${fraction}`)
}

export function formatDecimal128(value: bigint): string {
  const sign = value < 0n ? '-' : ''
  const unsigned = value < 0n ? -value : value
  const integerPart = unsigned / 1_000_000_000_000n
  const fractionalPart = unsigned % 1_000_000_000_000n
  return `${sign}${integerPart}.${fractionalPart.toString().padStart(12, '0')}`
}

function calculateUsdVolume(nativeAmount: bigint, price: string | undefined, decimals: number | undefined): string {
  if (nativeAmount === 0n || !price || decimals == null) return '0.000000000000'
  return formatDecimal128((nativeAmount * decimalToScaledBigInt(price)) / (10n ** BigInt(decimals)))
}

function sumBigIntStrings(a: string | undefined, b: string | undefined): string {
  return (BigInt(a ?? '0') + BigInt(b ?? '0')).toString()
}

function sumDecimal128Strings(a: string | undefined, b: string | undefined): string {
  return formatDecimal128(decimalToScaledBigInt(a) + decimalToScaledBigInt(b))
}

function zeroPriceVolume(blockHeight: number, assetId: number): PriceVolumeRow {
  return {
    asset_id: assetId,
    block_height: blockHeight,
    native_volume_buy: '0',
    native_volume_sell: '0',
    usd_volume_buy: '0.000000000000',
    usd_volume_sell: '0.000000000000',
  }
}

function normalizeAccount(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (value && typeof value === 'object' && 'value' in value) {
    const nested = (value as { value?: unknown }).value
    if (typeof nested === 'string' && nested.length > 0) return nested
  }
  return null
}

function parseAssetAmounts(value: unknown): AssetAmount[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const asset = (item as { asset?: unknown }).asset
    const amount = (item as { amount?: unknown }).amount
    if (typeof asset !== 'number' || (typeof amount !== 'string' && typeof amount !== 'number' && typeof amount !== 'bigint')) {
      return []
    }
    return [{ assetId: asset, amount: BigInt(amount) }]
  })
}

export function decodeTrade(row: RawEventRow): DecodedTrade | null {
  const args = JSON.parse(row.args_json) as Record<string, unknown>

  if (row.event_name === 'Omnipool.SellExecuted' || row.event_name === 'Omnipool.BuyExecuted' || row.event_name === 'Stableswap.SellExecuted' || row.event_name === 'Stableswap.BuyExecuted') {
    return {
      account: normalizeAccount(args.who),
      inputs: [{ assetId: Number(args.assetIn), amount: BigInt(args.amountIn as string) }],
      outputs: [{ assetId: Number(args.assetOut), amount: BigInt(args.amountOut as string) }],
    }
  }

  if (row.event_name === 'XYK.SellExecuted') {
    return {
      account: normalizeAccount(args.who),
      inputs: [{ assetId: Number(args.assetIn), amount: BigInt(args.amount as string) }],
      outputs: [{ assetId: Number(args.assetOut), amount: BigInt(args.salePrice as string) }],
    }
  }

  if (row.event_name === 'XYK.BuyExecuted') {
    return {
      account: normalizeAccount(args.who),
      inputs: [{ assetId: Number(args.assetIn), amount: BigInt(args.buyPrice as string) }],
      outputs: [{ assetId: Number(args.assetOut), amount: BigInt(args.amount as string) }],
    }
  }

  if (row.event_name.startsWith('Broadcast.Swapped')) {
    const fillerType = (args.fillerType as { __kind?: string } | undefined)?.__kind
    const operation = (args.operation as { __kind?: string } | undefined)?.__kind
    const inputs = parseAssetAmounts(args.inputs)
    const outputs = parseAssetAmounts(args.outputs)
    const account = normalizeAccount(args.swapper)

    if (
      row.event_name === 'Broadcast.Swapped' &&
      operation === 'ExactOut' &&
      (fillerType === 'XYK' || fillerType === 'LBP') &&
      inputs.length === 1 &&
      outputs.length === 1
    ) {
      return {
        account,
        inputs: [{ assetId: inputs[0].assetId, amount: outputs[0].amount }],
        outputs: [{ assetId: outputs[0].assetId, amount: inputs[0].amount }],
      }
    }

    return { account, inputs, outputs }
  }

  return null
}

function parseEquivalenceList(value: unknown): [number, number][] {
  if (!Array.isArray(value)) return []
  const pairs: [number, number][] = []

  for (const item of value) {
    if (Array.isArray(item) && item.length >= 2) {
      pairs.push([Number(item[0]), Number(item[1])])
    }
  }

  return pairs.filter(([left, right]) => Number.isFinite(left) && Number.isFinite(right))
}

export function aliasStateFromSnapshot(payloadJson: string): AliasState {
  const payload = JSON.parse(payloadJson) as {
    assets?: {
      items?: Array<{ assetId: number; decimals: number }>
      atoken_equivalences?: unknown
      lp_equivalences?: unknown
    }
  }
  const atokenToBase = new Map<number, number>()
  for (const [baseId, aTokenId] of parseEquivalenceList(payload.assets?.atoken_equivalences)) {
    atokenToBase.set(aTokenId, baseId)
  }

  const lpToDisplay = new Map<number, number>(parseEquivalenceList(payload.assets?.lp_equivalences))
  const decimals = new Map<number, number>()
  for (const item of payload.assets?.items ?? []) {
    if (Number.isInteger(item.assetId) && Number.isInteger(item.decimals)) {
      decimals.set(item.assetId, item.decimals)
    }
  }

  return { atokenToBase, lpToDisplay, decimals }
}

export function canonicalAssetId(assetId: number, aliases: AliasState): number {
  const baseId = aliases.atokenToBase.get(assetId)
  const canonicalId = baseId ?? assetId
  return aliases.lpToDisplay.get(canonicalId) ?? canonicalId
}

function canonicalTradeLegs(trade: DecodedTrade, aliases: AliasState): { inputs: TradeLeg[]; outputs: TradeLeg[] } {
  return {
    inputs: trade.inputs.map(input => ({ ...input, canonicalAssetId: canonicalAssetId(input.assetId, aliases) })),
    outputs: trade.outputs.map(output => ({ ...output, canonicalAssetId: canonicalAssetId(output.assetId, aliases) })),
  }
}

function originalsByCanonicalAsset(legs: TradeLeg[]): Map<number, Set<number>> {
  const result = new Map<number, Set<number>>()
  for (const leg of legs) {
    const originals = result.get(leg.canonicalAssetId) ?? new Set<number>()
    originals.add(leg.assetId)
    result.set(leg.canonicalAssetId, originals)
  }
  return result
}

function isCanonicalSelfConversion(leg: TradeLeg, opposingOriginalsByCanonical: Map<number, Set<number>>): boolean {
  const originals = opposingOriginalsByCanonical.get(leg.canonicalAssetId)
  return originals ? [...originals].some(opposingAssetId => opposingAssetId !== leg.assetId) : false
}

function priceKey(blockHeight: number, assetId: number): string {
  return `${blockHeight}:${assetId}`
}

function tradeKey(row: TradeVolumeRow): string {
  return `${row.asset_id}:${row.block_height}:${row.account}`
}

export function rowsForTrade(
  trade: DecodedTrade,
  blockHeight: number,
  aliases: AliasState,
  prices: Map<string, string>
): { tradeRows: TradeVolumeRow[]; priceRows: PriceVolumeRow[] } {
  const { inputs, outputs } = canonicalTradeLegs(trade, aliases)
  const outputOriginalsByCanonical = originalsByCanonicalAsset(outputs)
  const inputOriginalsByCanonical = originalsByCanonicalAsset(inputs)
  const tradeRowsByAsset = new Map<number, TradeVolumeRow>()
  const priceRowsByAsset = new Map<number, PriceVolumeRow>()

  const priceRowForAsset = (assetId: number): PriceVolumeRow => {
    let row = priceRowsByAsset.get(assetId)
    if (!row) {
      row = zeroPriceVolume(blockHeight, assetId)
      priceRowsByAsset.set(assetId, row)
    }
    return row
  }

  const tradeRowForAsset = (assetId: number): TradeVolumeRow | null => {
    if (!trade.account) return null
    let row = tradeRowsByAsset.get(assetId)
    if (!row) {
      row = {
        asset_id: assetId,
        block_height: blockHeight,
        account: trade.account,
        native_volume_buy: '0',
        native_volume_sell: '0',
        usd_volume_buy: '0.000000000000',
        usd_volume_sell: '0.000000000000',
        trade_count: 1,
      }
      tradeRowsByAsset.set(assetId, row)
    }
    return row
  }

  for (const input of inputs) {
    if (isCanonicalSelfConversion(input, outputOriginalsByCanonical)) continue

    const usdVolume = calculateUsdVolume(
      input.amount,
      prices.get(priceKey(blockHeight, input.assetId)),
      aliases.decimals.get(input.assetId),
    )
    const priceRow = priceRowForAsset(input.canonicalAssetId)
    priceRow.native_volume_sell = sumBigIntStrings(priceRow.native_volume_sell, input.amount.toString())
    priceRow.usd_volume_sell = sumDecimal128Strings(priceRow.usd_volume_sell, usdVolume)

    const tradeRow = tradeRowForAsset(input.canonicalAssetId)
    if (tradeRow) {
      tradeRow.native_volume_sell = sumBigIntStrings(tradeRow.native_volume_sell, input.amount.toString())
      tradeRow.usd_volume_sell = sumDecimal128Strings(tradeRow.usd_volume_sell, usdVolume)
    }
  }

  for (const output of outputs) {
    if (isCanonicalSelfConversion(output, inputOriginalsByCanonical)) continue

    const usdVolume = calculateUsdVolume(
      output.amount,
      prices.get(priceKey(blockHeight, output.assetId)),
      aliases.decimals.get(output.assetId),
    )
    const priceRow = priceRowForAsset(output.canonicalAssetId)
    priceRow.native_volume_buy = sumBigIntStrings(priceRow.native_volume_buy, output.amount.toString())
    priceRow.usd_volume_buy = sumDecimal128Strings(priceRow.usd_volume_buy, usdVolume)

    const tradeRow = tradeRowForAsset(output.canonicalAssetId)
    if (tradeRow) {
      tradeRow.native_volume_buy = sumBigIntStrings(tradeRow.native_volume_buy, output.amount.toString())
      tradeRow.usd_volume_buy = sumDecimal128Strings(tradeRow.usd_volume_buy, usdVolume)
    }
  }

  return {
    tradeRows: [...tradeRowsByAsset.values()],
    priceRows: [...priceRowsByAsset.values()],
  }
}

export function aggregateTradeRows(rows: TradeVolumeRow[]): TradeVolumeRow[] {
  const byKey = new Map<string, TradeVolumeRow>()
  for (const row of rows) {
    const key = tradeKey(row)
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { ...row })
      continue
    }

    byKey.set(key, {
      ...existing,
      native_volume_buy: sumBigIntStrings(existing.native_volume_buy, row.native_volume_buy),
      native_volume_sell: sumBigIntStrings(existing.native_volume_sell, row.native_volume_sell),
      usd_volume_buy: sumDecimal128Strings(existing.usd_volume_buy, row.usd_volume_buy),
      usd_volume_sell: sumDecimal128Strings(existing.usd_volume_sell, row.usd_volume_sell),
      trade_count: existing.trade_count + row.trade_count,
    })
  }
  return [...byKey.values()]
}

export function aggregatePriceVolumeRows(rows: PriceVolumeRow[]): PriceVolumeRow[] {
  const byKey = new Map<string, PriceVolumeRow>()
  for (const row of rows) {
    const key = priceKey(row.block_height, row.asset_id)
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { ...row })
      continue
    }

    byKey.set(key, {
      ...existing,
      native_volume_buy: sumBigIntStrings(existing.native_volume_buy, row.native_volume_buy),
      native_volume_sell: sumBigIntStrings(existing.native_volume_sell, row.native_volume_sell),
      usd_volume_buy: sumDecimal128Strings(existing.usd_volume_buy, row.usd_volume_buy),
      usd_volume_sell: sumDecimal128Strings(existing.usd_volume_sell, row.usd_volume_sell),
    })
  }
  return [...byKey.values()]
}

export function buildRepairedPriceRows(existingRows: ExistingPriceRow[], correctedRows: PriceVolumeRow[]): PriceRow[] {
  const existingByKey = new Map(existingRows.map(row => [priceKey(row.block_height, row.asset_id), row]))
  const correctedByKey = new Map(correctedRows.map(row => [priceKey(row.block_height, row.asset_id), row]))
  const touchedKeys = new Set([...existingByKey.keys(), ...correctedByKey.keys()])

  return [...touchedKeys].flatMap(key => {
    const existing = existingByKey.get(key)
    const corrected = correctedByKey.get(key)
    const [blockHeight, assetId] = key.split(':').map(Number)
    const usdPrice = existing?.usd_price ?? '0'
    if (Number(usdPrice) <= 0) return []

    return [{
      asset_id: assetId,
      block_height: blockHeight,
      usd_price: usdPrice,
      native_volume_buy: corrected?.native_volume_buy ?? '0',
      native_volume_sell: corrected?.native_volume_sell ?? '0',
      usd_volume_buy: corrected?.usd_volume_buy ?? '0.000000000000',
      usd_volume_sell: corrected?.usd_volume_sell ?? '0.000000000000',
      hops: existing?.hops ?? 0,
    }]
  })
}

async function getUnifiedSwapFromBlock(client: ClickHouseClient): Promise<number> {
  const result = await client.query({
    query: `SELECT min(block_height) AS block_height FROM price_data.runtime_upgrades WHERE spec_version >= 282`,
    format: 'JSONEachRow',
  })
  const rows = await result.json<{ block_height: number }>()
  return Number(rows[0]?.block_height) || FALLBACK_UNIFIED_SWAP_FROM_BLOCK
}

async function getSafeTip(client: ClickHouseClient, safetyLagBlocks: number): Promise<number> {
  const result = await client.query({
    query: `SELECT max(block_height) AS max_block FROM price_data.blocks`,
    format: 'JSONEachRow',
  })
  const rows = await result.json<{ max_block: number }>()
  return Math.max(0, Number(rows[0]?.max_block) - safetyLagBlocks)
}

async function getRawSwapHistoryRange(client: ClickHouseClient): Promise<{ from: number; to: number }> {
  const result = await client.query({
    query: `
      SELECT min(block_height) AS min_block, max(block_height) AS max_block
      FROM price_data.raw_events FINAL
      WHERE event_name IN ({names:Array(String)})
    `,
    query_params: { names: ALL_SWAP_EVENT_NAMES },
    format: 'JSONEachRow',
  })
  const rows = await result.json<{ min_block: number; max_block: number }>()
  return { from: Number(rows[0]?.min_block) || 0, to: Number(rows[0]?.max_block) || 0 }
}

async function getMaxBlockTime(client: ClickHouseClient): Promise<string> {
  const result = await client.query({
    query: `SELECT toString(max(block_timestamp)) AS block_timestamp FROM price_data.blocks`,
    format: 'JSONEachRow',
  })
  const rows = await result.json<{ block_timestamp: string }>()
  return rows[0]?.block_timestamp
}

async function blockRangeForTimeRange(client: ClickHouseClient, fromTime: string, toTime: string): Promise<{ from: number; to: number }> {
  const result = await client.query({
    query: `
      SELECT min(block_height) AS min_block, max(block_height) AS max_block
      FROM price_data.blocks
      WHERE block_timestamp >= {from_time:DateTime}
        AND block_timestamp <= {to_time:DateTime}
    `,
    query_params: { from_time: fromTime, to_time: toTime },
    format: 'JSONEachRow',
  })
  const rows = await result.json<{ min_block: number; max_block: number }>()
  return { from: Number(rows[0]?.min_block) || 0, to: Number(rows[0]?.max_block) || 0 }
}

export async function resolveRange(client: ClickHouseClient, args: Args): Promise<{ from: number; to: number; safeTip: number }> {
  const safeTip = await getSafeTip(client, args.safetyLagBlocks)
  let range: { from: number; to: number }

  if (args.fromBlock != null || args.toBlock != null) {
    if (args.fromBlock == null) throw new Error('--from-block is required when using --to-block')
    range = { from: args.fromBlock, to: args.toBlock ?? safeTip }
  } else if (args.fromTime || args.toTime) {
    if (!args.fromTime || !args.toTime) throw new Error('Both --from-time and --to-time are required')
    range = await blockRangeForTimeRange(client, normalizeDateTime(args.fromTime), normalizeDateTime(args.toTime))
  } else if (args.lastHours || args.lastDays) {
    const hours = args.lastHours ?? (args.lastDays ?? 0) * 24
    const maxTime = new Date(`${await getMaxBlockTime(client)}Z`)
    const fromTime = new Date(maxTime.getTime() - hours * 60 * 60 * 1000)
    range = await blockRangeForTimeRange(
      client,
      fromTime.toISOString().slice(0, 19).replace('T', ' '),
      maxTime.toISOString().slice(0, 19).replace('T', ' '),
    )
  } else if (args.allHistory) {
    range = await getRawSwapHistoryRange(client)
  } else {
    throw new Error('Pick a repair range: --last-hours, --last-days, --from-block, --from-time/--to-time, or --all-history')
  }

  if (range.from <= 0 || range.to <= 0 || range.from > range.to) {
    throw new Error(`Invalid repair range: ${range.from}..${range.to}`)
  }

  return { from: range.from, to: Math.min(range.to, safeTip), safeTip }
}

async function queryRawEvents(client: ClickHouseClient, from: number, to: number, unifiedSwapFromBlock: number): Promise<RawEventRow[]> {
  const result = await client.query({
    query: `
      SELECT block_height, event_name, args_json
      FROM price_data.raw_events FINAL
      WHERE block_height BETWEEN {from:UInt32} AND {to:UInt32}
        AND (
          (block_height < {unified_from:UInt32} AND event_name IN ({legacy_names:Array(String)}))
          OR
          (block_height >= {unified_from:UInt32} AND event_name IN ({broadcast_names:Array(String)}))
        )
      ORDER BY block_height, event_index
    `,
    query_params: {
      from,
      to,
      unified_from: unifiedSwapFromBlock,
      legacy_names: LEGACY_SWAP_EVENT_NAMES,
      broadcast_names: BROADCAST_SWAP_EVENT_NAMES,
    },
    format: 'JSONEachRow',
  })
  return await result.json<RawEventRow>()
}

async function querySnapshots(client: ClickHouseClient, blockHeights: number[]): Promise<Map<number, AliasState>> {
  if (blockHeights.length === 0) return new Map()

  const result = await client.query({
    query: `
      SELECT block_height, payload_json
      FROM price_data.raw_block_snapshots FINAL
      WHERE block_height IN ({blocks:Array(UInt32)})
    `,
    query_params: { blocks: blockHeights },
    format: 'JSONEachRow',
  })
  const rows = await result.json<SnapshotRow>()
  return new Map(rows.map(row => [row.block_height, aliasStateFromSnapshot(row.payload_json)]))
}

async function queryPricesForAssets(client: ClickHouseClient, from: number, to: number, assetIds: number[]): Promise<Map<string, string>> {
  if (assetIds.length === 0) return new Map()

  const result = await client.query({
    query: `
      SELECT block_height, asset_id, toString(usd_price) AS usd_price
      FROM price_data.prices FINAL
      WHERE block_height BETWEEN {from:UInt32} AND {to:UInt32}
        AND asset_id IN ({asset_ids:Array(UInt32)})
    `,
    query_params: { from, to, asset_ids: assetIds },
    format: 'JSONEachRow',
  })
  const rows = await result.json<{ block_height: number; asset_id: number; usd_price: string }>()
  return new Map(rows.map(row => [priceKey(row.block_height, row.asset_id), row.usd_price]))
}

async function queryExistingNonZeroPriceRows(client: ClickHouseClient, from: number, to: number): Promise<ExistingPriceRow[]> {
  const result = await client.query({
    query: `
      SELECT
        block_height,
        asset_id,
        toString(usd_price) AS usd_price,
        toString(native_volume_buy) AS native_volume_buy,
        toString(native_volume_sell) AS native_volume_sell,
        toString(usd_volume_buy) AS usd_volume_buy,
        toString(usd_volume_sell) AS usd_volume_sell,
        hops
      FROM (SELECT * FROM price_data.prices FINAL) AS p
      WHERE p.block_height BETWEEN {from:UInt32} AND {to:UInt32}
        AND (
          p.native_volume_buy != 0
          OR p.native_volume_sell != 0
          OR p.usd_volume_buy != 0
          OR p.usd_volume_sell != 0
        )
    `,
    query_params: { from, to },
    format: 'JSONEachRow',
  })
  return await result.json<ExistingPriceRow>()
}

async function queryExistingPriceRowsForCorrectedKeys(
  client: ClickHouseClient,
  correctedRows: PriceVolumeRow[]
): Promise<ExistingPriceRow[]> {
  const blockHeights = [...new Set(correctedRows.map(row => row.block_height))]
  const assetIds = [...new Set(correctedRows.map(row => row.asset_id))]
  if (blockHeights.length === 0 || assetIds.length === 0) return []

  const result = await client.query({
    query: `
      SELECT
        block_height,
        asset_id,
        toString(usd_price) AS usd_price,
        toString(native_volume_buy) AS native_volume_buy,
        toString(native_volume_sell) AS native_volume_sell,
        toString(usd_volume_buy) AS usd_volume_buy,
        toString(usd_volume_sell) AS usd_volume_sell,
        hops
      FROM price_data.prices FINAL
      WHERE block_height IN ({blocks:Array(UInt32)})
        AND asset_id IN ({asset_ids:Array(UInt32)})
    `,
    query_params: { blocks: blockHeights, asset_ids: assetIds },
    format: 'JSONEachRow',
  })
  return await result.json<ExistingPriceRow>()
}

function mergeExistingPriceRows(rows: ExistingPriceRow[]): ExistingPriceRow[] {
  return [...new Map(rows.map(row => [priceKey(row.block_height, row.asset_id), row])).values()]
}

function tupleListForPriceKeys(keys: string[]): string {
  return keys.map(key => {
    const [blockHeight, assetId] = key.split(':').map(Number)
    return `(${assetId}, ${blockHeight})`
  }).join(', ')
}

async function deletePriceKeys(client: ClickHouseClient, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += DEFAULT_KEY_DELETE_BATCH_SIZE) {
    const batch = keys.slice(i, i + DEFAULT_KEY_DELETE_BATCH_SIZE)
    await client.command({
      query: `DELETE FROM price_data.prices WHERE (asset_id, block_height) IN (${tupleListForPriceKeys(batch)})`,
      clickhouse_settings: { mutations_sync: '1' },
    })
  }
}

async function insertTradeRows(client: ClickHouseClient, rows: TradeVolumeRow[], from: number, to: number, runId: string): Promise<void> {
  if (rows.length === 0) return
  await client.insert({
    table: 'price_data.trade_volume_by_account',
    values: rows,
    format: 'JSONEachRow',
    clickhouse_settings: {
      insert_deduplication_token: `volume-repair-trade-${runId}-${from}-${to}-${rows.length}`,
    },
  })
}

async function insertPriceRows(client: ClickHouseClient, rows: PriceRow[], from: number, to: number, runId: string): Promise<void> {
  if (rows.length === 0) return
  await client.insert({
    table: 'price_data.prices',
    values: rows,
    format: 'JSONEachRow',
    clickhouse_settings: {
      insert_deduplication_token: `volume-repair-prices-${runId}-${from}-${to}-${rows.length}`,
    },
  })
}

async function repairChunk(
  client: ClickHouseClient,
  options: { from: number; to: number; unifiedSwapFromBlock: number; targets: Set<RepairTarget>; apply: boolean; runId: string }
): Promise<RepairChunkResult> {
  const events = await queryRawEvents(client, options.from, options.to, options.unifiedSwapFromBlock)
  const trades = events.flatMap(row => {
    const trade = decodeTrade(row)
    return trade && (trade.inputs.length > 0 || trade.outputs.length > 0) ? [{ blockHeight: row.block_height, trade }] : []
  })
  const eventBlocks = [...new Set(trades.map(row => row.blockHeight))]
  const snapshots = await querySnapshots(client, eventBlocks)
  const missingSnapshots = eventBlocks.filter(blockHeight => !snapshots.has(blockHeight))
  if (missingSnapshots.length > 0) {
    throw new Error(`Missing raw snapshots for ${missingSnapshots.length} event blocks, first missing block: ${missingSnapshots[0]}`)
  }

  const sourceAssetIds = [...new Set(trades.flatMap(({ trade }) => [
    ...trade.inputs.map(input => input.assetId),
    ...trade.outputs.map(output => output.assetId),
  ]))].sort((a, b) => a - b)
  const prices = await queryPricesForAssets(client, options.from, options.to, sourceAssetIds)

  const generated = trades.map(({ blockHeight, trade }) => {
    const aliases = snapshots.get(blockHeight)
    if (!aliases) throw new Error(`Missing aliases for block ${blockHeight}`)
    return rowsForTrade(trade, blockHeight, aliases, prices)
  })
  const tradeRows = aggregateTradeRows(generated.flatMap(item => item.tradeRows))
  const correctedPriceRows = aggregatePriceVolumeRows(generated.flatMap(item => item.priceRows))

  let repairedPriceRows: PriceRow[] = []
  let priceKeysToDelete: string[] = []
  if (options.targets.has('prices')) {
    const [nonZeroExisting, correctedExisting] = await Promise.all([
      queryExistingNonZeroPriceRows(client, options.from, options.to),
      queryExistingPriceRowsForCorrectedKeys(client, correctedPriceRows),
    ])
    const existingRows = mergeExistingPriceRows([...nonZeroExisting, ...correctedExisting])
    priceKeysToDelete = [...new Set([
      ...existingRows.map(row => priceKey(row.block_height, row.asset_id)),
      ...correctedPriceRows.map(row => priceKey(row.block_height, row.asset_id)),
    ])]
    repairedPriceRows = buildRepairedPriceRows(existingRows, correctedPriceRows)
  }

  if (options.apply) {
    if (options.targets.has('trade-volume')) {
      await client.command({
        query: `DELETE FROM price_data.trade_volume_by_account WHERE block_height BETWEEN ${options.from} AND ${options.to}`,
        clickhouse_settings: { mutations_sync: '1' },
      })
      await insertTradeRows(client, tradeRows, options.from, options.to, options.runId)
    }

    if (options.targets.has('prices')) {
      await deletePriceKeys(client, priceKeysToDelete)
      await insertPriceRows(client, repairedPriceRows, options.from, options.to, options.runId)
    }
  }

  return {
    events: events.length,
    tradeRows: tradeRows.length,
    priceKeys: priceKeysToDelete.length,
  }
}

async function blockTimeBounds(client: ClickHouseClient, from: number, to: number): Promise<{ startTime: string; endTime: string }> {
  const result = await client.query({
    query: `
      SELECT
        toString(min(block_timestamp)) AS start_time,
        toString(max(block_timestamp)) AS end_time
      FROM price_data.blocks
      WHERE block_height BETWEEN {from:UInt32} AND {to:UInt32}
    `,
    query_params: { from, to },
    format: 'JSONEachRow',
  })
  const rows = await result.json<{ start_time: string; end_time: string }>()
  return { startTime: rows[0]?.start_time, endTime: rows[0]?.end_time }
}

async function main(): Promise<void> {
  const args = parseArgs()
  if (args.help) {
    printHelp()
    return
  }

  const client = createClickHouseClient()
  try {
    const { from, to, safeTip } = await resolveRange(client, args)
    if (from > to) {
      throw new Error(`Repair range is fully inside the safety lag. Safe tip is ${safeTip}.`)
    }

    const targets = [...args.targets].join(', ')
    const unifiedSwapFromBlock = await getUnifiedSwapFromBlock(client)
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '')
    console.log(`[volume-repair] ${args.apply ? 'APPLY' : 'DRY RUN'} ${from}..${to} (${targets}), chunk=${args.chunkSize}, safe_tip=${safeTip}`)
    if (!args.apply) console.log('[volume-repair] Pass --apply to mutate ClickHouse.')

    let totalEvents = 0
    let totalTradeRows = 0
    let totalPriceKeys = 0

    if (args.targets.has('trade-volume') || args.targets.has('prices')) {
      for (let start = from; start <= to; start += args.chunkSize) {
        const end = Math.min(to, start + args.chunkSize - 1)
        const result = await repairChunk(client, {
          from: start,
          to: end,
          unifiedSwapFromBlock,
          targets: args.targets,
          apply: args.apply,
          runId,
        })
        totalEvents += result.events
        totalTradeRows += result.tradeRows
        totalPriceKeys += result.priceKeys
        console.log(`[volume-repair] ${start}..${end}: ${result.events} events -> ${result.tradeRows} account rows, ${result.priceKeys} price keys`)
      }
    }

    if (args.targets.has('ohlc')) {
      const { startTime, endTime } = await blockTimeBounds(client, from, to)
      if (args.apply) {
        console.log(`[volume-repair] Rebuilding OHLC intervals for ${startTime}..${endTime}`)
        await rebuildOHLCForTimeRange(client, startTime, endTime)
      } else {
        console.log(`[volume-repair] Would rebuild OHLC intervals for ${startTime}..${endTime}`)
      }
    }

    console.log(`[volume-repair] Done: ${totalEvents} events -> ${totalTradeRows} account rows, ${totalPriceKeys} price keys`)
  } finally {
    await client.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('[volume-repair] Failed:', error)
    process.exit(1)
  })
}
