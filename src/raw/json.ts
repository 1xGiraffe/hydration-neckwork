import { Buffer } from 'node:buffer'
import { toClickHouseBlockTime } from '../db/timestamp.js'

function isPlainBytesArray(value: unknown): value is number[] {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every(item => Number.isInteger(item) && item >= 0 && item <= 255)
}

export function toHex(value: Uint8Array | Buffer | number[] | string): string {
  if (typeof value === 'string') {
    return value.startsWith('0x') ? value : `0x${value}`
  }
  if (Array.isArray(value)) {
    return `0x${Buffer.from(value).toString('hex')}`
  }
  return `0x${Buffer.from(value).toString('hex')}`
}

export function toJsonString(value: unknown): string {
  return JSON.stringify(value, (_, currentValue) => {
    if (typeof currentValue === 'bigint') return currentValue.toString()
    if (currentValue instanceof Uint8Array) return toHex(currentValue)
    if (Buffer.isBuffer(currentValue)) return toHex(currentValue)
    if (currentValue instanceof Map) return Object.fromEntries(currentValue)
    if (currentValue instanceof Set) return [...currentValue]
    if (isPlainBytesArray(currentValue)) return toHex(currentValue)
    return currentValue
  }) ?? 'null'
}

export function toClickHouseDateTime(timestamp?: number, blockHeight?: number): string {
  return toClickHouseBlockTime(timestamp, blockHeight)
}

export function callAddressToString(address?: number[] | null): string | null {
  if (address == null) return null
  if (address.length === 0) return 'root'
  return address.join('.')
}

function extractAddressLike(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array || Buffer.isBuffer(value) || isPlainBytesArray(value)) {
    return toHex(value)
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['id', 'value', 'address', 'key']) {
      if (record[key] != null) {
        const nested = extractAddressLike(record[key])
        if (nested) return nested
      }
    }
  }
  return null
}

export function extractSigner(signature: { address?: unknown } | undefined): string | null {
  return extractAddressLike(signature?.address)
}

// H160 EVM address -> its truncated AccountId32 form (0x45544800 + 20-byte H160 +
// zero pad to 32 bytes), the canonical key under which Hydration indexes an EVM
// account's substrate-side activity. Returns null for anything that isn't a 20-byte
// hex address. Mirrors evmAccountForm in the API's explorerService.
export function evmAccountForm(h160: unknown): string | null {
  if (typeof h160 !== 'string') return null
  const h = h160.toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(h)) return null
  return `0x45544800${h}0000000000000000`
}
