import Fastify from 'fastify'
import cors from '@fastify/cors'
import compress from '@fastify/compress'
import { config } from './config.ts'
import { createClickHouseClient, createLongOpClickHouseClient } from './db/client.ts'
import { accountTradeVolumeCovered, backfillAccountTradeVolume, refreshRecentAccountTradeVolume, setAccountTradeVolumeReady } from './services/accountTradeVolume.ts'
import {
  drainAccountSwapActivityQueue,
  seedAccountSwapActivityQueue,
  startAccountSwapActivityQueueDrain,
  stopAccountSwapActivityQueueDrain,
} from './db/accountSwapQueue.ts'
import {
  ensureSchemaMigrations,
  accountActivityBackfillComplete,
  backfillAccountActivity,
  accountTransferActivityBackfillComplete,
  backfillAccountTransferActivity,
  transferActivityBackfillComplete,
  backfillTransferActivity,
  transferActivityByTimeBackfillComplete,
  backfillTransferActivityByTime,
  swapActivityBackfillComplete,
  backfillSwapActivity,
  otcActivityBackfillComplete,
  backfillOtcActivity,
  liquidityActivityBackfillComplete,
  backfillLiquidityActivity,
  xcmEventActivityBackfillComplete,
  backfillXcmEventActivity,
  stakingActivityBackfillComplete,
  backfillStakingActivity,
  voteActivityBackfillComplete,
  backfillVoteActivity,
  hsmActivityBackfillComplete,
  backfillHsmActivity,
  activityDailyBackfillComplete,
  backfillActivityDaily,
  dailyChainIdentityCountsBackfillComplete,
  backfillDailyChainIdentityCounts,
  dropLegacyDailyChainIdentityCounts,
  rewardClaimActivityBackfillComplete,
  backfillRewardClaimActivity,
  incentiveClaimCallsBackfillComplete,
  backfillIncentiveClaimCalls,
  erc20TransferDeltasBackfillComplete,
  backfillErc20TransferDeltas,
  assetSwapActivityBackfillComplete,
  backfillAssetSwapActivity,
  accountSwapActivityBackfillComplete,
  backfillAccountSwapActivity,
  accountMoneyMarketActivityBackfillComplete,
  backfillAccountMoneyMarketActivity,
  atokenScaledDeltasBackfillComplete,
  backfillAtokenScaledDeltas,
  atokenScaledDeltasByContractBackfillComplete,
  backfillAtokenScaledDeltasByContract,
  moneyMarketReserveIndicesBackfillComplete,
  backfillMoneyMarketReserveIndices,
  accountBalanceWeeklyBackfillComplete,
  backfillAccountBalanceWeekly,
  accountBalanceHistoryBackfillComplete,
  backfillAccountBalanceHistory,
  accountBalanceHourlyBackfillComplete,
  backfillAccountBalanceHourly,
  dropLegacyAccountBalanceDaily,
  hdxHolderLifetimeBackfillComplete,
  backfillHdxHolderLifetime,
  dropLegacyActivityDailyAggregate,
  accountActivityValuesBackfillComplete,
  backfillAccountActivityValues,
  omnipoolPositionCreatedBackfillComplete,
  backfillOmnipoolPositionCreated,
  backfillOmnipoolPositionStateEvents,
  omnipoolPositionStateEventsBackfillComplete,
  backfillOmnipoolPoolStateHistory,
  omnipoolPoolStateHistoryBackfillComplete,
  omnipoolOwnerIntervalsCoverageComplete,
  backfillXykPoolRegistry,
  xykPoolRegistryBackfillComplete,
  backfillXykPoolReserveHistory,
  xykPoolReserveHistoryBackfillComplete,
  xykTotalSharesCoverageComplete,
  xykFarmIntervalsCoverageComplete,
  multisigActivityBackfillComplete,
  backfillMultisigActivity,
} from './db/migrations.ts'
import { loadAssets, stopAssetsRefresh } from './services/assetsService.ts'
import { candlesRoutes } from './routes/candles.ts'
import { assetsRoutes } from './routes/assets.ts'
import { marketStatsRoutes } from './routes/market-stats.ts'
import { indexerRoutes } from './routes/indexer.ts'
import { explorerRoutes } from './routes/explorer.ts'
import { tagRoutes } from './routes/tags.ts'
import { loadExplorerAssets, stopExplorerAssetsRefresh } from './services/explorerAssets.ts'
import {
  initExplorerService,
  loadAccountSuffixIndex,
  startAccountSuffixRefresh,
  loadEvmBindings,
  startEvmBindingsRefresh,
  setAccountActivityReady,
  setAccountTransferActivityReady,
  setTransferActivityReady,
  setTransferActivityByTimeReady,
  setSwapActivityReady,
  setOtcActivityReady,
  setLiquidityActivityReady,
  setXcmEventActivityReady,
  setStakingActivityReady,
  setVoteActivityReady,
  setActivityDailyReady,
  setDailyChainIdentityCountsReady,
  setRewardClaimActivityReady,
  setErc20TransferDeltasReady,
  setAssetSwapActivityReady,
  setAccountSwapActivityReady,
  setAccountMoneyMarketActivityReady,
  setAtokenScaledDeltasReady,
  setAtokenScaledDeltasByContractReady,
  setMoneyMarketReserveIndicesReady,
  setAccountActivityValuesReady,
  setAccountBalanceWeeklyReady,
  setAccountBalanceHistoryReady,
  setAccountBalanceHourlyReady,
  setOmnipoolPositionCreatedReady,
  setOmnipoolHistoryReady,
  setXykHistoryReady,
  setOmnipoolAccountClaimsReady,
  omnipoolAccountClaimsSnapshotReady,
  refreshOmnipoolAccountClaims,
  startOmnipoolAccountClaimsRefresh,
  setMoneyMarketAccountValuesReady,
  moneyMarketAccountValueSnapshotReady,
  refreshMoneyMarketAccountValues,
  startMoneyMarketAccountValuesRefresh,
  startAccountsPrewarm,
  startTagCountsPrewarm,
  stopExplorerBackgroundTasks,
} from './services/explorerService.ts'
import { initTagService, loadTags, seedDefaultTags, syncMoneyMarketTag, startMoneyMarketTagRefresh, syncStructuralTags, startStructuralTagRefresh } from './services/tagService.ts'
import { initIdentityService, loadIdentities, startIdentityRefresh, stopIdentityRefresh } from './services/identityService.ts'
import { initProxyMultisigService, setMultisigActivityReady, stopProxyMultisigService } from './services/proxyMultisigService.ts'
import { initHdxService, setHdxHolderLifetimeReady, stopHdxService } from './services/hdxService.ts'
import { initHollarService, setHsmActivityReady } from './services/hollarService.ts'
import { initErc20WalletService, setErc20WalletTransferDeltasReady, stopErc20WalletService } from './services/erc20WalletService.ts'
import { initAccountAffinityService } from './services/accountAffinityService.ts'
import { ensureSnakewatchEmojiSourceLoaded } from './services/omniwatchIdentity.ts'
import { initXcmJourneyService } from './services/xcmJourneyService.ts'

const fastify = Fastify({ logger: true })

const client = createClickHouseClient()

// All routes are anonymous reads. A fixed wildcard avoids reflecting arbitrary
// origins (and the resulting Vary: Origin fragmentation in shared caches).
await fastify.register(cors, { origin: '*' })
// JSON payloads (history series, activities, holders) shrink ~10× under gzip —
// directly cuts transfer time for every concurrent client.
await fastify.register(compress, { global: true, encodings: ['br', 'gzip', 'deflate'] })

// Public, short-lived HTTP caching aligned with each endpoint's internal
// single-flight TTL, so browsers (and any fronting proxy/CDN) can reuse
// responses instead of re-hitting the API. Longest-prefix match wins.
const CACHE_CONTROL: [RegExp, number][] = [
  [/^\/assets$/, 300],
  [/^\/candles/, 5],
  [/^\/explorer\/hdx/, 300],
  [/^\/explorer\/hollar/, 300],
  [/^\/explorer\/address\/[^/]+\/close-accounts/, 900],
  [/^\/explorer\/address\/[^/]+\/history/, 120],
  [/^\/explorer\/(address|tag)\/[^/]+\/counts/, 600],
  [/^\/explorer\/(daily|accounts-daily)/, 300],
  [/^\/explorer\/(address|tag)\//, 8],
  [/^\/explorer\/search/, 10],
  // `assets` (no trailing slash) is the asset directory — 30s in-process TTL, so
  // let clients reuse it just as long. Without this it fell through to the 2s
  // catch-all and browsers re-fetched the biggest list payload constantly.
  [/^\/explorer\/assets/, 30],
  [/^\/explorer\/(holders|asset)\//, 15],
  // Directory ranking is SWR-cached with a 60s freshness window server-side;
  // matching client reuse cuts request volume without adding staleness.
  // (accounts-daily is matched by its earlier rule.)
  [/^\/explorer\/accounts/, 30],
  [/^\/explorer\//, 5],
]
fastify.addHook('onSend', async (req, reply) => {
  if (req.method !== 'GET' || reply.statusCode !== 200 || reply.getHeader('cache-control')) return
  const path = req.url.split('?')[0]
  const rule = CACHE_CONTROL.find(([re]) => re.test(path))
  if (rule) reply.header('cache-control', `public, max-age=${rule[1]}`)
})

fastify.get('/health', async () => {
  return { status: 'ok' }
})

// Drain in-flight requests and close the ClickHouse keep-alive pool when Docker
// replaces the API container. This prevents half-open requests during deploys.
fastify.addHook('onClose', async () => {
  stopAssetsRefresh()
  stopExplorerAssetsRefresh()
  stopIdentityRefresh()
  stopProxyMultisigService()
  stopHdxService()
  stopErc20WalletService()
  stopAccountSwapActivityQueueDrain()
  stopExplorerBackgroundTasks()
  await client.close()
})

await fastify.register(assetsRoutes)
await fastify.register(candlesRoutes, { client })
await fastify.register(marketStatsRoutes, { client })
await fastify.register(indexerRoutes, { client })
await fastify.register(explorerRoutes)
await fastify.register(tagRoutes)

// Recompute the newest account_trade_volume partitions on a timer (the netting
// has no MV). Uses its own long-op client per run so a slow rebuild never holds
// a connection between ticks.
function startAccountTradeVolumeRefresh(): void {
  const run = async () => {
    const refreshClient = createLongOpClickHouseClient()
    try {
      await refreshRecentAccountTradeVolume(refreshClient, 2)
    } catch (err) {
      console.error('[API] account_trade_volume refresh failed', err)
    } finally {
      await refreshClient.close().catch(() => {})
    }
  }
  void run() // catch up trades since the last backfill immediately, then on a timer
  const timer = setInterval(() => { void run() }, 10 * 60_000)
  timer.unref()
}

async function start() {
  try {
    // Schema upgrades can include bounded historical INSERT…SELECT work. Keep
    // them off the public request client, whose 20s timeout and 4 GB cap are
    // intentionally tuned for HTTP queries rather than maintenance.
    const migrationClient = createLongOpClickHouseClient()
    try {
      await ensureSchemaMigrations(migrationClient)
      await seedAccountSwapActivityQueue(migrationClient)
      await drainAccountSwapActivityQueue(migrationClient, { maxBatches: 100 })
    } finally {
      await migrationClient.close()
    }
    await loadAssets(client)
    initExplorerService(client)
    // Existing deployments usually already have complete read models. Enable
    // those gates before services with eager refreshes start, otherwise a
    // restart briefly falls back to the same raw-history scans the models were
    // built to eliminate. Incomplete new models remain off until the bounded
    // background sequence below writes every partition marker.
    const ready = await Promise.all([
      accountActivityBackfillComplete(client),
      accountTransferActivityBackfillComplete(client),
      transferActivityBackfillComplete(client),
      transferActivityByTimeBackfillComplete(client),
      swapActivityBackfillComplete(client),
      assetSwapActivityBackfillComplete(client),
      otcActivityBackfillComplete(client),
      accountSwapActivityBackfillComplete(client),
      liquidityActivityBackfillComplete(client),
      accountMoneyMarketActivityBackfillComplete(client),
      xcmEventActivityBackfillComplete(client),
      stakingActivityBackfillComplete(client),
      atokenScaledDeltasBackfillComplete(client),
      activityDailyBackfillComplete(client),
      accountBalanceWeeklyBackfillComplete(client),
      accountBalanceHistoryBackfillComplete(client),
      accountActivityValuesBackfillComplete(client),
      Promise.all([rewardClaimActivityBackfillComplete(client), incentiveClaimCallsBackfillComplete(client)]).then(parts => parts.every(Boolean)),
      omnipoolPositionCreatedBackfillComplete(client),
      erc20TransferDeltasBackfillComplete(client),
      hdxHolderLifetimeBackfillComplete(client),
      hsmActivityBackfillComplete(client),
      dailyChainIdentityCountsBackfillComplete(client),
      accountBalanceHourlyBackfillComplete(client),
      multisigActivityBackfillComplete(client),
      voteActivityBackfillComplete(client),
      moneyMarketReserveIndicesBackfillComplete(client),
      atokenScaledDeltasByContractBackfillComplete(client),
      omnipoolAccountClaimsSnapshotReady(),
      moneyMarketAccountValueSnapshotReady(),
    ]).catch(() => [] as boolean[])
    const setters = [
      setAccountActivityReady, setAccountTransferActivityReady, setTransferActivityReady,
      setTransferActivityByTimeReady, setSwapActivityReady, setAssetSwapActivityReady,
      setOtcActivityReady, setAccountSwapActivityReady, setLiquidityActivityReady,
      setAccountMoneyMarketActivityReady, setXcmEventActivityReady, setStakingActivityReady, setAtokenScaledDeltasReady,
      setActivityDailyReady, setAccountBalanceWeeklyReady, setAccountBalanceHistoryReady, setAccountActivityValuesReady,
      setRewardClaimActivityReady, setOmnipoolPositionCreatedReady, setErc20TransferDeltasReady,
      setHdxHolderLifetimeReady, setHsmActivityReady,
      setDailyChainIdentityCountsReady,
      setAccountBalanceHourlyReady,
      setMultisigActivityReady,
      setVoteActivityReady,
      setMoneyMarketReserveIndicesReady,
      setAtokenScaledDeltasByContractReady,
      setOmnipoolAccountClaimsReady,
      setMoneyMarketAccountValuesReady,
    ]
    if (ready[22]) await dropLegacyDailyChainIdentityCounts(client)
    if (ready[23]) await dropLegacyAccountBalanceDaily(client)
    ready.forEach((complete, index) => { if (complete) setters[index]?.() })
    if (ready[19]) setErc20WalletTransferDeltasReady()
    initTagService(client)
    initIdentityService(client)
    initProxyMultisigService(client)
    initHdxService(client)
    initHollarService(client)
    initErc20WalletService(client)
    initAccountAffinityService(client)
    initXcmJourneyService(client)
    // Tag icons can derive from a member's omniwatch emoji, so the snakewatch
    // source must be loaded before tags are indexed.
    await Promise.all([loadExplorerAssets(client), ensureSnakewatchEmojiSourceLoaded()])
    await Promise.all([loadTags(), loadIdentities()])
    // Seed the fixed default tag set on a fresh database (no-op once tags exist),
    // so a clean `docker compose up` reaches the expected state with no manual step.
    await seedDefaultTags()
    // Money-market reserve contracts self-label from the indexed reserve map;
    // the hourly refresh catches newly listed reserves automatically.
    await syncMoneyMarketTag().catch(e => console.warn('[tags] money-market sync failed', e))
    startMoneyMarketTagRefresh()
    // Structural system-account tags (AMM pools, LM pots, sovereigns) derive
    // from indexed data — recreated automatically after a fresh reindex.
    await syncStructuralTags().catch(e => console.warn('[tags] structural sync failed', e))
    startStructuralTagRefresh()
    startIdentityRefresh()
    // H160 → bound substrate owner map for display resolution.
    await loadEvmBindings().catch(() => {})
    startEvmBindingsRefresh()
    // Account 3-letter-code search index — load in the background (a distinct-account
    // scan), don't block startup; refresh periodically.
    void loadAccountSuffixIndex().catch(() => {})
    startAccountSuffixRefresh()
    startAccountSwapActivityQueueDrain(client)
    await fastify.listen({ port: config.port, host: config.host })
    console.log(`[API] Server listening on ${config.host}:${config.port}`)
    // Historical helper indexes are built after listen so startup remains fast.
    // Run their resumable partition scans sequentially through one long-timeout
    // client: two concurrent raw-table scans would contend with live traffic and
    // the indexers. Each fast path stays disabled until all current partitions
    // have completion markers.
    void (async () => {
      let longOp: ReturnType<typeof createLongOpClickHouseClient> | undefined
      const maintenanceClient = () => (longOp ??= createLongOpClickHouseClient())
      try {
        try {
          if (!(await accountActivityBackfillComplete(client))) {
            console.log('[API] account_activity backfill starting (background)')
            await backfillAccountActivity(maintenanceClient())
          }
          if (!(await accountActivityBackfillComplete(client))) throw new Error('active raw_events partitions remain unmarked')
          setAccountActivityReady()
          console.log('[API] account_activity index ready — account fast paths enabled')
        } catch (err) {
          console.error('[API] account_activity backfill failed; account fast paths stay off', err)
        }

        try {
          if (!(await accountTransferActivityBackfillComplete(client))) {
            console.log('[API] account_transfer_activity backfill starting (background)')
            await backfillAccountTransferActivity(maintenanceClient())
          }
          if (!(await accountTransferActivityBackfillComplete(client))) throw new Error('active raw_events partitions remain unmarked')
          setAccountTransferActivityReady()
          console.log('[API] account_transfer_activity index ready — account transfer reads use the compact model')
        } catch (err) {
          console.error('[API] account_transfer_activity backfill failed; raw transfer path stays enabled', err)
        }

        try {
          if (!(await transferActivityBackfillComplete(client))) {
            console.log('[API] transfer_activity backfill starting (background)')
            await backfillTransferActivity(maintenanceClient())
          }
          if (!(await transferActivityBackfillComplete(client))) throw new Error('active raw_events partitions remain unmarked')
          setTransferActivityReady()
          console.log('[API] transfer_activity index ready — asset transfer reads use the compact model')
        } catch (err) {
          console.error('[API] transfer_activity backfill failed; raw asset transfer path stays enabled', err)
        }

        try {
          if (!(await transferActivityByTimeBackfillComplete(client))) {
            console.log('[API] transfer_activity_by_time backfill starting (background)')
            await backfillTransferActivityByTime(maintenanceClient())
          }
          if (!(await transferActivityByTimeBackfillComplete(client))) throw new Error('active raw_events partitions remain unmarked')
          setTransferActivityByTimeReady()
          console.log('[API] transfer_activity_by_time index ready — global transfer reads use the compact model')
        } catch (err) {
          console.error('[API] transfer_activity_by_time backfill failed; raw global transfer path stays enabled', err)
        }

        try {
          if (!(await swapActivityBackfillComplete(client))) {
            console.log('[API] swap_activity backfill starting (background)')
            await backfillSwapActivity(maintenanceClient())
          }
          if (!(await swapActivityBackfillComplete(client))) throw new Error('active raw_events partitions remain unmarked')
          setSwapActivityReady()
          console.log('[API] swap_activity index ready — global trade reads use the compact model')
        } catch (err) {
          console.error('[API] swap_activity backfill failed; raw global trade path stays enabled', err)
        }

        try {
          if (!(await assetSwapActivityBackfillComplete(client))) {
            console.log('[API] asset_swap_activity backfill starting (background)')
            await backfillAssetSwapActivity(maintenanceClient())
          }
          if (!(await assetSwapActivityBackfillComplete(client))) throw new Error('active raw_events partitions remain unmarked')
          setAssetSwapActivityReady()
          console.log('[API] asset_swap_activity index ready — asset trade reads use the compact model')
        } catch (err) {
          console.error('[API] asset_swap_activity backfill failed; raw asset trade path stays enabled', err)
        }

        try {
          if (!(await otcActivityBackfillComplete(client))) {
            console.log('[API] otc_activity backfill starting (background)')
            await backfillOtcActivity(maintenanceClient())
          }
          if (!(await otcActivityBackfillComplete(client))) throw new Error('active raw_events partitions remain unmarked')
          setOtcActivityReady()
          console.log('[API] otc_activity index ready — OTC lifecycle reads use the compact model')
        } catch (err) {
          console.error('[API] otc_activity backfill failed; raw OTC path stays enabled', err)
        }

        try {
          if (!(await accountSwapActivityBackfillComplete(client))) {
            console.log('[API] account_swap_activity backfill starting (background)')
            await backfillAccountSwapActivity(maintenanceClient())
          }
          if (!(await accountSwapActivityBackfillComplete(client))) throw new Error('active raw_events partitions remain unmarked')
          setAccountSwapActivityReady()
          console.log('[API] account_swap_activity index ready — account trade reads use the compact model')
        } catch (err) {
          console.error('[API] account_swap_activity backfill failed; raw account trade path stays enabled', err)
        }

        try {
          if (!(await liquidityActivityBackfillComplete(client))) {
            console.log('[API] liquidity_activity backfill starting (background)')
            await backfillLiquidityActivity(maintenanceClient())
          }
          if (!(await liquidityActivityBackfillComplete(client))) throw new Error('active raw_events partitions remain unmarked')
          setLiquidityActivityReady()
          console.log('[API] liquidity_activity index ready — liquidity reads use the compact model')
        } catch (err) {
          console.error('[API] liquidity_activity backfill failed; raw liquidity path stays enabled', err)
        }

        try {
          if (!(await accountMoneyMarketActivityBackfillComplete(client))) {
            console.log('[API] account_money_market_activity backfill starting (background)')
            await backfillAccountMoneyMarketActivity(maintenanceClient())
          }
          if (!(await accountMoneyMarketActivityBackfillComplete(client))) throw new Error('active raw_money_market_events partitions remain unmarked')
          setAccountMoneyMarketActivityReady()
          console.log('[API] account_money_market_activity index ready — account money-market reads use the compact model')
        } catch (err) {
          console.error('[API] account_money_market_activity backfill failed; raw account money-market path stays enabled', err)
        }

        try {
          if (!(await xcmEventActivityBackfillComplete(client))) {
            console.log('[API] xcm_event_activity backfill starting (background)')
            await backfillXcmEventActivity(maintenanceClient())
          }
          if (!(await xcmEventActivityBackfillComplete(client))) throw new Error('active raw_events partitions remain unmarked')
          setXcmEventActivityReady()
          console.log('[API] xcm_event_activity index ready — XCM context reads use the compact model')
        } catch (err) {
          console.error('[API] xcm_event_activity backfill failed; raw XCM context path stays enabled', err)
        }

        try {
          if (!(await stakingActivityBackfillComplete(client))) {
            console.log('[API] staking_activity backfill starting (background)')
            await backfillStakingActivity(maintenanceClient())
          }
          if (!(await stakingActivityBackfillComplete(client))) throw new Error('active raw_events partitions remain unmarked')
          setStakingActivityReady()
          console.log('[API] staking_activity ready — staking reads use the sparse model')
        } catch (err) {
          console.error('[API] staking_activity backfill failed; raw staking path stays enabled', err)
        }

        try {
          if (!(await voteActivityBackfillComplete(client))) {
            console.log('[API] vote_activity backfill starting (background)')
            await backfillVoteActivity(maintenanceClient())
          }
          if (!(await voteActivityBackfillComplete(client))) throw new Error('active raw_events partitions remain unmarked')
          setVoteActivityReady()
          console.log('[API] vote_activity ready — vote feeds use the sparse model')
        } catch (err) {
          console.error('[API] vote_activity backfill failed; raw vote path stays enabled', err)
        }

        try {
          if (!(await hsmActivityBackfillComplete(client))) {
            console.log('[API] hsm_activity backfill starting (background)')
            await backfillHsmActivity(maintenanceClient())
          }
          if (!(await hsmActivityBackfillComplete(client))) throw new Error('active raw_events partitions remain unmarked')
          setHsmActivityReady()
          console.log('[API] hsm_activity ready — HOLLAR dashboard reads use the sparse model')
        } catch (err) {
          console.error('[API] hsm_activity backfill failed; raw HSM path stays enabled', err)
        }

        try {
          if (!(await atokenScaledDeltasBackfillComplete(client))) {
            console.log('[API] atoken_scaled_deltas backfill starting (background)')
            await backfillAtokenScaledDeltas(maintenanceClient())
          }
          if (!(await atokenScaledDeltasBackfillComplete(client))) throw new Error('active raw_evm_logs partitions remain unmarked')
          setAtokenScaledDeltasReady()
          console.log('[API] atoken_scaled_deltas ready — aToken balance reads use decoded deltas')
        } catch (err) {
          console.error('[API] atoken_scaled_deltas backfill failed; raw EVM delta path stays enabled', err)
        }

        try {
          if (!(await atokenScaledDeltasByContractBackfillComplete(client))) {
            console.log('[API] atoken_scaled_deltas_by_contract backfill starting (background)')
            await backfillAtokenScaledDeltasByContract(maintenanceClient())
          }
          if (!(await atokenScaledDeltasByContractBackfillComplete(client))) throw new Error('active raw_evm_logs partitions remain unmarked')
          setAtokenScaledDeltasByContractReady()
          console.log('[API] atoken_scaled_deltas_by_contract ready — aToken holder reads use the contract-first model')
        } catch (err) {
          console.error('[API] atoken_scaled_deltas_by_contract backfill failed; holder reads keep the holder-first path', err)
        }

        try {
          if (!(await moneyMarketReserveIndicesBackfillComplete(client))) {
            console.log('[API] money_market_reserve_indices backfill starting (background)')
            await backfillMoneyMarketReserveIndices(maintenanceClient())
          }
          if (!(await moneyMarketReserveIndicesBackfillComplete(client))) throw new Error('active raw_money_market_reserves partitions remain unmarked')
          setMoneyMarketReserveIndicesReady()
          console.log('[API] money_market_reserve_indices ready — reserve index reads use the compact model')
        } catch (err) {
          console.error('[API] money_market_reserve_indices backfill failed; raw current-index path stays enabled', err)
        }

        try {
          if (!(await activityDailyBackfillComplete(client))) {
            console.log('[API] activity_histogram_events backfill starting (background)')
            await backfillActivityDaily(maintenanceClient())
          }
          if (!(await activityDailyBackfillComplete(client))) throw new Error('active raw_events partitions remain unmarked')
          await dropLegacyActivityDailyAggregate(client)
          setActivityDailyReady()
          console.log('[API] activity_histogram_events ready — activity histograms use replacing event rows')
        } catch (err) {
          console.error('[API] activity_histogram_events backfill failed; raw activity histogram path stays enabled', err)
        }

        try {
          if (!(await dailyChainIdentityCountsBackfillComplete(client))) {
            console.log('[API] daily_chain_identity_counts backfill starting (background)')
            await backfillDailyChainIdentityCounts(maintenanceClient())
          }
          if (!(await dailyChainIdentityCountsBackfillComplete(client))) throw new Error('active raw event/extrinsic partitions remain unmarked')
          await dropLegacyDailyChainIdentityCounts(maintenanceClient())
          setDailyChainIdentityCountsReady()
          console.log('[API] daily_chain_identity_counts ready — Events/Extrinsics charts use replay-safe bitmaps')
        } catch (err) {
          console.error('[API] daily chain bitmap backfill failed; raw list-chart paths stay enabled', err)
        }

        try {
          if (!(await accountBalanceWeeklyBackfillComplete(client))) {
            console.log('[API] account_balance_weekly backfill starting (background)')
            await backfillAccountBalanceWeekly(maintenanceClient())
          }
          if (!(await accountBalanceWeeklyBackfillComplete(client))) throw new Error('active raw_balance_observations partitions remain unmarked')
          setAccountBalanceWeeklyReady()
          console.log('[API] account_balance_weekly ready — aggregate sparkline path enabled')
        } catch (err) {
          console.error('[API] account_balance_weekly backfill failed; raw sparkline path stays enabled', err)
        }

        try {
          if (!(await accountBalanceHistoryBackfillComplete(client))) {
            console.log('[API] account_balance_history backfill starting (background)')
            await backfillAccountBalanceHistory(maintenanceClient())
          }
          if (!(await accountBalanceHistoryBackfillComplete(client))) throw new Error('active raw_balance_observations partitions remain unmarked')
          setAccountBalanceHistoryReady()
          console.log('[API] account_balance_history ready — exact account/tag history uses account-first observations')
        } catch (err) {
          console.error('[API] account_balance_history backfill failed; raw balance history path stays enabled', err)
        }

        try {
          if (!(await accountBalanceHourlyBackfillComplete(client))) {
            console.log('[API] account_balance_hourly backfill starting (background)')
            await backfillAccountBalanceHourly(maintenanceClient())
          }
          if (!(await accountBalanceHourlyBackfillComplete(client))) throw new Error('active raw balance partitions remain unmarked')
          await dropLegacyAccountBalanceDaily(maintenanceClient())
          setAccountBalanceHourlyReady()
          console.log('[API] account_balance_hourly ready — exact account/tag chart buckets use hourly closes')
        } catch (err) {
          console.error('[API] account_balance_hourly backfill failed; account/tag history stays on observation rows', err)
        }

        try {
          if (!(await hdxHolderLifetimeBackfillComplete(client))) {
            console.log('[API] hdx_holder_lifetime backfill starting (background)')
            await backfillHdxHolderLifetime(maintenanceClient())
          }
          if (!(await hdxHolderLifetimeBackfillComplete(client))) throw new Error('active raw balance partitions remain unmarked')
          setHdxHolderLifetimeReady()
          console.log('[API] hdx_holder_lifetime ready — HDX churn uses first/last holder states')
        } catch (err) {
          console.error('[API] hdx_holder_lifetime backfill failed; raw HDX churn path stays enabled', err)
        }

        try {
          if (!(await rewardClaimActivityBackfillComplete(client))) {
            console.log('[API] reward_claim_activity backfill starting (background)')
            await backfillRewardClaimActivity(maintenanceClient())
          }
          if (!(await incentiveClaimCallsBackfillComplete(client))) {
            console.log('[API] incentive_claim_calls backfill starting (background)')
            await backfillIncentiveClaimCalls(maintenanceClient())
          }
          if (!(await rewardClaimActivityBackfillComplete(client)) || !(await incentiveClaimCallsBackfillComplete(client))) {
            throw new Error('active raw event/call partitions remain unmarked')
          }
          setRewardClaimActivityReady()
          console.log('[API] reward claim indexes ready — reward classification uses compact models')
        } catch (err) {
          console.error('[API] reward claim backfill failed; raw reward path stays enabled', err)
        }

        try {
          if (!(await accountActivityValuesBackfillComplete(client))) {
            console.log('[API] account_activity_v3 backfill starting (background)')
            await backfillAccountActivityValues(maintenanceClient())
          }
          if (!(await accountActivityValuesBackfillComplete(client))) throw new Error('active raw_events partitions remain unmarked')
          setAccountActivityValuesReady()
          console.log('[API] account_activity_v3 ready — value-filtered tab counts enabled')
        } catch (err) {
          console.error('[API] account_activity_v3 backfill failed; value-filtered counts stay off', err)
        }

        try {
          if (!(await erc20TransferDeltasBackfillComplete(client))) {
            console.log('[API] erc20_transfer_deltas backfill starting (background)')
            await backfillErc20TransferDeltas(maintenanceClient())
          }
          if (!(await erc20TransferDeltasBackfillComplete(client))) throw new Error('active raw_evm_logs partitions remain unmarked')
          setErc20TransferDeltasReady()
          setErc20WalletTransferDeltasReady()
          console.log('[API] erc20_transfer_deltas ready — HOLLAR history uses decoded deltas')
        } catch (err) {
          console.error('[API] erc20_transfer_deltas backfill failed; raw HOLLAR history path stays enabled', err)
        }

        try {
          if (!(await omnipoolPositionCreatedBackfillComplete(client))) {
            console.log('[API] omnipool_position_created backfill starting (background)')
            await backfillOmnipoolPositionCreated(maintenanceClient())
          }
          if (!(await omnipoolPositionCreatedBackfillComplete(client))) throw new Error('active raw_events partitions remain unmarked')
          setOmnipoolPositionCreatedReady()
          console.log('[API] omnipool_position_created ready — LP history creation lookups use the sparse model')
        } catch (err) {
          console.error('[API] omnipool_position_created backfill failed; raw LP creation lookup stays enabled', err)
        }

        try {
          if (!(await omnipoolPositionStateEventsBackfillComplete(client))) {
            console.log('[API] omnipool_position_state_events backfill starting (background)')
            await backfillOmnipoolPositionStateEvents(maintenanceClient())
          }
          if (!(await omnipoolPoolStateHistoryBackfillComplete(client))) {
            console.log('[API] omnipool_pool_state_history backfill starting (background)')
            await backfillOmnipoolPoolStateHistory(maintenanceClient())
          }
          const [stateReady, poolReady, intervalsReady] = await Promise.all([
            omnipoolPositionStateEventsBackfillComplete(client),
            omnipoolPoolStateHistoryBackfillComplete(client),
            omnipoolOwnerIntervalsCoverageComplete(client),
          ])
          if (stateReady && poolReady && intervalsReady) {
            setOmnipoolHistoryReady()
            console.log('[API] omnipool history models ready — historical LP principal path enabled')
          } else {
            console.log('[API] omnipool history: MV projections done; awaiting owner-interval builder coverage before enabling')
          }
        } catch (err) {
          console.error('[API] omnipool history backfill failed; value-history keeps the current-shares approximation', err)
        }

        try {
          if (!(await xykPoolRegistryBackfillComplete(client))) {
            console.log('[API] xyk_pool_registry backfill starting (background)')
            await backfillXykPoolRegistry(maintenanceClient())
          }
          if (!(await xykPoolReserveHistoryBackfillComplete(client))) {
            console.log('[API] xyk_pool_reserve_history backfill starting (background)')
            await backfillXykPoolReserveHistory(maintenanceClient())
          }
          const [regReady, resvReady, sharesReady, farmReady] = await Promise.all([
            xykPoolRegistryBackfillComplete(client),
            xykPoolReserveHistoryBackfillComplete(client),
            xykTotalSharesCoverageComplete(client),
            xykFarmIntervalsCoverageComplete(client),
          ])
          if (regReady && resvReady && sharesReady && farmReady) {
            setXykHistoryReady()
            console.log('[API] xyk history models ready — historical XYK LP principal path enabled')
          } else {
            console.log('[API] xyk history: MV projections done; awaiting total-shares reconstruction + farm-interval builder coverage before enabling')
          }
        } catch (err) {
          console.error('[API] xyk history backfill failed; value-history leaves XYK LP unvalued', err)
        }

        try {
          if (!(await multisigActivityBackfillComplete(client))) {
            console.log('[API] multisig activity backfill starting (background)')
            await backfillMultisigActivity(maintenanceClient())
          }
          if (!(await multisigActivityBackfillComplete(client))) throw new Error('active raw event/call partitions remain unmarked')
          setMultisigActivityReady()
          console.log('[API] multisig activity ready — account polls and composition refreshes use sparse models')
        } catch (err) {
          console.error('[API] multisig activity backfill failed; multisig enrichment stays disabled', err)
        }

        try {
          if (!(await accountTradeVolumeCovered(client))) {
            console.log('[API] account_trade_volume backfill starting (background)')
            await backfillAccountTradeVolume(maintenanceClient())
          }
          if (!(await accountTradeVolumeCovered(client))) throw new Error('active raw_events swap partitions remain unmarked')
          setAccountTradeVolumeReady()
          console.log('[API] account_trade_volume ready — per-account trading volume de-duplicates routing hops')
        } catch (err) {
          console.error('[API] account_trade_volume backfill failed; per-account volume keeps the legacy per-leg sum', err)
        }
      } finally {
        await longOp?.close().catch(err => console.error('[API] maintenance ClickHouse client close failed', err))
        try {
          await refreshOmnipoolAccountClaims()
          setOmnipoolAccountClaimsReady()
          console.log('[API] Omnipool account claims ready — account directory values include bare and farmed positions')
        } catch (err) {
          console.error('[API] Omnipool account claim refresh failed; directory keeps wallet/MM-only values', err)
        }
        // Keep retrying a failed initial generation; a last complete generation
        // remains published until a later count-checked refresh succeeds.
        startOmnipoolAccountClaimsRefresh()
        try {
          await refreshMoneyMarketAccountValues()
          setMoneyMarketAccountValuesReady()
          console.log('[API] money-market account values ready — account directory uses current reserve principal')
        } catch (err) {
          console.error('[API] money-market account value refresh failed; directory keeps aggregate MM values', err)
        }
        // Keep retrying without disturbing a previously published complete
        // generation if one bounded rebuild fails.
        startMoneyMarketAccountValuesRefresh()
        // Prewarming invokes the same account/holder reconstruction paths as a
        // request. Start it only after completeness gates have selected compact
        // models, so a restart cannot fan out raw historical scans in parallel
        // with the bounded backfills above.
        startAccountsPrewarm()
        startTagCountsPrewarm()
        // The net-trade volume model has no MV; recompute recent partitions on a
        // timer so per-account volume tracks live trading.
        startAccountTradeVolumeRefresh()
      }
    })()
  } catch (err) {
    fastify.log.error(err)
    await fastify.close().catch(async closeError => {
      fastify.log.error(closeError)
      await client.close().catch(() => {})
    })
    process.exit(1)
  }
}

let shuttingDown = false
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  fastify.log.info({ signal }, 'shutting down')
  try {
    await fastify.close()
  } catch (err) {
    fastify.log.error(err)
    process.exitCode = 1
  }
  process.exit(process.exitCode ?? 0)
}

process.once('SIGTERM', () => { void shutdown('SIGTERM') })
process.once('SIGINT', () => { void shutdown('SIGINT') })

void start()
