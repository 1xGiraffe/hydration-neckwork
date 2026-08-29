import { z } from 'zod'
import { zAccountRef, zAssetId, zIsoTimestamp } from '../schemas/common.ts'

// The venue names as pool_swap_legs stores them (lowercased fillerType kinds),
// and the swap-fill wire shape shared by /v1/trades and
// /v1/pools/{venue}/{poolKey}/trades.

export const VENUES = ['omnipool', 'stableswap', 'xyk', 'aave', 'otc', 'hsm', 'lbp'] as const
export type Venue = (typeof VENUES)[number]
export const zVenue = z.enum(VENUES)

export const zFillLeg = z.object({
  assetId: zAssetId,
  amount: z.string().describe('Raw integer units of assetId.'),
})

export const zFillFeeLeg = zFillLeg.extend({
  feeDest: z.string().nullable().describe("'burned' or 'account' where the chain reported it; null on legacy legs where the destination is genuinely unknowable."),
  feeRecipient: zAccountRef.nullable().describe('The account credited, where the event named one.'),
})

export const zSwapFill = z.object({
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  timestamp: zIsoTimestamp,
  venue: z.string(),
  poolKey: z.string().nullable().describe("The venue's own pool key: 'omnipool', a stableswap pool id, an XYK/AAVE account, an OTC order id; null where the venue recorded none (LBP)."),
  swapper: zAccountRef.nullable().describe('The account the swap was made FOR; null when the chain reported a placeholder (an XCM-originated swap with no local origin).'),
  inputs: z.array(zFillLeg),
  outputs: z.array(zFillLeg),
  fees: z.array(zFillFeeLeg).describe('Fee legs RESTATE value the in/out legs already carry — a revenue breakdown, never additional flow.'),
  opKey: z.string().nullable().describe('The Router operation id grouping a multi-hop route\'s fills; null for a direct pallet swap, a block-hook fill, or any legacy-era fill.'),
  extrinsicIndex: z.number().int().nullable(),
  extrinsicHash: z.string().nullable().describe('Hash of the carrying extrinsic; null for a block-hook row.'),
})
