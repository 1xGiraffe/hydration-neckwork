import { z } from 'zod'
import { zAccountRef, zIsoTimestamp } from '../schemas/common.ts'

// One OTC order event, the same object in an order's history and in an
// account's fill list.
export const zOtcEvent = z.object({
  type: z.enum(['placed', 'filled', 'partiallyFilled', 'cancelled']),
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  timestamp: zIsoTimestamp,
  amountIn: z.string().nullable().describe('The order size on `placed`; the fill size on the two fill events; null on `cancelled`.'),
  amountOut: z.string().nullable(),
  filler: zAccountRef.nullable().describe('The filling account — carried only by the two fill events.'),
})
