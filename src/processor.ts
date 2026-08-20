import { SubstrateBatchProcessor } from '@subsquid/substrate-processor'
import { config } from './config.js'

export const processor = new SubstrateBatchProcessor()
  .setGateway({
    url: config.SQD_GATEWAY,
    apiKey: config.SQD_GATEWAY_API_KEY,
  })
  .setRpcEndpoint({
    url: config.RPC_URL,
    rateLimit: config.RPC_RATE_LIMIT,
    capacity: config.RPC_CAPACITY,
  })
  .setRpcDataIngestionSettings({ headPollInterval: config.RPC_HEAD_POLL_MS })

  // Start from genesis (will be overridden by checkpoint in production)
  .setBlockRange({ from: 0 })

  // Subscribe to pool composition change events and swap events
  // Pool composition events trigger cache invalidation in the pool composition cache
  // Swap events are used for volume extraction
  .addEvent({
    name: [
      'Omnipool.TokenAdded',
      'Omnipool.TokenRemoved',
      'XYK.PoolCreated',
      'XYK.PoolDestroyed',
      'Stableswap.PoolCreated',
      'Stableswap.AmplificationChanging',
      'Stableswap.FeeUpdated',
      'Stableswap.LiquidityAdded',
      'Tokens.Transfer',
      'Omnipool.SellExecuted',
      'Omnipool.BuyExecuted',
      'XYK.SellExecuted',
      'XYK.BuyExecuted',
      'Stableswap.SellExecuted',
      'Stableswap.BuyExecuted',
      'Broadcast.Swapped',
      'Broadcast.Swapped2',
      'Broadcast.Swapped3',
      // Asset-registry changes (a rename, a new registration, a location fix)
      // must reach the live block's event list: the indexer forces a registry
      // re-scan when it SEES one of these, and without the subscription the
      // live path never sees them — a TC-dispatched rename then waits for the
      // periodic scan instead of landing at its own block.
      'AssetRegistry.Registered',
      'AssetRegistry.Updated',
      'AssetRegistry.MetadataSet',
      'AssetRegistry.LocationSet',
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
