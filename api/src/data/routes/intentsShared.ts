import { z } from 'zod'
import { zAccountRef, zAssetId, zIsoTimestamp } from '../schemas/common.ts'

// The ICE intent wire shapes, declared once so /v1/intents and an account's
// /v1/accounts/{address}/intents publish the identical object for the same order.

export const INTENT_NOTE = [
  'An ICE intent is a resting order: the owner\'s `assetIn` goes under a named reserve at submission and a solver\'s ICE.submit_solution fills it. A **swap** intent is the product\'s **limit order**; a **dca** intent is runtime 443\'s DCA (`budget`, `periodBlocks`, and a trade per period).',
  'Ids are u128 and travel as DECIMAL STRINGS on this surface. `seq` is the id\'s low 64 bits — the short "#n" handle the explorer shows — and is a display value only, never a key.',
].join('\n\n')

export const INTENT_STATUS_NOTE = 'Status folds from the order\'s own events at read time, never stored. A PARTIAL resolution does not end an order: pallet_ice leaves the remainder resting and keeps filling it, so `partially_filled` is a LIVE state and an order pulled after two partials is `cancelled`, with its progress in `filledAmountIn`/`filledAmountOut`. A dca intent reports `completed` once the trade that spent its last budget emitted Intent.DcaCompleted, and `open` until then.'

export const zIntentKind = z.enum(['swap', 'dca'])
export const zIntentStatus = z.enum(['open', 'filled', 'partially_filled', 'cancelled', 'expired', 'completed'])

export const zIntent = z.object({
  intentId: z.string().describe('The u128 intent id as a decimal string — the identity everywhere.'),
  seq: z.number().int().describe('Low 64 bits of the id, the short "#n" display handle. Exact below 2^53 only.'),
  owner: zAccountRef,
  kind: zIntentKind,
  assetIn: zAssetId,
  assetOut: zAssetId,
  amountIn: z.string().describe('The whole order on a swap intent; one period\'s trade on a dca intent. Raw integer.'),
  amountOut: z.string().describe('The minimum the order accepts for `amountIn`, raw integer.'),
  partial: z.boolean().describe('Whether a swap intent accepts partial fills; an all-or-nothing order is false.'),
  partialMin: z.string().nullable().describe('Smallest partial fill the order accepts, when it set one.'),
  slippagePpm: z.number().int(),
  budget: z.string().nullable().describe('A dca intent\'s total budget. Null on a swap intent, and null on a dca intent that set none — the pallet\'s rolling re-reserve, which keeps spending whatever the owner holds. Never 0 standing in for "unset".'),
  periodBlocks: z.number().int().nullable().describe('Blocks between a dca intent\'s trades; null on a swap intent.'),
  deadline: zIsoTimestamp.nullable().describe('Expiry, when the placement carried one.'),
  forwardContract: z.string().nullable().describe('Contract a LazyExecutor callback forwards the output to on resolution, if any.'),
  createdAt: zIsoTimestamp,
  createdAtBlock: z.number().int(),
  createdAtEventIndex: z.number().int(),
})

export const zIntentDetail = zIntent.extend({
  status: zIntentStatus,
  filledAmountIn: z.string().describe('Exact integer sum of amountIn over every fill.'),
  filledAmountOut: z.string(),
  fillCount: z.number().int(),
  remainingBudget: z.string().nullable().describe('A dca intent\'s budget after its newest trade, as the pallet reported it; "0" once completed. Null on a swap intent.'),
  lastEventAt: zIsoTimestamp.nullable(),
  lastEventBlock: z.number().int().nullable(),
})

export const zIntentEvent = z.object({
  kind: z.enum(['submitted', 'resolved', 'partially_resolved', 'dca_trade', 'dca_completed', 'cancelled', 'expired', 'callback_failed']),
  eventName: z.string().describe('The runtime event. `Intent.IntentResovedPartially` is spelled that way on chain (sic).'),
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  extrinsicIndex: z.number().int().nullable().describe('Fills happen inside the UNSIGNED ICE.submit_solution, so a fill names an extrinsic but never a signer.'),
  timestamp: zIsoTimestamp,
  amountIn: z.string().nullable().describe('Traded amounts on fill rows. A submission, cancellation or expiry traded nothing, so both are null — and Intent.DcaCompleted carries none either, the amounts of that final trade living in the solution\'s settlement transfers.'),
  amountOut: z.string().nullable(),
  remainingBudget: z.string().nullable().describe('Budget left after a dca trade; "0" on the completion, which by definition spent the rest.'),
})
