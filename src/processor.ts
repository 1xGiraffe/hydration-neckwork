import { SubstrateBatchProcessor } from '@subsquid/substrate-processor'
import { config } from './config.js'

export const processor = new SubstrateBatchProcessor()
  .setGateway(config.SQD_GATEWAY)
  .setRpcEndpoint({
    url: config.RPC_URL,
    rateLimit: config.RPC_RATE_LIMIT,
    capacity: 10,
  })

  // Start from genesis (will be overridden by checkpoint in production)
  .setBlockRange({ from: 0 })

  // Subscribe to pool composition change events
  // These events trigger cache invalidation in the pool composition cache
  .addEvent({
    name: [
      'Omnipool.TokenAdded',
      'Omnipool.TokenRemoved',
      'XYK.PoolCreated',
      'XYK.PoolDestroyed',
      'Stableswap.PoolCreated',
      'Stableswap.LiquidityAdded',
      'Tokens.Transfer',
    ],
  })

  // Subscribe to System.set_storage calls
  // These are sudo/governance calls that directly write storage, bypassing events.
  // SQD's addCall automatically unwraps calls nested inside utility.batch,
  // proxy.proxy, scheduler, democracy, etc -- so this single subscription
  // catches set_storage regardless of how it was dispatched.
  .addCall({
    name: ['System.set_storage'],
  })

  // Include all blocks - we need every block for accurate price snapshots
  .includeAllBlocks()

  // Request block timestamp and event data
  .setFields({
    block: {
      timestamp: true,
    },
    event: {
      args: true,
      name: true,
    },
  })
