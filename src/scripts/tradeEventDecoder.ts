import { EVM_LOG_EVENT_NAME, decodeUniswapV3Log, evmLogOf, uniswapV3SwapTrade, type UniswapV3PoolIndex } from '../price/uniswapV3.js'
import { OTC_FILLER_KIND, otcSides } from '../blocks/otcCounterparty.js'

export const LEGACY_SWAP_EVENT_NAMES = [
  'Omnipool.SellExecuted',
  'Omnipool.BuyExecuted',
  'XYK.SellExecuted',
  'XYK.BuyExecuted',
  'Stableswap.SellExecuted',
  'Stableswap.BuyExecuted',
] as const

export const BROADCAST_SWAP_EVENT_NAMES = [
  'Broadcast.Swapped',
  'Broadcast.Swapped2',
  'Broadcast.Swapped3',
] as const

export const ALL_SWAP_EVENT_NAMES = [...LEGACY_SWAP_EVENT_NAMES, ...BROADCAST_SWAP_EVENT_NAMES]

export interface RawTradeEventRow {
  block_height: number
  event_name: string
  args_json: string
  /** Needed to pair a pool's Swap log with the Broadcast fill of its extrinsic; absent on rows read before it was selected. */
  extrinsic_index?: number | null
  /** Needed to pair an OTC Broadcast fill with the pallet fill event at index - 1. */
  event_index?: number | null
}

export interface TradeAssetAmount {
  assetId: number
  amount: bigint
}

export interface DecodedRawTrade {
  account: string | null
  /** `fillerType.__kind` of a Broadcast trade — what tells an Omnipool hub hop from any other pool's fill. Absent on a legacy pallet event. */
  filler?: string
  /** The Broadcast `filler` ACCOUNT (not the venue kind). Only OTC needs it — see otcSides. */
  fillerAccount?: string | null
  /**
   * The other account of a peer-to-peer fill, holding the MIRROR of the legs.
   * Only OTC sets it; resolved by resolveRawOtcSides once the taker is known.
   */
  counterparty?: string | null
  inputs: TradeAssetAmount[]
  outputs: TradeAssetAmount[]
}

/**
 * The repair path's twin of extractVolume's resolveOtcCounterparties: put an OTC
 * fill's two accounts on their true sides, given the taker the pallet's fill event
 * named. Both call otcSides, so the rule exists once.
 */
export function resolveRawOtcSides(trade: DecodedRawTrade, taker: string | null | undefined): DecodedRawTrade {
  if (trade.filler !== OTC_FILLER_KIND) return trade
  const sides = otcSides(trade.account, trade.fillerAccount, taker)
  return sides ? { ...trade, account: sides.trader, counterparty: sides.counterparty } : trade
}

function normalizeAccount(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (value && typeof value === 'object' && 'value' in value) {
    const nested = (value as { value?: unknown }).value
    if (typeof nested === 'string' && nested.length > 0) return nested
  }
  return null
}

function parseAssetAmounts(value: unknown): TradeAssetAmount[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const asset = (item as { asset?: unknown }).asset
    const amount = (item as { amount?: unknown }).amount
    if (typeof asset !== 'number' || (typeof amount !== 'string' && typeof amount !== 'number' && typeof amount !== 'bigint')) return []
    return [{ assetId: asset, amount: BigInt(amount) }]
  })
}

/**
 * A concentrated-liquidity pool's `Swap` log (an `EVM.Log` row) as a trade, when
 * the pool is one of `pools`. Whether it is booked is the caller's call: a
 * router-routed hop also emits a Broadcast fill in the same extrinsic.
 */
export function decodeRawUniswapV3Swap(row: RawTradeEventRow, pools: UniswapV3PoolIndex): DecodedRawTrade | null {
  if (row.event_name !== EVM_LOG_EVENT_NAME) return null
  const log = evmLogOf(JSON.parse(row.args_json))
  const decoded = log ? decodeUniswapV3Log(log) : null
  if (decoded?.kind !== 'swap') return null
  const swap = uniswapV3SwapTrade(decoded, pools)
  return swap ? { account: swap.account, filler: swap.filler, inputs: swap.inputs, outputs: swap.outputs } : null
}

export function decodeRawTrade(row: RawTradeEventRow): DecodedRawTrade | null {
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

  if (!row.event_name.startsWith('Broadcast.Swapped')) return null

  const inputs = parseAssetAmounts(args.inputs)
  const outputs = parseAssetAmounts(args.outputs)
  const fillerType = (args.fillerType as { __kind?: string } | undefined)?.__kind
  const operation = (args.operation as { __kind?: string } | undefined)?.__kind
  const filler = typeof fillerType === 'string' ? { filler: fillerType } : {}
  if (row.event_name === 'Broadcast.Swapped' && operation === 'ExactOut' && (fillerType === 'XYK' || fillerType === 'LBP') && inputs.length === 1 && outputs.length === 1) {
    return {
      account: normalizeAccount(args.swapper),
      fillerAccount: normalizeAccount(args.filler),
      ...filler,
      inputs: [{ assetId: inputs[0].assetId, amount: outputs[0].amount }],
      outputs: [{ assetId: outputs[0].assetId, amount: inputs[0].amount }],
    }
  }
  return { account: normalizeAccount(args.swapper), fillerAccount: normalizeAccount(args.filler), ...filler, inputs, outputs }
}
