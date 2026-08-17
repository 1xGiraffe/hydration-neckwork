import { createHash } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached, cachedSwr } from '../../services/cache.ts'
import { csv, iso, zAssetId, zHexAddress, zIsoTimestamp, zLimitOffset, zPage } from '../schemas/common.ts'
import {
  HISTORY_MAX_POINTS,
  queryBalanceHistory,
  queryLatestBalances,
  resolveHistoryGrid,
} from '../services/accountBalances.ts'
import { MM_EVENT_NAMES, mmEventName, queryMoneyMarketEvents } from '../services/moneyMarketEvents.ts'

// Accounts endpoints: current valued balances for a batch of accounts, a bucketed
// net-worth series, and a paged money-market event feed. See spec section
// "Accounts" and "Semantics" rule 7 for the normative definitions.

// One request may value at most this many accounts. The bound is both a cost
// ceiling on the uncached path and a cardinality ceiling on the cache keys.
const MAX_BALANCE_ACCOUNTS = 50

const zBalanceItem = z.object({
  account: zHexAddress,
  transferableUsd: z.string(),
  lockedUsd: z.string(),
  // Null means "temporarily unavailable", never zero: the slice's snapshot is
  // stale or missing. A fresh snapshot in which the account holds nothing is
  // "0.00".
  lpUsd: z.string().nullable(),
  debtUsd: z.string().nullable(),
  totalUsd: z.string(),
  blockHeight: z.number().int(),
})

const zHistoryPoint = z.object({
  // The bucket's CLOSE — the instant the values are as of.
  timestamp: zIsoTimestamp,
  transferableUsd: z.string(),
  lockedUsd: z.string(),
  debtUsd: z.string(),
})

const zMmEvent = z.object({
  eventName: z.enum(MM_EVENT_NAMES),
  assetId: zAssetId.nullable(),
  amount: z.string().nullable(),
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  timestamp: zIsoTimestamp,
  categoryId: z.number().int().nullable(),
})

// A path parameter carrying one account, shared by the two per-account routes.
const zAccountParams = z.object({ account: zHexAddress })

// Request timestamps accept any ISO-8601 instant — with or without milliseconds,
// and with an explicit zone offset — so a caller need not pre-format. Responses
// always carry the UTC millisecond form.
const zIsoQuery = z.iso.datetime({ offset: true })

const zHistoryQuery = z.object({
  from: zIsoQuery.optional(),
  to: zIsoQuery.optional(),
  // Only buckets the hourly balance model can actually express. A finer bucket
  // would interpolate rather than observe, so it is rejected instead of rounded up.
  bucket: z.enum(['1h', '1d']).default('1h'),
})

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 })
}

export const accountsRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/accounts/balances', {
    schema: {
      tags: ['accounts'],
      summary: 'Current valued balances for up to 50 accounts',
      description: [
        'Batched replacement for a per-account balance fan-out. `transferableUsd` values, at current prices: free pallet balances, the ERC-20-backed wallet pot (assets such as HOLLAR whose balances live in contract storage), and money-market SUPPLIED balances — the aToken side (spec "Semantics" rule 7). `lockedUsd` values reserved pallet balances. `lpUsd` values Omnipool LP claims — what the account\'s positions would withdraw at current pool state, bare and farm-deposited alike, including each position\'s hub (LRNA) leg.',
        '`totalUsd` is transferable + locked + LP: GROSS assets. It is rounded from the exact sum, so it can differ by up to a cent from adding the three rounded fields — trust `totalUsd`, and treat the identity as holding to within a cent. `debtUsd` is money-market debt across every configured market, reported on its own and NOT netted out of any other field (deviation from the data lake; documented). The Hydration account picker\'s value is therefore `totalUsd - debtUsd`. `lockedUsd` covers reserved balances only, because the frozen component is not carried by the latest-balance model.',
        'The money-market and LP slices are read from the indexer\'s own persisted value and Omnipool-claim snapshots, so this endpoint and the explorer cannot disagree by computing them twice, and the money-market slice REPLACES the pallet-side aToken rows rather than being added to them. Both snapshots are republished every few minutes; if one goes stale (older than 1 h) ITS fields are null — `lpUsd` null also drops LP out of `totalUsd`, and `debtUsd` null accompanies an absent money-market slice — rather than being served months out of date or faked as zero. A fresh snapshot in which the account holds nothing reports "0.00", so null and "0.00" are distinguishable.',
        'Staking-backed markets (GIGAHDX) are excluded from the SUPPLIED side: staking leaves the HDX in the holder\'s own balance, so counting the receipt as well would report the same money twice. Their debt is still counted — an account\'s obligations are one number even though the markets are isolated for health-factor purposes. Stableswap and XYK LP positions remain out of scope (spec "Semantics" rule 7).',
        'An account known only by its LP positions is included and reports `blockHeight` 0: the claim snapshot carries no block height of its own.',
        'An asset whose price feed has gone stale (no close within ~12 h of the price head) contributes nothing rather than being valued at an old price. Accounts with no indexed balances are absent from `items` — the response is never a 404.',
        'An EVM account and the AccountId32 it belongs to are ONE account, and both halves are always folded in. Two mappings are followed: the runtime\'s own AccountId32 → H160 truncation (its first 20 bytes), which is where every account\'s money-market state is filed whether or not it ever called `bind_evm_address`, and the explicit binding directory for an H160 whose trailing bytes the owner chose. Requesting both halves in one batch returns a row for each address, both carrying the same figures — index the response by `account`, and do not sum a batch\'s rows.',
      ].join('\n\n'),
      querystring: z.object({
        accounts: z.string().describe('Comma-separated lowercase hex account ids, 1 to 50.'),
      }),
      response: { 200: z.object({ items: z.array(zBalanceItem) }) },
    },
  }, async request => {
    const requested = csv(request.query.accounts)
    if (!requested.length) throw badRequest('accounts must list at least one account')
    if (requested.length > MAX_BALANCE_ACCOUNTS) {
      throw badRequest(`accounts accepts at most ${MAX_BALANCE_ACCOUNTS} accounts, got ${requested.length}`)
    }
    const parsed = z.array(zHexAddress).safeParse(requested)
    if (!parsed.success) throw badRequest('accounts must be 0x-prefixed 20- or 32-byte hex addresses')
    // Deduplicated and sorted, so the cache key is one entry per SET of accounts
    // however a caller happens to order or repeat them.
    const accounts = [...new Set(parsed.data)].sort()
    // Hashed rather than joined: a 50-account key would otherwise hold 3 kB of
    // address text per distinct batch in the process cache.
    const key = createHash('sha1').update(accounts.join(',')).digest('hex')
    const items = await cached(`pub:acct-bal:${key}`, 3_000, () => queryLatestBalances(opts.client, accounts))
    return { items }
  })

  app.get('/v1/accounts/:account/balance-history', {
    schema: {
      tags: ['accounts'],
      summary: 'Bucketed net-worth series for one account',
      description: [
        'Per-asset forward-fill of the hourly balance model, valued at each bucket\'s closed candle — never a future or current price (AGENTS.md). `timestamp` is the bucket CLOSE, and only fully closed buckets are emitted, so the series never ends on a partial figure.',
        'SCOPE — this series is NARROWER than GET /v1/accounts/balances and the two are not comparable. `transferableUsd` covers pallet-side balances only. Money-market supplied balances and the ERC-20-backed wallet pot are BOTH absent, because each exists only as a current-state snapshot with no per-bucket history; applying today\'s position to a past bucket would be the future-price mistake this endpoint otherwise avoids, so they are omitted rather than faked.',
        '`debtUsd` IS reconstructible per bucket and is reported, so for a leveraged account this series shows full debt against holdings that exclude the collateral backing it. `transferableUsd - debtUsd` is therefore NOT net worth. Debt is summed across the configured markets and is not netted out of `transferableUsd` (spec "Semantics" rule 7). LP and farm positions are omitted.',
        '`lockedUsd` is always "0.00": the historical balance models store only the TOTAL balance, so the whole pallet-side valued amount rides in `transferableUsd`. GET /v1/accounts/balances carries the current free/reserved split. An asset with no candle within 30 days of a bucket is treated as unpriced for that bucket and contributes nothing.',
        `Defaults to the most recent 168 hourly (or 90 daily) buckets. At most ${HISTORY_MAX_POINTS} points per request; a wider window is a 400, never a silently truncated series.`,
      ].join('\n\n'),
      params: zAccountParams,
      querystring: zHistoryQuery,
      response: {
        200: z.object({
          referenceCurrency: z.literal('usd'),
          items: z.array(zHistoryPoint),
        }),
      },
    },
  }, async request => {
    const { bucket } = request.query
    const grid = resolveHistoryGrid({ fromIso: request.query.from ?? null, toIso: request.query.to ?? null, bucket })
    if (grid.fromSeconds < 0 || grid.toSeconds < 0) throw badRequest('timestamps before 1970-01-01 are not supported')
    if (grid.points < 1) throw badRequest('from must be earlier than to')
    if (grid.points > HISTORY_MAX_POINTS) {
      throw badRequest(`the requested window is ${grid.points} ${bucket} buckets; at most ${HISTORY_MAX_POINTS} are served per request`)
    }
    // The grid is resolved ONCE and handed on as explicit bounds. Re-resolving it
    // inside the service would re-read the clock, so a request landing on a bucket
    // boundary could be served a grid its own cache key does not describe.
    const options = {
      fromIso: iso(grid.fromSeconds * 1000),
      toIso: iso(grid.toSeconds * 1000),
      bucket,
    }
    const key = `pub:acct-hist:${request.params.account}:${bucket}:${grid.fromSeconds}-${grid.toSeconds}`
    const items = await cachedSwr(key, 60_000, 300_000, () => queryBalanceHistory(opts.client, request.params.account, options))
    return { referenceCurrency: 'usd' as const, items }
  })

  app.get('/v1/accounts/:account/money-market-events', {
    schema: {
      tags: ['accounts'],
      summary: 'Money-market event history for one account',
      description: [
        'Newest first, from the account-first money-market activity model. `events` accepts the lowercase form of any published name; the response uses pascal case. The reserves\' own ERC-20 plumbing (Transfer, Approval, Mint, Burn) is never returned and never counted.',
        '`amount` is null for ReserveUsedAsCollateralEnabled/Disabled and UserEModeSet. For LiquidationCall it is the SEIZED COLLATERAL, which is the amount denominated in the same asset as `assetId`; the debt repaid is not published here (the raw event\'s `debtToCover` is in a different asset).',
        '`categoryId` is always null: the activity model carries no eMode category column, and the value survives only in the raw event\'s decoded arguments, which cannot be read per account within bounded cost.',
        '`search` matches asset symbols and names, then widens each match to the ids the market files rows under (aDOT resolves to the DOT reserve, GDOT to the 2-Pool-GDOT reserve). A term matching no asset returns no rows.',
        'The account may be given as either half of its identity. Money-market rows are filed under the EVM-side form of an account — the runtime\'s truncation of its AccountId32 — so both forms are read whichever one is asked about.',
      ].join('\n\n'),
      params: zAccountParams,
      querystring: zLimitOffset.extend({
        events: z.string().optional().describe('Comma-separated lowercase event names, e.g. supply,borrow. Defaults to all.'),
        search: z.string().optional().describe('Asset symbol or name substring.'),
      }),
      response: { 200: zPage(zMmEvent) },
    },
  }, async request => {
    const events: string[] = []
    for (const raw of csv(request.query.events)) {
      const name = mmEventName(raw)
      // An unrecognised name is a caller error, not a filter to drop: silently
      // ignoring it would answer a narrow request with a wide result.
      if (!name) throw badRequest(`unknown event '${raw}'; expected one of ${MM_EVENT_NAMES.map(n => n.toLowerCase()).join(', ')}`)
      events.push(name)
    }
    const search = request.query.search?.trim() ?? ''
    const { limit, offset } = request.query
    // Sorted and deduplicated: `events=borrow,supply` and `events=supply,borrow`
    // are one filter, so they must be one cache entry rather than two.
    const filterKey = [...new Set(events)].sort().join(',')
    const key = `pub:acct-mm:${request.params.account}:${filterKey}:${search}:${limit}:${offset}`
    return cached(key, 5_000, () => queryMoneyMarketEvents(opts.client, request.params.account, { events, search, limit, offset }))
  })
}
