// User Revenue — yield-bearing tokens (D1 token_accrual, token_accrual_catchup).
//
// A redemption-rate token earns its holder units × Δrate in its underlying. The
// rate is the token's on-chain peg in the stableswap pool that pegs it against
// the underlying (stableswap_pool_state_history, the 600-block grid): the
// token's peg multiplier over the underlying leg's, both rationals. Exposure is
// every account's wallet balance of the token at the hour's start; the custodies
// pass it on — a stableswap pool's balance to its share holders, the Omnipool's
// by the A1 capture rule, an aToken contract's (avDOT holds vDOT, BIL's aToken
// holds uBIL) by the claims rule (suppliers +, borrowers −) — so a supplied or
// pooled token is counted once, at its leaf. aTokens are never here (their
// interest is C1).
//
// Before a token's first peg row the issuer's own published rate can stand in
// (EXTERNAL_RATES: PRIME's Hastra NAV, read from its Solana vault): its stretches
// are 'external' segments anchored to end exactly at the first peg row, booked
// as token_accrual via 'external-rate:<source>' — sourced, labelled, never mixed
// with the chain's own peg.
//
// Accrual WHEN EARNED (userRevenueMath.pegSegments): a move's rise accrued over
// the interval since the previous move and is spread evenly over it, to the
// holders of each hour in it. A stalled oracle's catch-up — a rate-limited ramp
// after a flat stretch — is one segment over the stretch it ends; when the
// stretch was ≥ 14 days the segment is token_accrual_catchup, via
// 'catchup-spread'. Re-encoding noise (< 1e-9 relative) is no move. What the fold
// cannot measure is stated per (hour, token) as a zero-amount marker row whose
// via is 'unmeasured:<reason>' — while anyone holds the token:
//   peg-pending       after the last decided move (the rise lands when the next move decides it);
//   peg-gave-back     a move ending > 1 % under the trailing 30-day high (a relayed price);
//   peg-jump          a stretch implying > 50 % APR either way (judged over ≥ 1 day), or ending
//                     within a day of a give-back or such a jump (a price relay, wstETH July 2025);
//   under-high-water  a measured stretch ending at or under the rate's high-water mark: it books 0;
//   peg-source-changed  from a peg source's last move to the first row of the source replacing it
//                     (PoolPegSourceUpdated: vDOT 2025-12-19, wstETH 2025-07-11); each source is judged alone;
//   peg-never-moved   apyUSD: a static governance push;
//   no-rate-yet       before the token's first peg row (vDOT before pool 690) and before any EXTERNAL_RATES
//                     series for it;
//   no-rate-indexed   vASTR, LDOT, LBTC, sUSDat: no on-chain rate is indexed.

import type { ClickHouseClient } from '../db/client.ts'
import { chTimestamp } from './clickhouseTime.ts'
import { assetDecimalsOrNull } from './explorerAssets.ts'
import { HOUR, userRevenueRows as rows, type FoldWindow, type Ledger } from './userRevenueFold.ts'
import { BalanceBook, LedgerMap } from './userRevenueLp.ts'
import { PEG_OPEN_END, pegSegmentBooks, pegSegmentHash, pegSegments, segmentRiseIn, type PegPoint, type PegSegment, type PegSegmentKind } from './userRevenueMath.ts'

export interface AccruingToken {
  /** The registry asset holders hold (uBIL is held as an ERC-20). */
  token: number
  pool: number
  underlying: number
  underlyingLeg: number
  /** The pool leg carrying the token's peg when it is not the token itself (BIL — uBIL's aToken, 1:1 — for uBIL). */
  pegLeg?: number
  /** Further registry assets of the same token earning the same rate (native sUSDS beside the Wormhole one). */
  alsoHeld?: readonly number[]
  erc20?: string
}

/** The redemption-rate tokens and the pool pegging each against its underlying (the design's measured table). */
export const ACCRUING_TOKENS: readonly AccruingToken[] = [
  { token: 15, pool: 690, underlying: 5, underlyingLeg: 1001 },          // vDOT / aDOT (DOT)
  { token: 1000809, pool: 4200, underlying: 34, underlyingLeg: 1007 },   // wstETH / aETH (ETH)
  { token: 40, pool: 90001, underlying: 1000752, underlyingLeg: 1009 },  // jitoSOL / aSOL (SOL)
  { token: 43, pool: 143, underlying: 222, underlyingLeg: 222 },         // PRIME / HOLLAR
  { token: 1000745, pool: 112, underlying: 222, underlyingLeg: 222, alsoHeld: [1000626] }, // sUSDS (Wormhole; native 1000626) / HOLLAR
  { token: 1000625, pool: 113, underlying: 222, underlyingLeg: 222 },    // sUSDe / HOLLAR
  { token: 550, pool: 10055, underlying: 222, underlyingLeg: 222, pegLeg: 55, erc20: '0x6a21891db0940491603f3cca0a9f4dba4c6e810c' }, // uBIL (BIL's reserve; pegged as BIL) / HOLLAR
  { token: 46, pool: 146, underlying: 222, underlyingLeg: 222 },         // apyUSD / HOLLAR (frozen peg: unmeasured)
]

/** Accruing tokens with no indexed on-chain rate: unmeasured while held (vASTR, LDOT, LBTC, sUSDat). */
export const UNRATED_ACCRUING_TOKENS: readonly number[] = [33, 1000100, 1000851, 45]

/** Every substrate asset whose balances the token stream reads (the 'tok:' anchor pots). */
export const TOKEN_BALANCE_ASSETS: readonly number[] = [
  ...ACCRUING_TOKENS.filter(t => !t.erc20).flatMap(t => [t.token, ...(t.alsoHeld ?? [])]),
  ...UNRATED_ACCRUING_TOKENS,
]

export const CATCHUP_VIA = 'catchup-spread'

/** The `unmeasured:<reason>` a non-booking segment kind marks its hours with. */
export const pegUnmeasuredReason = (kind: PegSegmentKind): string => (kind === 'under-high-water' ? 'under-high-water' : `peg-${kind}`)
// 'source-changed' marks 'unmeasured:peg-source-changed': the old source's last move to the new source's first row.

const RATE_ONE = 10n ** 36n

/** A pool's peg configuration changes (stableswap_pool_params): source changes per asset and the peg cap in force. */
export interface PegParams {
  /** Per pool asset, the blocks of its PoolPegSourceUpdated events, ascending. */
  sourceChanges: Map<number, number[]>
  /** The pool's maxPegUpdate (Perbill per block) from each block on, ascending: PoolCreated, then PoolMaxPegUpdateUpdated. */
  caps: Array<{ fromBlock: number; perbill: number }>
}

/** Every accruing-token pool's peg source changes and cap history, from its PoolCreated / param events. */
export async function loadPegParams(client: ClickHouseClient): Promise<Map<number, PegParams>> {
  const pools = [...new Set(ACCRUING_TOKENS.map(t => t.pool))]
  const got = await rows<{ p: string; b: string; e: string; a: string }>(client, `
    SELECT pool_id AS p, block_height AS b, event_name AS e, args_json AS a FROM price_data.stableswap_pool_params FINAL
    WHERE pool_id IN {pools:Array(UInt32)}
      AND event_name IN ('Stableswap.PoolCreated', 'Stableswap.PoolPegSourceUpdated', 'Stableswap.PoolMaxPegUpdateUpdated')
    ORDER BY block_height, event_index`, { pools }, 'ur:token-peg-params')
  return pegParamsFromEvents(got.map(r => ({ pool: Number(r.p), block: Number(r.b), event: r.e, args: r.a })))
}

/** The pure part of loadPegParams (pinned by the tests). */
export function pegParamsFromEvents(events: ReadonlyArray<{ pool: number; block: number; event: string; args: string }>): Map<number, PegParams> {
  const out = new Map<number, PegParams>()
  const of = (pool: number) => { let v = out.get(pool); if (!v) { v = { sourceChanges: new Map(), caps: [] }; out.set(pool, v) } return v }
  for (const e of events) {
    let args: Record<string, unknown>
    try { args = JSON.parse(e.args) as Record<string, unknown> } catch { continue }
    const p = of(e.pool)
    if (e.event === 'Stableswap.PoolCreated') {
      const cap = Number((args.peg as { maxPegUpdate?: unknown } | undefined)?.maxPegUpdate)
      if (Number.isFinite(cap)) p.caps.push({ fromBlock: e.block, perbill: cap })
    } else if (e.event === 'Stableswap.PoolMaxPegUpdateUpdated') {
      const cap = Number(args.maxPegUpdate)
      if (Number.isFinite(cap)) p.caps.push({ fromBlock: e.block, perbill: cap })
    } else if (e.event === 'Stableswap.PoolPegSourceUpdated') {
      const asset = Number(args.assetId)
      const list = p.sourceChanges.get(asset) ?? []
      list.push(e.block)
      p.sourceChanges.set(asset, list)
    }
  }
  return out
}

/**
 * Every accruing token's peg grid, its whole history (a later move decides how earlier hours accrued). Each point
 * carries its row's block, the peg source it was read under (the newest PoolPegSourceUpdated, at or before the row,
 * of either leg the rate is the ratio of; a row at the event's block or later reads the new source) and the pool's
 * peg cap in force — pegSegments splits at a source change and reads the cap as the pallet's rate limit.
 */
export async function loadPegGrid(client: ClickHouseClient): Promise<Map<number, PegPoint[]>> {
  const pools = [...new Set(ACCRUING_TOKENS.map(t => t.pool))]
  const [grid, params] = await Promise.all([
    rows<{ p: string; b: string; ts: string; ids: string[]; pn: string[]; pd: string[] }>(client, `
      SELECT pool_id AS p, block_height AS b, toUnixTimestamp(any(block_timestamp)) AS ts, argMax(asset_ids, ingested_at) AS ids,
             argMax(peg_num, ingested_at) AS pn, argMax(peg_den, ingested_at) AS pd
      FROM price_data.stableswap_pool_state_history
      WHERE pool_id IN {pools:Array(UInt32)} AND notEmpty(peg_num)
      GROUP BY p, b ORDER BY p, b`, { pools }, 'ur:token-pegs'),
    loadPegParams(client),
  ])
  return pegGridFromRows(grid.map(r => ({ pool: Number(r.p), block: Number(r.b), ts: Number(r.ts), ids: r.ids.map(Number), pn: r.pn, pd: r.pd })), params)
}

/** The pure part of loadPegGrid (pinned by the tests). */
export function pegGridFromRows(
  grid: ReadonlyArray<{ pool: number; block: number; ts: number; ids: number[]; pn: string[]; pd: string[] }>,
  params: ReadonlyMap<number, PegParams>,
): Map<number, PegPoint[]> {
  const out = new Map<number, PegPoint[]>()
  for (const t of ACCRUING_TOKENS) {
    const leg = t.pegLeg ?? t.token
    const pp = params.get(t.pool)
    const changes = [...(pp?.sourceChanges.get(leg) ?? []), ...(pp?.sourceChanges.get(t.underlyingLeg) ?? [])].sort((x, y) => x - y)
    const caps = pp?.caps ?? []
    const points: PegPoint[] = []
    let ci = -1
    let ki = -1
    for (const r of grid) {
      if (r.pool !== t.pool) continue
      const i = r.ids.indexOf(leg)
      const j = r.ids.indexOf(t.underlyingLeg)
      if (i < 0 || j < 0) continue
      const ni = BigInt(r.pn[i] || '0'), di = BigInt(r.pd[i] || '0'), nj = BigInt(r.pn[j] || '0'), dj = BigInt(r.pd[j] || '0')
      if (di === 0n || nj === 0n || dj === 0n) continue
      while (ci + 1 < changes.length && changes[ci + 1] <= r.block) ci++
      while (ki + 1 < caps.length && caps[ki + 1].fromBlock <= r.block) ki++
      const point: PegPoint = { ts: r.ts, rate: (ni * dj * RATE_ONE) / (di * nj), block: r.block }
      if (ci >= 0) point.source = changes[ci]
      if (ki >= 0) point.cap = caps[ki].perbill
      points.push(point)
    }
    out.set(t.token, points)
  }
  return out
}

/**
 * A token's redemption rate as its issuer publishes it, for the stretch BEFORE
 * the token's first on-chain peg row — sourced data, pinned here because it is
 * history that no longer changes. `points` are [unix seconds, NAV × 10^8] in
 * time order; between two points the NAV is linear in time. The series is read
 * as a SHAPE only: anchorExternalRate scales it so it ends exactly at the first
 * peg row's rate (the peg is the chain's own, typically lagging, reading of the
 * same NAV), so the two never overlap and nothing is booked twice.
 */
export interface ExternalRate { token: number; via: string; points: ReadonlyArray<readonly [number, bigint]> }

/** The booking label prefix of a fact whose rate came from outside the chain (EXTERNAL_RATES). */
export const EXTERNAL_RATE_VIA_PREFIX = 'external-rate:'
export const isExternalRateVia = (seg: string): boolean => seg.startsWith(EXTERNAL_RATE_VIA_PREFIX)

/**
 * PRIME (43) before pool 143's first peg row (2026-02-19 16:30 UTC, block 11,434,800): Hastra's NAV —
 * wYLDS (1:1 USDC) per PRIME — as its Solana staking vault (FvkbfMm98jefJWrqkvXvsSZ9RFaRBae8k6c1jaYA5vY3,
 * mint 3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7) priced its own deposits and redemptions: each point is
 * one such transaction's Δvault wYLDS ÷ ΔPRIME minted or burned (the largest of its UTC day). The vault
 * publishes rewards hourly, so the NAV is a step a few 1e-6 high an hour; linear between daily points.
 */
export const PRIME_HASTRA_NAV: ExternalRate = {
  token: 43,
  via: `${EXTERNAL_RATE_VIA_PREFIX}hastra-nav`,
  points: [
    [1768958629, 101336207n], // 2026-01-21 01:23
    [1769043152, 101357497n], // 2026-01-22 00:52
    [1769259039, 101413069n], // 2026-01-24 12:50
    [1769423282, 101455679n], // 2026-01-26 10:28
    [1769496522, 101474209n], // 2026-01-27 06:48
    [1769563722, 101491819n], // 2026-01-28 01:28
    [1769779493, 101546542n], // 2026-01-30 13:24
    [1769977400, 101597574n], // 2026-02-01 20:23
    [1770281880, 101675576n], // 2026-02-05 08:58
    [1770369470, 101696590n], // 2026-02-06 09:17
    [1770422450, 101710525n], // 2026-02-07 00:00
    [1770519751, 101735610n], // 2026-02-08 03:02
    [1770674984, 101775577n], // 2026-02-09 22:09
    [1770747307, 101793242n], // 2026-02-10 18:15
    [1770822386, 101812714n], // 2026-02-11 15:06
    [1770930661, 101840616n], // 2026-02-12 21:11
    [1770945280, 101844336n], // 2026-02-13 01:14
    [1771048930, 101873678n], // 2026-02-14 06:02
    [1771130268, 101895082n], // 2026-02-15 04:37
    [1771254366, 101926738n], // 2026-02-16 15:06
    [1771292332, 101936981n], // 2026-02-17 01:38
    [1771423900, 101970492n], // 2026-02-18 14:11
    [1771467640, 101982604n], // 2026-02-19 02:20
    [1771621236, 102021727n], // 2026-02-20 21:00
    [1771677038, 102036638n], // 2026-02-21 12:30
  ],
}

export const EXTERNAL_RATES: readonly ExternalRate[] = [PRIME_HASTRA_NAV]

/**
 * The 'external' segments of a series before `first` (the token's first peg row): one per stretch between
 * points, the last cut at first.ts, each rise in the peg's rate scale with the series anchored so the last
 * segment ends exactly at first.rate (rate(t) = first.rate × nav(t) / nav(first.ts)). The rises telescope:
 * they sum to first.rate − rate(series start). None when the series does not reach the first peg row (it
 * would leave an unbooked gap) or no peg row exists.
 */
export function externalSegments(ext: ExternalRate, first: PegPoint | undefined): PegSegment[] {
  if (!first) return []
  const pts = ext.points.filter(([t]) => Number.isFinite(t)).map(([t, v]) => [t, v] as const)
  if (pts.length < 2 || pts[0][0] >= first.ts || pts.at(-1)![0] < first.ts) return []
  const SCALE = 10n ** 12n
  const navAt = (t: number): bigint => {
    let i = 0
    while (i + 2 < pts.length && pts[i + 1][0] <= t) i++
    const [t0, v0] = pts[i]
    const [t1, v1] = pts[i + 1]
    const c = Math.min(Math.max(t - t0, 0), t1 - t0)
    return v0 * SCALE + ((v1 - v0) * SCALE * BigInt(c)) / BigInt(Math.max(1, t1 - t0))
  }
  const anchor = navAt(first.ts)
  if (anchor <= 0n) return []
  const rateAt = (t: number): bigint => (t >= first.ts ? first.rate : (first.rate * navAt(t)) / anchor)
  const cuts = [...pts.map(([t]) => t).filter(t => t < first.ts), first.ts]
  const out: PegSegment[] = []
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]]
    if (b <= a) continue
    out.push({ startTs: a, endTs: b, rise: rateAt(b) - rateAt(a), kind: 'external', moves: 0, via: ext.via })
  }
  return out
}

/** Every accruing token's booking segments: its external stretches (EXTERNAL_RATES) before its own peg's segments. */
export function tokenSegments(grid: ReadonlyMap<number, readonly PegPoint[]>, external: readonly ExternalRate[] = EXTERNAL_RATES): Map<number, PegSegment[]> {
  return new Map([...grid].map(([token, points]) => [token, [
    ...external.filter(e => e.token === token).flatMap(e => externalSegments(e, points[0])),
    ...pegSegments(points),
  ]]))
}

/**
 * Per bucket [from, to): the XOR of the identities of the segments overlapping
 * it — the token stream's input a bucket's facts depend on beyond its own
 * sources (a later move decides how an earlier hour accrued). Folded into the
 * bucket's registry_fp, so a decided segment re-marks exactly its hours.
 */
export function pegBucketFingerprints(segments: ReadonlyMap<number, readonly PegSegment[]>, buckets: ReadonlyArray<readonly [number, number]>): bigint[] {
  const out = buckets.map(() => 0n)
  for (const [token, segs] of segments) {
    for (const seg of segs) {
      const h = pegSegmentHash(token, seg)
      for (let i = 0; i < buckets.length; i++) {
        const [from, to] = buckets[i]
        if (seg.startTs < to && seg.endTs > from) out[i] ^= h
      }
    }
  }
  return out
}

export interface TokenMarker { h: number; token: number; reason: string }

export async function buildTokenAccrual(
  w: FoldWindow, segments: ReadonlyMap<number, readonly PegSegment[]>, grid: ReadonlyMap<number, readonly PegPoint[]>,
  balances: BalanceBook, erc20: ReadonlyMap<string, BalanceBook>, accountOf: (h160: string) => string,
): Promise<{ ledgers: Ledger[]; markers: TokenMarker[]; unmeasured: Array<{ token: number; reason: string }> }> {
  const out = new LedgerMap(w.hours)
  const markers: TokenMarker[] = []
  const unmeasured = new Map<string, { token: number; reason: string }>()
  const mark = (h: number, token: number, reason: string) => { markers.push({ h, token, reason }); unmeasured.set(`${token}|${reason}`, { token, reason }) }
  const hourStartBlock = (h: number) => (h === 0 ? w.openBlock : w.hourBlocks[h - 1].last)

  for (const t of ACCRUING_TOKENS) {
    const segs = segments.get(t.token) ?? []
    // A rate is known from the token's first peg row, or from the start of an external series before it.
    const firstTs = Math.min(grid.get(t.token)?.[0]?.ts ?? PEG_OPEN_END, ...segs.filter(sg => sg.kind === 'external').map(sg => sg.startTs))
    const neverMoved = segs.length === 1 && segs[0].kind === 'pending' && segs[0].moves === 0
    const du = assetDecimalsOrNull(t.underlying)
    const book = t.erc20 ? erc20.get(t.erc20) : null
    const held = [t.token, ...(t.alsoHeld ?? [])]
    const cursors = held.map(a => ({ asset: a, cursor: book ? book.cursor(a) : balances.cursor(a), dt: assetDecimalsOrNull(a) }))
    let si = 0
    for (let h = 0; h < w.hours; h++) {
      const hs = w.fromHour + h * HOUR
      const he = hs + HOUR
      for (const c of cursors) c.cursor.advanceTo(hourStartBlock(h))
      let heldNow = false
      for (const c of cursors) { for (const [, u] of c.cursor.holders()) if (u > 0n) { heldNow = true; break } if (heldNow) break }
      if (!heldNow) continue
      // The decided rises inside the hour, per booking key; the unmeasured reasons touching it.
      while (si < segs.length && segs[si].endTs <= hs) si++
      const rises = new Map<string, { stream: string; via: string; delta: bigint }>()
      const reasons = new Set<string>()
      if (hs < firstTs) reasons.add('no-rate-yet')
      for (let k = si; k < segs.length && segs[k].startTs < he; k++) {
        const seg = segs[k]
        if (pegSegmentBooks(seg.kind)) {
          const d = segmentRiseIn(seg, hs, he)
          if (d === 0n) continue
          const stream = seg.kind === 'catchup' ? 'token_accrual_catchup' : 'token_accrual'
          const via = seg.kind === 'catchup' ? CATCHUP_VIA : seg.kind === 'external' ? (seg.via ?? `${EXTERNAL_RATE_VIA_PREFIX}unknown`) : ''
          const key = `${stream}|${via}`
          const r = rises.get(key) ?? { stream, via, delta: 0n }
          r.delta += d
          rises.set(key, r)
        } else {
          reasons.add(seg.kind === 'pending' && neverMoved ? 'peg-never-moved' : pegUnmeasuredReason(seg.kind))
        }
      }
      if (du == null) reasons.add('decimals-unknown')
      for (const reason of reasons) mark(h, t.token, reason)
      if (du == null) continue
      for (const { stream, via, delta } of rises.values()) {
        for (const c of cursors) {
          if (c.dt == null) continue
          const scaleNum = 10n ** BigInt(du)
          const scaleDen = 10n ** BigInt(c.dt) * RATE_ONE
          for (const [holder, units] of c.cursor.holders()) {
            const amount = (units * delta * scaleNum) / scaleDen
            if (amount !== 0n) out.add(book ? accountOf(holder) : holder, stream, `token:${t.token}`, via, t.underlying, c.asset, 'accrual', h, amount, units)
          }
        }
      }
    }
  }
  // Accruing tokens no rate is indexed for: unmeasured while anyone holds them.
  for (const token of UNRATED_ACCRUING_TOKENS) {
    const cursor = balances.cursor(token)
    for (let h = 0; h < w.hours; h++) {
      cursor.advanceTo(hourStartBlock(h))
      for (const [, u] of cursor.holders()) if (u > 0n) { mark(h, token, 'no-rate-indexed'); break }
    }
  }
  return { ledgers: out.ledgers(), markers, unmeasured: [...unmeasured.values()] }
}

/** The anchor pot carrying a contract-backed token's holder balances at the anchor block (`erc20:<contract>`, holder = H160). */
export const erc20CheckpointPot = (contract: string): string => `erc20:${contract}`
/** The anchor marker row's exposure_id stating the ERC-20 checkpoints are in it (pot CHECKPOINT_POT). */
export const ERC20_CHECKPOINT_MARK = 'erc20'

/** The ERC-20 checkpoint a window opens from: the holders' balances at `block` (the month anchor's) and its month start. */
export interface Erc20Checkpoint { block: number; monthStart: number; balances: ReadonlyMap<string, bigint> }

/**
 * ERC-20 balances of a contract-backed token over the window
 * (erc20_transfer_deltas), as a BalanceBook keyed by holder H160. With a
 * checkpoint (the month anchor's holder balances) only the deltas after its
 * block are read; without one, every delta from the contract's first.
 */
export async function loadErc20Book(client: ClickHouseClient, w: FoldWindow, contract: string, asset: number, ckpt: Erc20Checkpoint | null = null): Promise<BalanceBook> {
  const book = new BalanceBook()
  book.opening.set(asset, new Map())
  book.changes.set(asset, [])
  // A block after the anchor block is at or after the month start (the anchor is the last block before it),
  // so the timestamp bound only prunes partitions; block_height is the exact cut.
  const got = await rows<{ h: string; b: string; d: string }>(client, `
    SELECT holder AS h, block_height AS b, toString(sum(dd)) AS d FROM (
      SELECT holder, block_height, event_index, leg_index, argMax(balance_delta, ingested_at) AS dd
      FROM price_data.erc20_transfer_deltas
      WHERE contract_address = {c:String} AND block_height <= {hi:UInt32}
        AND block_height > {lo:UInt32} AND block_timestamp >= {fromTs:DateTime}
      GROUP BY holder, block_height, event_index, leg_index)
    GROUP BY h, b ORDER BY b`,
  { c: contract, hi: w.lastBlock, lo: ckpt?.block ?? 0, fromTs: chTimestamp(ckpt ? ckpt.monthStart - HOUR : 0) }, 'ur:token-erc20')
  const running = new Map<string, bigint>(ckpt?.balances ?? [])
  for (const [h, v] of running) book.opening.get(asset)!.set(h, v)
  for (const r of got) {
    const b = Number(r.b)
    const v = (running.get(r.h) ?? 0n) + BigInt(r.d)
    running.set(r.h, v)
    if (b <= w.openBlock) book.opening.get(asset)!.set(r.h, v)
    else book.changes.get(asset)!.push({ block: b, account: r.h, units: v })
  }
  return book
}

/** A contract-backed token's holder balances at the window's end, every non-zero one (the next anchor's checkpoint). */
export function erc20Closing(book: BalanceBook, asset: number): Map<string, bigint> {
  const c = book.cursor(asset)
  c.advanceTo(Number.MAX_SAFE_INTEGER)
  return new Map([...c.balances].filter(([, v]) => v !== 0n))
}
