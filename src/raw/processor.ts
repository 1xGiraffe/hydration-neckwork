import type {
  Block,
  Call,
  Event,
  Extrinsic,
  SubstrateBatchProcessorFields,
} from '@subsquid/substrate-processor'
import { SubstrateBatchProcessor } from '@subsquid/substrate-processor'
import { config } from '../config.js'

export const rawProcessor = new SubstrateBatchProcessor()
  .setGateway(config.SQD_GATEWAY)
  .setRpcEndpoint({
    url: config.RPC_URL,
    rateLimit: config.RPC_RATE_LIMIT,
    capacity: 20,
  })
  .setBlockRange({ from: 0 })
  .addEvent({
    extrinsic: true,
    call: true,
    stack: true,
  })
  .addCall({
    extrinsic: true,
    events: true,
    stack: true,
  })
  .includeAllBlocks()
  .setFields({
    block: {
      timestamp: true,
      stateRoot: true,
      extrinsicsRoot: true,
      validator: true,
    },
    extrinsic: {
      hash: true,
      version: true,
      signature: true,
      fee: true,
      tip: true,
      error: true,
      success: true,
    },
    call: {
      name: true,
      args: true,
      origin: true,
      success: true,
      error: true,
    },
    event: {
      name: true,
      args: true,
      phase: true,
    },
  })

export type RawProcessorFields = SubstrateBatchProcessorFields<typeof rawProcessor>
export type RawBlock = Block<RawProcessorFields>
export type RawExtrinsic = Extrinsic<RawProcessorFields>
export type RawCall = Call<RawProcessorFields>
export type RawEvent = Event<RawProcessorFields>
