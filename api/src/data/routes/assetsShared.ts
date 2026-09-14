import { z } from 'zod'
import { zAccountRef, zAssetId, zIsoTimestamp } from '../schemas/common.ts'
import { zTransfer } from './transfersShared.ts'

// The item shapes of the asset-first feeds, declared once beside the transfer
// object they derive from rather than inline in the route's `response:`.

// The same transfer row the account feed serves, without the two fields only an
// account gives it: `direction` (a side needs an account to be a side of) and
// `assetId` (the asset is the route here).
export const zAssetTransfer = zTransfer.omit({ direction: true, assetId: true })

export const zAssetSwap = z.object({
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  extrinsicIndex: z.number().int().nullable(),
  extrinsicHash: z.string().nullable().describe('Hash of the carrying extrinsic; null for a block-hook row.'),
  timestamp: zIsoTimestamp,
  eventName: z.string(),
  who: zAccountRef.nullable(),
  assetIn: zAssetId,
  assetOut: zAssetId,
  amountIn: z.string(),
  amountOut: z.string(),
})
