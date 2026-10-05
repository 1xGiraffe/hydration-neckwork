import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import {
  accountFoldCoverage, accountUserRevenueBuckets, publicationGeneration, unmeasuredText, userRevenueBookingKey, userRevenueDayBuckets, userRevenueWindows, utcDay,
  type UserRevenueCoverage,
} from '../../services/userRevenueRead.ts'
import { HOLDER_CLASSES, USER_REVENUE_HOLLAR_ASSET_ID, USER_REVENUE_STREAM_IDS } from '../../services/userRevenueStreams.ts'
import { renderUsd } from '../../services/valuation.ts'
import { iso, zAccountRef, zError, zIsoTimestamp, zTimeParam } from '../schemas/common.ts'
import { accountRefFor, evmAccountForm } from '../services/address.ts'
import { resolveWindow } from '../services/statsData.ts'
import { requireParsedAddress, zAccountParams } from './accountsShared.ts'

// User Revenue: what users EARN on Hydration (net, accrual basis), from the
// derivations-built fold (services/userRevenueRead.ts — the read the explorer's
// /revenue page and the public /v1/stats/platform headline share).

const DAY_S = 86_400
const HOUR_S = 3_600

const SEMANTICS = 'User Revenue is what an account EARNS on Hydration, NET: LP fees its positions captured, liquidity-mining rewards, lending interest and incentives, yield-bearing token accrual, HDX staking (booked GROSS as it accrues: the payable share is decided at the claim or exit, where the unpaid part is booked as forfeited), GIGAHDX yield and voting rewards and referrer commissions, minus what it paid for them (borrow interest, LP exit and imbalance fees, forfeited staking rewards, farm termination write-downs) — negative amounts are costs. It is booked on an ACCRUAL basis: when the chain\'s own arithmetic says an amount is owed, never when it is claimed (a claim realizes, it is not income); referrer commissions are booked at claim time, as no per-trade event states them. Each amount is valued at the hourly candle closed at its hour. Trading P&L, impermanent loss, swap and network fees and liquidations are not User Revenue. It is NOT additive with /v1/stats/revenue (protocol revenue): an Omnipool fee\'s LP-retained part is user revenue while the protocol\'s part is protocol revenue.'

const CLASSES = 'Every fact carries `holderClass`: `user` (an ordinary account — what the headline "User Revenue" counts), `protocol` (the protocol\'s own balance sheet: pallet accounts after custody resolution, the Treasury and its pots, the HSM, the Aave collector, protocol-owned Omnipool shares) or `unattributed` (custody no user holds: the Omnipool hub-channel remainder, other chains\' sovereign accounts — sibling, child and the relay\'s `Parent` when untagged — and bridge custody accounts (`bridge-custody`: Snowbridge, the Wormhole relay), unrecorded GIGAHDX voting rewards, money-market rewards accrued to a custody contract no claimant can claim (`incentives-unclaimable`), rounding). Another chain\'s TREASURY (the Polkadot treasury\'s positions held by the relay\'s sovereign, Moonbeam\'s treasury) is an outside holder earning here: `user`. A `via` starting `catchup-spread` is yield that accrued while a token\'s on-chain rate sat flat for 14 days or more, spread over that stretch (stream `token_accrual_catchup`); a `via` starting `external-rate:<source>` is a token\'s accrual before its first on-chain rate, at a rate its issuer published (`external-rate:hastra-nav`: PRIME before 2026-02-19 at Hastra\'s NAV read from its Solana vault, anchored to end at Hydration\'s first PRIME rate) — sourced outside Hydration, not measured on it; zero-amount rows whose `via` is `unmeasured:<reason>` state a gap, not an amount, and are not listed here — `coverage.unmeasured` names them.'

const COVERAGE = 'Coverage: money-market streams start at block 8,200,000 (B0, 2025-07-04) and Omnipool LP fees at 2023-08-04; `coverage.unmeasured` names what is not measured at all. PRIME accrual before its first on-chain rate (2026-01-27 → 2026-02-19) is booked at its issuer\'s published NAV (`via` `external-rate:hastra-nav`). `unpricedCells` counts facts the fold booked but could not value — never valued as 0.'

const zCoverage = z.object({
  from: zIsoTimestamp.nullable().describe('Start of the first folded hour.'),
  complete: z.boolean().describe('No unfolded hour (or, for an account, no unpublished month) between the first and the newest.'),
  unmeasured: z.array(z.string()).describe('What User Revenue does not measure, stated rather than read as 0.'),
})

const HOLLAR_SLICE = `Borrow interest (\`mm_borrow_interest\`) covers every borrowed asset; its HOLLAR part — borrow interest on HOLLAR (asset ${USER_REVENUE_HOLLAR_ASSET_ID}) in every market, the explorer's "HOLLAR interest", the payer's side of protocol revenue's HOLLAR interest — is stated beside it as \`hollarInterest\` on each \`mm_borrow_interest\` item; the rest is the explorer's "Borrow interest".`

const zHolderClass = z.enum(HOLDER_CLASSES)

const zHollarInterest = z.object({
  earnedUsd: z.string().describe('Σ positive facts of the slice, USD, 2 decimals.'),
  paidUsd: z.string().describe('Σ negative facts of the slice (≤ 0), USD, 2 decimals.'),
  amountUsd: z.string().describe('Net of the slice, USD, 2 decimals; negative for a cost.'),
}).optional().describe(`\`mm_borrow_interest\` items only: the part that is borrow interest on HOLLAR (asset ${USER_REVENUE_HOLLAR_ASSET_ID}), in every market. Included in the item's own figures, never in addition to them.`)

const sliceOf = (r: { stream: string; hollar?: { earned: bigint; paid: bigint; net: bigint } }) =>
  r.stream === 'mm_borrow_interest' && r.hollar
    ? { hollarInterest: { earnedUsd: renderUsd(r.hollar.earned), paidUsd: renderUsd(r.hollar.paid), amountUsd: renderUsd(r.hollar.net) } }
    : {}
const zStream = z.enum(USER_REVENUE_STREAM_IDS as [string, ...string[]])

const isoOrNull = (seconds: number | null): string | null => (seconds == null ? null : iso(seconds * 1000))

/**
 * The read window of both User Revenue routes: whole UTC days from the start of `wFrom`'s day through the end of
 * `wTo`'s day (a `wTo` on midnight ends there), clamped to the account fold's cut, so `to` never passes
 * `publishedThrough`. A window that starts at or after the cut holds no folded day: it is EMPTY and is reported as
 * the empty interval AT the cut (`from` = `to` = the cut), never as a future day. With nothing published (no cut)
 * the window is the empty interval at its first day's start.
 */
export function dayWindowThroughCut(wFrom: number, wTo: number, cut: number | null): { from: number; to: number; fromDay: string; toDay: string } {
  const dayStart = Math.floor(wFrom / DAY_S) * DAY_S
  const from = cut != null && dayStart >= cut ? cut : dayStart
  const clampedTo = Math.max(from, Math.min(wTo, cut ?? from))
  const last = Math.max(from, clampedTo - 1)
  const to = Math.max(from, Math.min((Math.floor(last / DAY_S) + 1) * DAY_S, cut ?? from))
  return { from, to, fromDay: utcDay(from), toDay: utcDay(last) }
}

async function hourCoverage(client: ClickHouseClient): Promise<UserRevenueCoverage> {
  return (await userRevenueWindows(client)).coverage
}

/**
 * The earnings cache key: the window, the account fold's cut AND the publication
 * generation of the months the window covers (publicationGeneration), so a
 * rebuild turns the key over — one that moves the cut, and one at the same cut.
 */
export function earningsCacheKey(owner: string, bucket: string, fromDay: string, toDay: string, publishedThrough: number | null, generation: number): string {
  return `data:accounts:earnings:${owner}:${bucket}:${fromDay}:${toDay}:${publishedThrough ?? 0}:${generation}`
}

/** The global stats cache key, by the same rule. */
export function userRevenueStatsCacheKey(bucket: string, stream: string | undefined, holderClass: string | undefined, fromDay: string, toDay: string, to: number, generation: number): string {
  return `data:stats:user-revenue:${bucket}:${stream ?? ''}:${holderClass ?? ''}:${fromDay}:${toDay}:${to}:${generation}`
}

export const userRevenueRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/stats/user-revenue', {
    schema: {
      tags: ['stats'],
      summary: 'User Revenue per stream and holder class, day or month buckets',
      description: [
        SEMANTICS,
        CLASSES,
        HOLLAR_SLICE,
        'Each item is one (bucket, stream, holder class) over every account: `earnedUsd` sums the positive account-day facts, `paidUsd` the negative ones and `amountUsd` = earned + paid, so a signed stream (lending interest a wrapper\'s borrowers pay, a farm write-down) shows both sides instead of netting them away. Read from the account fold, which publishes CLOSED hours only — there is no raw tail: `publishedThrough` is the end of the last hour the account fold folded and the window is clamped to it, so a bucket reaching past it is partial (the current day or month). A bucket the window\'s start cuts is partial too (buckets are whole UTC days).',
        'Window: default the last 30 days (`bucket=day`, at most 366 days) or 365 days (`bucket=month`, at most 1900); `stream=` and `class=` narrow the read. The facts are whole UTC days, so the window read is widened to whole days — from the start of `fromTime`\'s UTC day through the END of `toTime`\'s UTC day (a `toTime` on midnight ends there), then clamped to `publishedThrough` — and `from`/`to` report that window: an intra-day `toTime` includes the rest of its day.',
        COVERAGE,
      ].join('\n\n'),
      querystring: z.object({
        bucket: z.enum(['day', 'month']).default('day').describe('UTC days, or calendar months.'),
        stream: zStream.optional(),
        class: zHolderClass.optional().describe('Holder class; omitted returns all three.'),
        fromTime: zTimeParam.optional(),
        toTime: zTimeParam.optional(),
      }),
      response: {
        200: z.object({
          bucket: z.enum(['day', 'month']),
          from: zIsoTimestamp.describe('Start of the first UTC day read; `publishedThrough` for an empty window that starts at or after it.'),
          to: zIsoTimestamp.describe('The end of the window actually read: the end of `toTime`\'s UTC day, clamped to `publishedThrough` (never past it); equal to `from` for an empty window.'),
          publishedThrough: zIsoTimestamp.nullable().describe('End of the last hour the account fold folded (the source of these items); null while nothing is published.'),
          coverage: zCoverage,
          items: z.array(z.object({
            bucket: zIsoTimestamp.describe('The bucket start.'),
            stream: z.string(),
            holderClass: zHolderClass,
            earnedUsd: z.string().describe('Σ positive account-day facts, USD, 2 decimals.'),
            paidUsd: z.string().describe('Σ negative account-day facts (≤ 0), USD, 2 decimals.'),
            amountUsd: z.string().describe('Net = earned + paid, USD, 2 decimals; negative for a cost.'),
            unpricedCells: z.number().int(),
            hollarInterest: zHollarInterest,
          })),
        }),
        400: zError,
      },
    },
  }, async request => {
    const { bucket, stream } = request.query
    const holderClass = request.query.class
    const window = resolveWindow(request.query.fromTime, request.query.toTime,
      bucket === 'day' ? 30 * DAY_S : 365 * DAY_S, bucket === 'day' ? 366 * DAY_S : 1900 * DAY_S, 'user-revenue', HOUR_S)
    const [coverage, account] = await Promise.all([hourCoverage(opts.client), accountFoldCoverage(opts.client)])
    const cut = account.publishedThrough
    // The fold's facts are whole UTC days, so the window read is whole days,
    // clamped to the cut — and `from`/`to` report THAT window, never an intra-day
    // toTime the day buckets cannot honour (dayWindowThroughCut). A closed-hour
    // source: the clamped window and a plain TTL, never the head.
    const { from, to, fromDay, toDay } = dayWindowThroughCut(window.from, window.to, cut)
    const key = userRevenueStatsCacheKey(bucket, stream, holderClass, fromDay, toDay, to, publicationGeneration(account, fromDay, toDay))
    const rows = to > from
      ? await cached(key, 300_000, () => userRevenueDayBuckets(opts.client, { grain: bucket, fromDay, toDay, stream, holderClass, hollarSlice: true }))
      : []
    return {
      bucket,
      from: iso(from * 1000),
      to: iso(to * 1000),
      publishedThrough: isoOrNull(cut),
      coverage: { from: isoOrNull(coverage.firstHour), complete: coverage.complete && account.complete, unmeasured: coverage.unmeasured.map(unmeasuredText) },
      items: rows.map(r => ({
        bucket: iso(r.t * 1000), stream: r.stream, holderClass: r.holderClass,
        earnedUsd: renderUsd(r.earned), paidUsd: renderUsd(r.paid), amountUsd: renderUsd(r.net), unpricedCells: r.unpriced,
        ...sliceOf(r),
      })),
    }
  })

  app.get('/v1/accounts/:address/earnings', {
    schema: {
      tags: ['accounts'],
      summary: 'User Revenue the account earned, by stream, day or month',
      description: [
        SEMANTICS,
        'This is the account\'s own INCOME — the opposite direction of /v1/accounts/{address}/fees, which is the protocol\'s revenue FROM the account. Facts under the account\'s native and ETH-mapped identities (its money-market holdings are filed under the latter) are combined. An EVM address a substrate account has bound (`EVMAccounts.Bound`) is booked under that account, so asking for the bound address reads the owner\'s earnings and `bookedUnder` names the owner; proxies and other related accounts are never added.',
        `${CLASSES} An account's facts carry ITS class after custody resolution: an ordinary account's are \`user\`, a protocol account's \`protocol\`.`,
        HOLLAR_SLICE,
        '`earnedUsd` sums the account\'s positive day facts and `paidUsd` its negative ones, so `amountUsd` = earned + paid. Buckets are UTC days or calendar months. The account facts are rebuilt per month; the current month is folded through `publishedThrough` (the account fold\'s cut, at most about an hour behind the hourly fold\'s) and the window is clamped to it (`to` never passes it; a window starting at or after it is empty and reported as `from` = `to` = `publishedThrough`), and `coverage.complete` is false while a month since the first one is not yet published — rows are still returned.',
        'Window: default the last 30 days (`bucket=day`, at most 366 days) or 365 days (`bucket=month`, at most 1900). The facts are whole UTC days, so the window read is widened to whole days — from the start of `fromTime`\'s UTC day through the END of `toTime`\'s UTC day (a `toTime` on midnight ends there) — and `from`/`to` report that window: an intra-day `toTime` includes the rest of its day. Facts past `publishedThrough` are not folded yet.',
        COVERAGE,
        'A valid address the index has never seen answers 200 with empty items (404 is reserved for single resources).',
      ].join('\n\n'),
      params: zAccountParams,
      querystring: z.object({
        bucket: z.enum(['day', 'month']).default('day'),
        fromTime: zTimeParam.optional(),
        toTime: zTimeParam.optional(),
      }),
      response: {
        200: z.object({
          account: zAccountRef,
          bookedUnder: zAccountRef.describe('The account the facts are booked under: the bound substrate owner for a bound EVM address, else `account` itself.'),
          bucket: z.enum(['day', 'month']),
          from: zIsoTimestamp.describe('Start of the first UTC day in the window; `publishedThrough` for an empty window that starts at or after it.'),
          to: zIsoTimestamp.describe('End of the last UTC day in the window, clamped to `publishedThrough` (never past it); equal to `from` for an empty window.'),
          publishedThrough: zIsoTimestamp.nullable().describe('End of the last hour the account fold folded: the items are "through" it.'),
          coverage: zCoverage,
          items: z.array(z.object({
            bucket: zIsoTimestamp.describe('The bucket start.'),
            stream: z.string(),
            holderClass: zHolderClass,
            earnedUsd: z.string().describe('Σ positive day facts, USD, 2 decimals.'),
            paidUsd: z.string().describe('Σ negative day facts (≤ 0), USD, 2 decimals.'),
            amountUsd: z.string().describe('Net = earned + paid, USD, 2 decimals.'),
            unpricedCells: z.number().int(),
            hollarInterest: zHollarInterest,
          })),
        }),
        400: zError,
      },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    const { bucket } = request.query
    const window = resolveWindow(request.query.fromTime, request.query.toTime,
      bucket === 'day' ? 30 * DAY_S : 365 * DAY_S, bucket === 'day' ? 366 * DAY_S : 1900 * DAY_S, 'earnings', HOUR_S)
    const [hours, accountCoverage, owner] = await Promise.all([
      hourCoverage(opts.client), accountFoldCoverage(opts.client), userRevenueBookingKey(opts.client, parsed.accountId),
    ])
    // The same window rule as /v1/stats/user-revenue: whole UTC days from fromTime's day, clamped to the account
    // fold's cut — `to` never reports a day the fold has not published (a bucket reaching the cut is partial).
    const cut = accountCoverage.publishedThrough
    const { from, to, fromDay, toDay } = dayWindowThroughCut(window.from, window.to, cut)
    const ownerParsed = owner === parsed.accountId ? parsed : { ...parsed, accountId: owner }
    const identities = [...new Set([owner, evmAccountForm(ownerParsed)])]
    // Day-grain facts rebuilt about hourly: keyed on the window, the account fold's cut and the covered months'
    // publication generation, so a rebuild turns the key over — at a new cut or at the same one.
    const key = earningsCacheKey(owner, bucket, fromDay, toDay, accountCoverage.publishedThrough, publicationGeneration(accountCoverage, fromDay, toDay))
    const rows = to > from ? await cached(key, 300_000, () => accountUserRevenueBuckets(opts.client, identities, { grain: bucket, fromDay, toDay, hollarSlice: true })) : []
    return {
      account: accountRefFor(parsed.accountId),
      bookedUnder: accountRefFor(owner),
      bucket,
      from: iso(from * 1000),
      to: iso(to * 1000),
      publishedThrough: isoOrNull(cut),
      coverage: {
        from: accountCoverage.firstMonth == null ? null : iso(Date.UTC(Math.floor(accountCoverage.firstMonth / 100), (accountCoverage.firstMonth % 100) - 1, 1)),
        complete: accountCoverage.complete,
        unmeasured: hours.unmeasured.map(unmeasuredText),
      },
      items: rows.map(r => ({
        bucket: iso(r.t * 1000),
        stream: r.stream,
        holderClass: r.holderClass,
        earnedUsd: renderUsd(r.earned),
        paidUsd: renderUsd(r.paid),
        amountUsd: renderUsd(r.net),
        unpricedCells: r.unpriced,
        ...sliceOf(r),
      })),
    }
  })
}
