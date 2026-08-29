import { z } from 'zod'
import { badRequest, zAddressParam, zBlock, zCursor, zLimit, zOrder, zTimeParam } from '../schemas/common.ts'
import { ADDRESS_FORMATS_HINT, parseAddress, type ParsedAddress } from '../services/address.ts'

// Request-parsing helpers shared by the account route domains.

export const zAccountParams = z.object({ address: zAddressParam })

// The uniform window quartet every deep feed takes (the same bounds the chain
// feeds accept): either kind, either end alone, composable with the cursor —
// the cursor then walks only the window. An inverted window is simply empty.
export const zWindowQuartet = {
  fromBlock: zBlock.optional().describe('Lower block bound, inclusive.'),
  toBlock: zBlock.optional().describe('Upper block bound, inclusive.'),
  fromTime: zTimeParam.optional().describe('Lower time bound, inclusive (ISO-8601).'),
  toTime: zTimeParam.optional().describe('Upper time bound, inclusive (ISO-8601).'),
}

export const zAccountFeedQuery = z.object({ limit: zLimit, cursor: zCursor, order: zOrder, ...zWindowQuartet })

// The same quartet as an in-memory filter, for feeds that read a bounded
// entity whole (a schedule's executions, a voter's or referendum's votes) and
// page in TS. Time bounds compare the item's own block timestamp.
export function inWindow(
  item: { blockHeight: number; timestamp: string },
  w: { fromBlock?: number; toBlock?: number; fromTime?: number; toTime?: number },
): boolean {
  if (w.fromBlock != null && item.blockHeight < w.fromBlock) return false
  if (w.toBlock != null && item.blockHeight > w.toBlock) return false
  if (w.fromTime != null || w.toTime != null) {
    const t = Math.floor(Date.parse(item.timestamp) / 1000)
    if (w.fromTime != null && t < w.fromTime) return false
    if (w.toTime != null && t > w.toTime) return false
  }
  return true
}

// Window part of a feed's cache key: two windows must never share an entry.
export function windowKey(w: { fromBlock?: number; toBlock?: number; fromTime?: number; toTime?: number }): string {
  return `${w.fromBlock ?? ''}~${w.toBlock ?? ''}~${w.fromTime ?? ''}~${w.toTime ?? ''}`
}

export function requireParsedAddress(address: string): ParsedAddress {
  const parsed = parseAddress(address)
  if (!parsed) throw badRequest(`unparseable address; ${ADDRESS_FORMATS_HINT}`)
  return parsed
}

export const UNSEEN_IS_EMPTY = 'A valid address the index has never seen answers 200 with empty items (404 is reserved for single resources).'
