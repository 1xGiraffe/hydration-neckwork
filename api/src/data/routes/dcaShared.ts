import { z } from 'zod'
import { zAccountRef, zAssetId, zIsoTimestamp } from '../schemas/common.ts'

// The DCA schedule wire shapes, declared once so /v1/dca/schedules and the
// account's /dca fold publish the identical object for the same schedule.

export const PRE_ROUTER_NOTE = 'Pre-router schedules (2,354 of them; created before DCA.Scheduled carried the order) have NO recorded pair or terms: those fields are null, never a fabricated HDX→HDX (asset id 0 is HDX, so publishing the stored zeros would assert a pair the schedule never named).'

export const zSchedule = z.object({
  scheduleId: z.number().int(),
  owner: zAccountRef,
  assetIn: zAssetId.nullable(),
  assetOut: zAssetId.nullable(),
  direction: z.enum(['sell', 'buy']).nullable(),
  amountPer: z.string().nullable().describe('The per-execution trade size (amountIn of a sell, amountOut of a buy), raw integer.'),
  totalAmount: z.string().nullable().describe("The schedule's budget; '0' is a genuine rolling budget on a router-era schedule."),
  periodBlocks: z.number().int().nullable(),
  maxRetries: z.number().int(),
  createdAt: zIsoTimestamp,
  createdAtBlock: z.number().int(),
})

export const zScheduleDetail = zSchedule.extend({
  executedAmountIn: z.string().describe('Exact integer sum of amountIn over every executed trade.'),
  executedAmountOut: z.string(),
  executionCount: z.number().int(),
  failureCount: z.number().int(),
  completed: z.boolean(),
  terminated: z.boolean(),
  lastEventAt: zIsoTimestamp.nullable(),
})

export const zExecution = z.object({
  status: z.enum(['executed', 'failed', 'planned', 'completed', 'terminated']),
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  timestamp: zIsoTimestamp,
  amountIn: z.string().nullable().describe('Traded amounts on `executed` rows; null on every other row — a failed attempt traded nothing.'),
  amountOut: z.string().nullable(),
  error: z.string().nullable().describe('The raw DispatchError JSON of a `failed` attempt.'),
})
