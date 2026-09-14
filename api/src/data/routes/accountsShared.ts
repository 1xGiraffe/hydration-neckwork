import { z } from 'zod'
import { badRequest, zAddressParam } from '../schemas/common.ts'
import { ADDRESS_FORMATS_HINT, parseAddress, type ParsedAddress } from '../services/address.ts'

// Request-parsing helpers shared by the account route domains. The window
// quartet itself is not account-specific and lives in schemas/common.ts
// (`zWindowQuartet` / `zWindowedFeedQuery`).

export const zAccountParams = z.object({ address: zAddressParam })

// The window quartet as an in-memory filter, for feeds that read a bounded
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

// A required address parameter: the 400 names which one could not be parsed.
export function requireParsedAddress(address: string, label = 'address'): ParsedAddress {
  const parsed = parseAddress(address)
  if (!parsed) throw badRequest(`unparseable ${label}; ${ADDRESS_FORMATS_HINT}`)
  return parsed
}

// An OPTIONAL address filter: absent stays absent, present-but-unparseable is a
// 400 rather than a silently unfiltered feed.
export function optionalAddress(raw: string | undefined, label: string): ParsedAddress | null {
  if (!raw) return null
  return requireParsedAddress(raw, label)
}

export const UNSEEN_IS_EMPTY = 'A valid address the index has never seen answers 200 with empty items (404 is reserved for single resources).'
