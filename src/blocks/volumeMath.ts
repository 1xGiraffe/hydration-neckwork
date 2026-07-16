import type { TradeVolumeRow } from '../db/schema.js'

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

export function sumBigIntStrings(left: string | undefined, right: string | undefined): string {
  return (BigInt(left ?? '0') + BigInt(right ?? '0')).toString()
}

export function sumDecimal128Strings(left: string | undefined, right: string | undefined): string {
  return formatDecimal128(decimalToScaledBigInt(left) + decimalToScaledBigInt(right))
}

interface VolumeFields {
  native_volume_buy?: string
  native_volume_sell?: string
  usd_volume_buy?: string
  usd_volume_sell?: string
}

export function sumVolumeFields(left: VolumeFields, right: VolumeFields): Required<VolumeFields> {
  return {
    native_volume_buy: sumBigIntStrings(left.native_volume_buy, right.native_volume_buy),
    native_volume_sell: sumBigIntStrings(left.native_volume_sell, right.native_volume_sell),
    usd_volume_buy: sumDecimal128Strings(left.usd_volume_buy, right.usd_volume_buy),
    usd_volume_sell: sumDecimal128Strings(left.usd_volume_sell, right.usd_volume_sell),
  }
}

export function aggregateTradeVolumeRows(rows: TradeVolumeRow[]): TradeVolumeRow[] {
  const byKey = new Map<string, TradeVolumeRow>()
  for (const row of rows) {
    const key = `${row.asset_id}:${row.block_height}:${row.account}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { ...row })
      continue
    }
    byKey.set(key, {
      ...existing,
      ...sumVolumeFields(existing, row),
      trade_count: existing.trade_count + row.trade_count,
    })
  }
  return [...byKey.values()]
}
