import { z } from 'zod'
import { zAccountRef, zIsoTimestamp } from '../schemas/common.ts'
import { STAKING_EVENT_NAMES } from '../services/stakingFeed.ts'

// One staking event, the same object on the global feed and under an account.
export const zStakingEvent = z.object({
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  extrinsicIndex: z.number().int().nullable(),
  extrinsicHash: z.string().nullable().describe('Hash of the carrying extrinsic; null for a block-hook row (reward payouts land in hooks).'),
  timestamp: zIsoTimestamp,
  eventName: z.string().describe(`One of: ${STAKING_EVENT_NAMES.join(', ')}.`),
  who: zAccountRef.nullable().describe('The staker/collator the event names, when it names one.'),
  args: z.unknown().describe('The decoded event arguments — amounts are raw integer strings inside.'),
})
