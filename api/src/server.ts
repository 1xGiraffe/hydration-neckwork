import Fastify from 'fastify'
import cors from '@fastify/cors'
import compress from '@fastify/compress'
import { config } from './config.ts'
import { createClickHouseClient, createLongOpClickHouseClient } from './db/client.ts'
import {
  backfillAccountSwapNetRows,
  drainAccountSwapActivityQueue,
  seedAccountSwapActivityQueue,
  startAccountSwapActivityQueueDrain,
  stopAccountSwapActivityQueueDrain,
} from './db/accountSwapQueue.ts'
import { loadAssets, stopAssetsRefresh } from './services/assetsService.ts'
import { candlesRoutes } from './routes/candles.ts'
import { assetsRoutes } from './routes/assets.ts'
import { marketStatsRoutes } from './routes/market-stats.ts'
import { indexerRoutes } from './routes/indexer.ts'
import { explorerRoutes } from './routes/explorer.ts'
import { contractsRoutes } from './routes/contracts.ts'
import { poolsRoutes } from './routes/pools.ts'
import { liveRoutes } from './routes/live.ts'
import { initLiveHeadService, stopLiveHeadService } from './services/liveHeadService.ts'
import { initPendingHeadService, startPendingHeadService, stopPendingHeadService } from './services/pendingHeadService.ts'
import { tagRoutes } from './routes/tags.ts'
import { userRoutes } from './routes/user.ts'
import { listsRoutes } from './routes/lists.ts'
import { verificationRoutes, collapseDuplicateSlashes } from './routes/verification.ts'
import { loadExplorerAssets, stopExplorerAssetsRefresh } from './services/explorerAssets.ts'
import { loadRuntimeErrorNames, stopRuntimeErrorNamesRefresh } from './services/runtimeErrorNames.ts'
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
  startContractMetricsRefresh,
  startActivityLeaderboardRefresh,
  startFoldActivitySweep,
  startTagCountsPrewarm,
  stopExplorerBackgroundTasks,
} from './services/explorerService.ts'
import { initTagService, loadTags, seedDefaultTags, syncMoneyMarketTag, startMoneyMarketTagRefresh, syncStructuralTags, startStructuralTagRefresh, reconcileTagPresentation, retireUnknownTagMemberships } from './services/tagService.ts'
import { initContractRegistryService, loadContractRegistry, startContractRegistryRefresh, stopContractRegistryRefresh } from './services/contractRegistryService.ts'
import { initContractVerificationService, loadVerifiedContracts, startVerifiedContractsRefresh, stopVerifiedContractsRefresh } from './services/contractVerificationService.ts'
import { initIdentityService, loadIdentities, startIdentityRefresh, stopIdentityRefresh } from './services/identityService.ts'
import { initGovernanceService } from './services/governanceService.ts'
import {
  initReferendumTitleService,
  loadReferendumTitles,
  startReferendumTitleRefresh,
  stopReferendumTitleRefresh,
} from './services/referendumTitleService.ts'
import { initProxyMultisigService } from './services/proxyMultisigService.ts'
import { initHdxService } from './services/hdxService.ts'
import { initRevenueService } from './services/revenueService.ts'
import { initHollarService } from './services/hollarService.ts'
import { initPoolService } from './services/poolService.ts'
import { initSecurityService } from './services/securityService.ts'
import { initErc20WalletService } from './services/erc20WalletService.ts'
import { startBackgroundRefresh, stopBackgroundRefresh } from './services/backgroundRefresh.ts'
import { initAccountAffinityService } from './services/accountAffinityService.ts'
import { ensureSnakewatchEmojiSourceLoaded } from './services/omniwatchIdentity.ts'
import { initXcmJourneyService } from './services/xcmJourneyService.ts'
import { initUserAuthService, loadUserSessions, ensureSessionDeviceColumns } from './services/userAuthService.ts'
import { initUserProfileService, loadUserProfiles } from './services/userProfileService.ts'
import { initUserListService, loadUserLists, ensureTagMemberPositionColumn } from './services/userListService.ts'
import { notificationRoutes } from './routes/notifications.ts'
import { initNotifications, loadNotifications } from './notifications/notificationStore.ts'
import { startTelegramBot, stopTelegramBot } from './notifications/telegramBot.ts'
import { initEvaluator, startNotificationEvaluator, stopNotificationEvaluator } from './notifications/evaluator.ts'
import { telegramConfigured } from './notifications/delivery.ts'

// Trust X-Forwarded-For/X-Real-IP only from loopback/link-local/private-range
// hops — exactly the explorer-ui nginx container on the compose network (see
// explorer-ui/nginx.conf's `/api/user/` location, which sets both headers).
// Without this, every request's req.ip collapses to nginx's own container
// address, so @fastify/rate-limit (api/src/routes/user.ts) keys ALL browsers
// combined into one bucket — the whole site would share a single 10-logins/min
// budget instead of each visitor getting their own. Tradeoff: a client that is
// already inside that private network (not behind nginx) could spoof XFF to
// rotate its own rate-limit bucket — acceptable, since the limiter is only an
// abuse brake and auth itself is signature-based, not IP-based. Never widen
// this to bare `true`, which would trust XFF from any hop, including a public
// client spoofing it directly.
const fastify = Fastify({
  logger: true,
  trustProxy: ['loopback', 'linklocal', 'uniquelocal'],
  // Verification clients can produce a doubled leading slash (`//v2/...`)
  // purely from how they join their configured base URL; collapse it before
  // routing so those requests reach the same handlers. See routes/verification.ts.
  rewriteUrl: req => collapseDuplicateSlashes(req.url ?? '/'),
})

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
  // The Live surfaces poll on the chain's block cadence (~6s today, 2s
  // planned) and their server caches are invalidated per ingested block
  // (head-keyed keys), so a 5s browser cache would be the freshness
  // bottleneck. 2s only matters for rapid tab switches — consecutive polls at
  // today's cadence never hit it either way.
  [/^\/explorer\/(stats|blocks|extrinsics|events|activity)$/, 2],
  [/^\/candles/, 5],
  [/^\/explorer\/hdx/, 300],
  // Revenue dashboard is SWR-cached 60s server-side; the flow tail is a live
  // feed whose URL carries the head tag, so 2s only bounds rapid tab switches.
  [/^\/explorer\/revenue\/flow$/, 2],
  [/^\/explorer\/revenue$/, 60],
  [/^\/explorer\/hollar/, 300],
  [/^\/explorer\/address\/[^/]+\/close-accounts/, 900],
  [/^\/explorer\/address\/[^/]+\/history/, 120],
  [/^\/explorer\/(address|tag)\/[^/]+\/counts/, 600],
  [/^\/explorer\/(daily|accounts-daily)/, 300],
  [/^\/explorer\/list/, 30],                          // /lists directory + /list/:id detail
  // /lists (owned) + /tagged-in (member) — both summarize a public list's
  // live subscriber/membership counts, so they share the same 30s freshness
  // window as the directory/detail routes above (subscriberCount changes
  // right under them too) rather than falling through to the generic 8s
  // address bucket below.
  [/^\/explorer\/address\/[^/]+\/(lists|tagged-in)/, 30],
  [/^\/explorer\/(address|tag)\//, 8],
  [/^\/explorer\/search/, 10],
  // `assets` (no trailing slash) is the asset directory — 30s in-process TTL, so
  // let clients reuse it just as long. Without this it fell through to the 2s
  // catch-all and browsers re-fetched the biggest list payload constantly.
  [/^\/explorer\/assets/, 30],
  // The call/event name catalogue: an hour, matching its in-process TTL. The
  // list changes only when a runtime upgrade adds or removes a name, and every
  // filter box and alert form on the site reads the same copy.
  [/^\/explorer\/filter-names$/, 3600],
  // Pool surfaces: current state refreshes every 30-60s server-side, the heavy
  // history models every 300s — match the shortest internal freshness window.
  [/^\/explorer\/omnipool/, 30],
  [/^\/explorer\/pool\//, 30],
  [/^\/explorer\/asset\/\d+\/liquidity/, 60],
  [/^\/explorer\/(holders|asset)\//, 15],
  // Directory ranking is SWR-cached with a 60s freshness window server-side;
  // matching client reuse cuts request volume without adding staleness.
  // (accounts-daily is matched by its earlier rule.)
  [/^\/explorer\/accounts/, 30],
  // Contracts directory: in-memory registry refreshed every 5 minutes.
  [/^\/explorer\/contracts/, 30],
  // Verified-contract artifacts (ABI, sources) change only on re-verification.
  [/^\/explorer\/contract\//, 300],
  // Sourcify already-verified probe; flips at most once per verification.
  [/^\/v2\/contract\//, 60],
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
  stopPendingHeadService()
  stopLiveHeadService()
  stopAssetsRefresh()
  stopExplorerAssetsRefresh()
  stopRuntimeErrorNamesRefresh()
  stopIdentityRefresh()
  stopReferendumTitleRefresh()
  stopBackgroundRefresh()
  stopContractRegistryRefresh()
  stopVerifiedContractsRefresh()
  stopAccountSwapActivityQueueDrain()
  stopExplorerBackgroundTasks()
  stopTelegramBot()
  // Awaited: the evaluator's cursors are written on a throttle, and the last
  // ones have to land before the client that writes them closes.
  await stopNotificationEvaluator()
  await client.close()
})

await fastify.register(assetsRoutes)
await fastify.register(candlesRoutes, { client })
await fastify.register(marketStatsRoutes, { client })
await fastify.register(indexerRoutes, { client })
await fastify.register(explorerRoutes)
await fastify.register(contractsRoutes)
await fastify.register(poolsRoutes)
await fastify.register(liveRoutes)
await fastify.register(tagRoutes)
await fastify.register(userRoutes)
await fastify.register(notificationRoutes)
await fastify.register(listsRoutes)
await fastify.register(verificationRoutes)

async function start() {
  try {
    // Request-time on-behalf timestamp formatting (chTimestampString) and multisig
    // date-window bounds (msAnchorWindow), both in explorerService.ts, reproduce
    // ClickHouse's session-timezone semantics only when this server runs UTC.
    // Fail fast rather than silently desynchronizing on-behalf rows from
    // SQL-sourced rows if that configuration ever drifts.
    const tzRes = await client.query({ query: 'SELECT timezone() AS tz', format: 'JSONEachRow' })
    const [{ tz }] = await tzRes.json<{ tz: string }>()
    if (tz !== 'UTC') {
      fastify.log.error(
        `[API] ClickHouse session timezone is '${tz}', not 'UTC'. chTimestampString and msAnchorWindow in explorerService.ts assume UTC and would silently desynchronize on-behalf rows from SQL-sourced rows.`,
      )
      process.exit(1)
    }
    // The schema is created by the schema-bootstrap service before this process
    // starts (Compose depends_on: service_completed_successfully), so no schema
    // work runs here. Seed/drain the account-swap-activity queue on a long-op
    // client, off the public request client (20s timeout, 4 GB cap).
    const bootstrapClient = createLongOpClickHouseClient()
    try {
      await seedAccountSwapActivityQueue(bootstrapClient)
      await drainAccountSwapActivityQueue(bootstrapClient, { maxBatches: 100 })
    } finally {
      await bootstrapClient.close()
    }
    await loadAssets(client)
    initExplorerService(client)
    // The schema is declarative and every read model is correct-by-construction
    // (materialized views + the derivations runner), so services start
    // immediately against whatever raw has been ingested — there are no
    // readiness gates or historical backfills to wait on.
    initTagService(client)
    initIdentityService(client)
    initReferendumTitleService(client)
    initGovernanceService(client)
    initProxyMultisigService(client)
    initHdxService(client)
    initRevenueService(client)
    initHollarService(client)
    initPoolService(client)
    initSecurityService(client)
    initLiveHeadService(client)
    // The pending-head follower is always-on (feeds merge its rows whether or
    // not any SSE client is connected); it degrades to finalized-only silently
    // if the RPC node is unreachable.
    initPendingHeadService(client)
    startPendingHeadService()
    initErc20WalletService(client)
    // Must precede startBackgroundRefresh(): its initial pass runs the
    // contract-code snapshot refresher, which reads and writes ClickHouse.
    initContractRegistryService(client)
    initContractVerificationService(client)
    await initUserAuthService(client)
    initUserProfileService(client)
    initUserListService(client)
    initNotifications(client)
    initEvaluator(client)
    // Additive columns on an existing deployment (see the guards' own comments
    // in userListService.ts / userAuthService.ts) — must land before
    // loadUserLists()/loadUserSessions() below first SELECT them.
    await ensureTagMemberPositionColumn(client)
    await ensureSessionDeviceColumns(client)
    // The node-full refreshers (lock breakdown, proxy/multisig, ERC-20 wallets)
    // share one coordinated scheduler so they never stack concurrent RPC bursts
    // on the archive node; started after their clients are set.
    startBackgroundRefresh()
    initAccountAffinityService(client)
    initXcmJourneyService(client)
    // Tag icons can derive from a member's omniwatch emoji, so the snakewatch
    // source must be loaded before tags are indexed.
    await Promise.all([loadExplorerAssets(client), ensureSnakewatchEmojiSourceLoaded(), loadRuntimeErrorNames(client)])
    // Referendum titles come from SubSquare (the chain has none), so they are held
    // in memory like identities and read on every vote row the explorer renders.
    await Promise.all([loadTags(), loadUserProfiles(), loadIdentities(), loadReferendumTitles().catch(() => {}), loadUserSessions(), loadUserLists(), loadNotifications()])
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
    // Contract registry: merge the code snapshot with the MV projections. There
    // is no contracts tag — the `</>` pill glyph (AccountRef.isContract) marks a
    // contract wherever an account appears, and /contracts is their directory.
    await loadContractRegistry().catch(e => console.warn('[contracts] registry load failed', e))
    startContractRegistryRefresh()
    // Verified-contract map (names, match types, code hashes at verification
    // time): drives the directory chip, AddressDetail.verification and search.
    // Refreshed after every successful verification; the slow timer covers
    // external writers (the ad-hoc Blockscout seed).
    await loadVerifiedContracts().catch(e => console.warn('[contracts] verified map load failed', e))
    startVerifiedContractsRefresh()
    // What each contract holds and does as an account (value, holdings, 1Y,
    // trading, activity) for the /contracts directory — one bounded ClickHouse
    // pass over the whole registry, off the request path.
    startContractMetricsRefresh()
    // Colors are code-canonical; push any code-side color edits onto already-seeded
    // rows (seed/sync never rewrite existing memberships). No-op when already in sync.
    await reconcileTagPresentation().catch(e => console.warn('[tags] presentation reconcile failed', e))
    await retireUnknownTagMemberships().catch(e => console.warn('[tags] retire reconcile failed', e))
    startIdentityRefresh()
    startReferendumTitleRefresh()
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
    // Telegram channel linking needs the bot's long-poll loop; without a token
    // the notification routes still work and simply report Telegram as
    // unconfigured.
    if (telegramConfigured()) startTelegramBot()
    // Alert evaluation is always-on and independent of the SSE-gated live-head
    // service: a notification has to fire whether or not anybody has the
    // explorer open. Its first tick seeds the cursor at the live head, so
    // starting it never replays what was indexed while the api was down.
    startNotificationEvaluator()
    // One-time historical repair (background, off the request client): routed
    // swaps ingested before the queue MV lack their Router net row in
    // account_swap_activity, so the activity feed shows an internal hop
    // (e.g. aDOT→vDOT) instead of the true pair (DOT→SOL). Idempotent + flag-
    // gated, so it runs once and is a no-op on every subsequent boot.
    void (async () => {
      const backfillClient = createLongOpClickHouseClient()
      try {
        const n = await backfillAccountSwapNetRows(backfillClient)
        if (n) console.log(`[API] account-swap net backfill processed ${n} router-net events`)
      } catch (err) {
        console.error('[API] account-swap net backfill failed', err)
      } finally {
        await backfillClient.close()
      }
    })()
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
    // The directory's activity ranking, on its own slow interval: it recounts a few
    // aged-out members per cycle rather than the whole pool per prewarm.
    startActivityLeaderboardRefresh()
    // Activity totals for viewers' own list tags: a single-file background lane, so a
    // page never computes one (see explorerService).
    startFoldActivitySweep()
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
