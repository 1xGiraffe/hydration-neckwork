import Fastify from 'fastify'
import cors from '@fastify/cors'
import compress from '@fastify/compress'
import { config } from './config.ts'
import { createClickHouseClient, createLongOpClickHouseClient } from './db/client.ts'
import {
  drainAccountSwapActivityQueue,
  seedAccountSwapActivityQueue,
  startAccountSwapActivityQueueDrain,
  stopAccountSwapActivityQueueDrain,
} from './db/accountSwapQueue.ts'
import { applySchema } from './db/schemaBootstrap.ts'
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
  refreshOmnipoolAccountClaims,
  startOmnipoolAccountClaimsRefresh,
  omnipoolAccountClaimsSnapshotReady,
  setOmnipoolAccountClaimsReady,
  refreshMoneyMarketAccountValues,
  startMoneyMarketAccountValuesRefresh,
  moneyMarketAccountValueSnapshotReady,
  setMoneyMarketAccountValuesReady,
  startAccountsPrewarm,
  startTagCountsPrewarm,
  stopExplorerBackgroundTasks,
} from './services/explorerService.ts'
import { initTagService, loadTags, seedDefaultTags, syncMoneyMarketTag, startMoneyMarketTagRefresh, syncStructuralTags, startStructuralTagRefresh } from './services/tagService.ts'
import { initIdentityService, loadIdentities, startIdentityRefresh, stopIdentityRefresh } from './services/identityService.ts'
import { initProxyMultisigService, stopProxyMultisigService } from './services/proxyMultisigService.ts'
import { initHdxService, stopHdxService } from './services/hdxService.ts'
import { initHollarService } from './services/hollarService.ts'
import { initErc20WalletService, stopErc20WalletService } from './services/erc20WalletService.ts'
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

async function start() {
  try {
    // Schema upgrades can include bounded historical INSERT…SELECT work. Keep
    // them off the public request client, whose 20s timeout and 4 GB cap are
    // intentionally tuned for HTTP queries rather than maintenance.
    const migrationClient = createLongOpClickHouseClient()
    try {
      await applySchema(migrationClient)
      await seedAccountSwapActivityQueue(migrationClient)
      await drainAccountSwapActivityQueue(migrationClient, { maxBatches: 100 })
    } finally {
      await migrationClient.close()
    }
    await loadAssets(client)
    initExplorerService(client)
    // The schema is declarative and every read model is correct-by-construction
    // (materialized views + the derivations runner), so services start
    // immediately against whatever raw has been ingested — there are no
    // readiness gates or historical backfills to wait on.
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
    // Account-directory value snapshots (bare/farmed Omnipool claims and current
    // money-market reserve principal) have no materialized view or derivation
    // job, so the API still computes them: generate once now, then keep fresh on
    // a timer. Each publishes its own readiness after a complete, parity-checked
    // generation lands, so the directory upgrades from aggregate to exact values
    // in place. Fire-and-forget after listen so startup stays fast.
    //
    // On restart a prior snapshot may already satisfy the DB-parity check, so
    // pre-flip readiness up front — otherwise the directory would serve
    // degraded values until the (potentially long) regeneration below finishes,
    // even though an exact snapshot is already sitting in ClickHouse.
    if (await omnipoolAccountClaimsSnapshotReady()) setOmnipoolAccountClaimsReady()
    if (await moneyMarketAccountValueSnapshotReady()) setMoneyMarketAccountValuesReady()
    void refreshOmnipoolAccountClaims().catch(err => console.error('[API] Omnipool account claim refresh failed; directory keeps wallet/MM-only values', err))
    startOmnipoolAccountClaimsRefresh()
    void refreshMoneyMarketAccountValues().catch(err => console.error('[API] money-market account value refresh failed; directory keeps aggregate MM values', err))
    startMoneyMarketAccountValuesRefresh()
    // Prewarm the hottest account/tag reconstruction paths so the first real
    // request does not pay the cold-cache cost.
    startAccountsPrewarm()
    startTagCountsPrewarm()
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
