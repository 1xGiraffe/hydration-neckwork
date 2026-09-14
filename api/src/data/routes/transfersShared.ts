import { z } from 'zod'
import { zAccountRef, zAssetId, zIsoTimestamp } from '../schemas/common.ts'

// One transfer is one wire shape wherever it is reached. The account feed adds
// the two fields only an account gives a transfer — the `direction` it took and
// the `assetId`, since that feed spans every asset — and the asset feed drops
// both (the asset IS the route, and a transfer has no side without an account
// to take it from). The asset form is `zAssetTransfer` in assetsShared.ts.
export const zTransfer = z.object({
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  extrinsicIndex: z.number().int().nullable(),
  extrinsicHash: z.string().nullable().describe('Hash of the carrying extrinsic; null for a block-hook row.'),
  timestamp: zIsoTimestamp,
  eventName: z.string(),
  direction: z.enum(['in', 'out', 'self']),
  from: zAccountRef.nullable(),
  to: zAccountRef.nullable(),
  assetId: zAssetId,
  amount: z.string(),
  valueUsd: z.string().nullable().describe('EVENT-TIME USD (the last closed hourly candle before the transfer, ≤30 days stale); null when the asset had no usable price then.'),
})
