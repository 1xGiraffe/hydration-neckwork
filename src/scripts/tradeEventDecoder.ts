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
}

export interface TradeAssetAmount {
  assetId: number
  amount: bigint
}

export interface DecodedRawTrade {
  account: string | null
  inputs: TradeAssetAmount[]
  outputs: TradeAssetAmount[]
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
  if (row.event_name === 'Broadcast.Swapped' && operation === 'ExactOut' && (fillerType === 'XYK' || fillerType === 'LBP') && inputs.length === 1 && outputs.length === 1) {
    return {
      account: normalizeAccount(args.swapper),
      inputs: [{ assetId: inputs[0].assetId, amount: outputs[0].amount }],
      outputs: [{ assetId: outputs[0].assetId, amount: inputs[0].amount }],
    }
  }
  return { account: normalizeAccount(args.swapper), inputs, outputs }
}
