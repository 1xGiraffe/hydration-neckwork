import { SubstrateBatchProcessor } from '@subsquid/substrate-processor'
import { config } from './config.js'
import { UNISWAP_V3_POOL_TOPIC0S } from './price/uniswapV3.js'

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
      // Not swaps themselves: they name an OTC fill's TAKER, which is the only
      // thing that puts the fill's two accounts on their true sides
      // (src/blocks/otcCounterparty.ts). The extractor reads whichever of these
      // sits immediately before the Broadcast fill, so they have to be in the
      // block's events — without the subscription the rule silently books every
      // fill the old way, which is how it shipped once already.
      'OTC.Filled',
      'OTC.PartiallyFilled',
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

  // Concentrated-liquidity (Uniswap v3) pools live on the EVM and speak only
  // through logs: PoolCreated announces a pool, Initialize/Swap/Mint/Burn move
  // its price and in-range liquidity, and a direct-EVM Swap is volume no
  // Broadcast event reports (src/price/uniswapV3.ts). Selected by topic0, not
  // as the whole `EVM.Log` stream: measured on 2026-09-08, every EVM.Log was
  // 95,905 events/day against 58,074 for everything else this processor asks
  // for, and two of them were pool logs. The five signatures are exact — the
  // aToken Mint/Burn share the names, not the hashes.
  .addEvmLog({
    topic0: [...UNISWAP_V3_POOL_TOPIC0S],
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
      // A router-routed v3 hop emits both the pool's Swap log and a
      // Broadcast.Swapped3 in the same extrinsic; the extrinsic index is what
      // keeps the volume extractor from booking that swap twice.
      extrinsicIndex: true,
    },
  })
