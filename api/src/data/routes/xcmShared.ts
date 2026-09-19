import { z } from 'zod'
import { zAccountRef, zAssetId, zIsoTimestamp } from '../schemas/common.ts'

// One cross-chain flow row, declared once for the global feed
// (/v1/xcm/transfers) and the per-account arm (/v1/accounts/{address}/xcm).
//
// The two differ in exactly two ways, stated here so they cannot drift again:
//
//  * DIRECTION vocabulary. The global feed serves ONLY the two explicit name
//    sets (services/xcmFeed.ts), so every row it publishes is `in` or `out`.
//    The account arm serves every row of the account's XCM projection —
//    barrier/queue rows included, which name no side — so it carries a third
//    value, `other`. Both enums are already on the wire and stay as they are;
//    this is a deliberate difference, not drift.
//  * `who`. The global feed names the local account a row belongs to. Under an
//    account the account IS the route, so the field would restate the path.
const XCM_ROW = {
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  extrinsicIndex: z.number().int().nullable().describe('The sending extrinsic on `out`; null on `in` (arrivals land in block hooks).'),
  extrinsicHash: z.string().nullable().describe('Hash of the carrying extrinsic; null for a block-hook row.'),
  timestamp: zIsoTimestamp,
  eventName: z.string(),
}

const AMOUNT = z.string().nullable().describe('Raw integer amount of `assetId`; null when the event carries none.')

export const zXcmTransfer = z.object({
  ...XCM_ROW,
  direction: z.enum(['in', 'out']),
  who: zAccountRef.nullable().describe('The local account the flow names: the sender on `out`, the beneficiary on `in`.'),
  assetId: zAssetId,
  amount: AMOUNT,
})
