import { Buffer } from 'node:buffer'

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

export function toClickHouseDateTime(timestamp?: number): string {
  return new Date(timestamp ?? 0)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '')
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
