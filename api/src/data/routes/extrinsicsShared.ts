import { z } from 'zod'
import { zAccountRef, zIsoTimestamp } from '../schemas/common.ts'

// The extrinsic/event item shapes shared by the chain-core routes (the global
// feeds, the per-block lists, the per-extrinsic event list), declared once so
// the OpenAPI document shows one shape everywhere.

export const zExtrinsicItem = z.object({
  blockHeight: z.number().int(),
  extrinsicIndex: z.number().int(),
  hash: z.string(),
  timestamp: zIsoTimestamp,
  callName: z.string().describe('`Pallet.call` of the outermost call.'),
  signer: zAccountRef.nullable().describe('The signatory (the effective signer for an EVM-originated extrinsic); null for an unsigned/inherent extrinsic.'),
  success: z.boolean(),
  fee: z.string().nullable().describe('Fee actually paid in planck, tip included; null for unsigned extrinsics.'),
  tip: z.string().nullable(),
})

export const zDispatchError = z.object({
  kind: z.string().describe('The DispatchError variant: Module, Token, Arithmetic, BadOrigin, Other, …'),
  module: z.string().nullable().describe('Pallet name of a Module error, from the runtime metadata active at that block.'),
  name: z.string().nullable().describe('Error name inside the pallet.'),
  docs: z.string().nullable(),
  raw: z.string().describe('The undecoded DispatchError JSON, always present.'),
})

export const zExtrinsicDetail = zExtrinsicItem.extend({
  args: z.unknown().describe('The decoded call arguments of the outermost call.'),
  error: zDispatchError.nullable().describe('The dispatch error of a failed extrinsic; null when `success` is true.'),
})

export const zEventItem = z.object({
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  extrinsicIndex: z.number().int().nullable().describe('The extrinsic that emitted the event; null for a block-hook (initialization/finalization) event.'),
  extrinsicHash: z.string().nullable().describe('Hash of the carrying extrinsic; null for a block-hook row.'),
  eventName: z.string().describe('`Pallet.Event`.'),
  timestamp: zIsoTimestamp,
  args: z.unknown().describe('The decoded event arguments.'),
})
