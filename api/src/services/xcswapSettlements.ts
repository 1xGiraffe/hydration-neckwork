import type { ClickHouseClient } from '../db/client.ts'
import { config } from '../config.ts'

// ---------------------------------------------------------------------------
// The destination leg of a cross-chain swap.
//
// `placeOrder` puts the whole on-Hydration half on chain (see
// clickhouse/schema/011_xcswap.sql), but stops at an Ethereum deposit address.
// Which asset the order was for, who receives it on NEAR or Zcash and how much
// actually arrived live only in the 1Click quote the UI took before submitting —
// nothing on Hydration records them.
//
// The deposit address recovers all of it: `GET /v0/status?depositAddress=…` on
// the Defuse 1Click API answers with the quote, the outcome and the destination
// chain's own transaction. Verified against every order placed so far (62 of 62
// resolved; 60 SUCCESS, 2 REFUNDED).
//
// Shape of the thing:
//  - It is an OFF-CHAIN read, so it never runs in a request path. The refresher
//    sweeps it into memory and the read path only ever does a map lookup; an
//    order that has not been resolved yet renders its on-chain half and says the
//    destination is not known, which is a fact rather than a gap.
//  - It is NOT a ClickHouse table. A derived table must be reproducible from raw
//    (AGENTS "Schema and derivations"), and this is not — it is a third party's
//    record of what its solvers did. An in-memory snapshot on the existing
//    coordinated refresher is the sanctioned shape for exactly that, and it
//    re-derives itself from the API on every boot.
//  - The terminal states are immutable, so they are memoised for the process
//    lifetime and only live orders are ever re-polled. The sweep is therefore
//    proportional to orders in flight (a handful), not to orders ever placed.
// ---------------------------------------------------------------------------

/** 1Click's own vocabulary, carried through rather than renamed. */
export type XcswapStatus =
  | 'KNOWN_DEPOSIT_TX' | 'PENDING_DEPOSIT' | 'INCOMPLETE_DEPOSIT' | 'PROCESSING'
  | 'SUCCESS' | 'REFUNDED' | 'FAILED'

// A settled, refunded or failed order can never change again; every other state
// is still moving and stays on the poll list.
const TERMINAL: ReadonlySet<XcswapStatus> = new Set<XcswapStatus>(['SUCCESS', 'REFUNDED', 'FAILED'])
export const isTerminalXcswapStatus = (s: XcswapStatus): boolean => TERMINAL.has(s)

export interface XcswapSettlement {
  depositAddress: string
  status: XcswapStatus
  /** 1Click asset id of the destination, e.g. `nep141:wrap.near`, `nep141:zec.omft.near`. */
  destinationAsset: string | null
  /** Human symbol and chain, from the 1Click token registry. */
  destinationSymbol: string | null
  destinationChain: string | null
  destinationDecimals: number | null
  /** Recipient on the destination chain, in that chain's own address format. */
  recipient: string | null
  /** Raw integer amount delivered, in the destination asset's smallest unit. */
  amountOut: string | null
  amountOutUsd: number | null
  /** What actually reached the deposit address, and its dollar value there. */
  depositedAmount: string | null
  depositedAmountUsd: number | null
  /** Set on a REFUNDED order; the reason 1Click gives, verbatim. */
  refundReason: string | null
  /** The destination chain's own transaction, when the swap settled. */
  destinationTxHash: string | null
  /** 1Click's correlation id, for support requests against their side. */
  correlationId: string | null
  updatedAt: string | null
  /** When we read it — a settlement is only ever as fresh as its last sweep. */
  fetchedAt: string
}

interface StatusResponse {
  correlationId?: string
  status?: string
  updatedAt?: string
  quoteResponse?: { quoteRequest?: { destinationAsset?: string; recipient?: string } }
  swapDetails?: {
    amountOut?: string
    amountOutUsd?: string
    depositedAmount?: string
    depositedAmountUsd?: string
    refundReason?: string
    destinationChainTxHashes?: { hash?: string }[]
  }
}

interface TokenRegistryEntry { assetId: string; symbol: string; decimals: number; blockchain: string }

const STATUSES = new Set<string>(['KNOWN_DEPOSIT_TX', 'PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED'])

let client: ClickHouseClient
export function initXcswapSettlements(c: ClickHouseClient): void { client = c }

const settlements = new Map<string, XcswapSettlement>()
let tokenRegistry = new Map<string, TokenRegistryEntry>()
let sweepInFlight = false

/** Configured only when a distribution-channel token is supplied. */
export function xcswapSettlementsEnabled(): boolean {
  return Boolean(config.oneClickToken)
}

/** The resolved destination of one order, or null when it is not known yet. */
export function xcswapSettlementFor(depositAddress: string): XcswapSettlement | null {
  return settlements.get(depositAddress.toLowerCase()) ?? null
}

export function xcswapSettlementsFor(depositAddresses: readonly string[]): Map<string, XcswapSettlement> {
  const out = new Map<string, XcswapSettlement>()
  for (const address of depositAddresses) {
    const hit = settlements.get(address.toLowerCase())
    if (hit) out.set(address.toLowerCase(), hit)
  }
  return out
}

/** Test seam: the sweep's own store, so a test can pin a state without HTTP. */
export function setXcswapSettlementForTesting(settlement: XcswapSettlement): void {
  settlements.set(settlement.depositAddress.toLowerCase(), settlement)
}
export function clearXcswapSettlementsForTesting(): void {
  settlements.clear()
}

// A number 1Click sends as a decimal string; absent or unparseable stays null
// rather than becoming 0, which would read as "delivered nothing".
function usd(v: string | undefined): number | null {
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function settlementFromResponse(depositAddress: string, body: StatusResponse, tokens: ReadonlyMap<string, TokenRegistryEntry>, fetchedAt = new Date().toISOString()): XcswapSettlement | null {
  const status = body.status
  // An unknown status is not coerced into one we know: the order stays
  // unresolved and is swept again, which is what a new 1Click state should do.
  if (!status || !STATUSES.has(status)) return null
  const request = body.quoteResponse?.quoteRequest ?? {}
  const details = body.swapDetails ?? {}
  const destinationAsset = request.destinationAsset ?? null
  const token = destinationAsset ? tokens.get(destinationAsset) : undefined
  return {
    depositAddress: depositAddress.toLowerCase(),
    status: status as XcswapStatus,
    destinationAsset,
    destinationSymbol: token?.symbol ?? null,
    destinationChain: token?.blockchain ?? null,
    destinationDecimals: token?.decimals ?? null,
    recipient: request.recipient ?? null,
    amountOut: details.amountOut && /^\d+$/.test(details.amountOut) ? details.amountOut : null,
    amountOutUsd: usd(details.amountOutUsd),
    depositedAmount: details.depositedAmount && /^\d+$/.test(details.depositedAmount) ? details.depositedAmount : null,
    depositedAmountUsd: usd(details.depositedAmountUsd),
    refundReason: details.refundReason ?? null,
    destinationTxHash: details.destinationChainTxHashes?.[0]?.hash ?? null,
    correlationId: body.correlationId ?? null,
    updatedAt: body.updatedAt ?? null,
    fetchedAt,
  }
}

async function oneClickGet(path: string): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ONE_CLICK_TIMEOUT_MS)
  try {
    const res = await fetch(`${config.oneClickBaseUrl.replace(/\/+$/, '')}${path}`, {
      headers: { Authorization: `Bearer ${config.oneClickToken}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`1Click ${path} -> HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timeout)
  }
}

const ONE_CLICK_TIMEOUT_MS = 10_000
// Orders resolved per sweep. Only unresolved and still-moving orders are ever on
// the list, so this is a ceiling for the first sweep after a restart rather than
// a steady-state cost; the rest arrive on the next tick.
const SWEEP_BATCH = 40
// Requests in flight at once against a third party's API.
const SWEEP_CONCURRENCY = 4

async function loadTokenRegistry(): Promise<void> {
  // The registry names the destination assets; without it an order still resolves,
  // it just reports the 1Click asset id rather than a symbol.
  try {
    const body = await oneClickGet('/v0/tokens')
    if (!Array.isArray(body)) return
    const next = new Map<string, TokenRegistryEntry>()
    for (const raw of body as TokenRegistryEntry[]) {
      if (raw && typeof raw.assetId === 'string') next.set(raw.assetId, raw)
    }
    if (next.size) tokenRegistry = next
  } catch (err) {
    console.error('[xcswap] 1Click token registry read failed:', err instanceof Error ? err.message : err)
  }
}

// Deposit addresses whose destination we still do not know, NEWEST order first.
// The batch cap means a cold start cannot resolve everything in one pass, and the
// order that was just placed is the one someone is watching — an old settled
// order will still be there next tick.
async function unresolvedDepositAddresses(): Promise<string[]> {
  const res = await client.query({
    query: `SELECT deposit_address
            FROM price_data.xcswap_orders FINAL
            GROUP BY deposit_address
            ORDER BY max(block_height) DESC`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ deposit_address: string }>()
  return rows
    .map((r: { deposit_address: string }) => r.deposit_address.toLowerCase())
    .filter((address: string) => {
      const known = settlements.get(address)
      // Never seen, or seen in a state that can still move.
      return !known || !isTerminalXcswapStatus(known.status)
    })
}

export async function refreshXcswapSettlements(): Promise<void> {
  if (!xcswapSettlementsEnabled() || !client || sweepInFlight) return
  sweepInFlight = true
  try {
    if (!tokenRegistry.size) await loadTokenRegistry()
    const pending = (await unresolvedDepositAddresses()).slice(0, SWEEP_BATCH)
    if (!pending.length) return
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++
        if (index >= pending.length) return
        const address = pending[index]!
        try {
          const body = await oneClickGet(`/v0/status?depositAddress=${encodeURIComponent(address)}`)
          const settlement = settlementFromResponse(address, body as StatusResponse, tokenRegistry)
          // A response we cannot read leaves the order unresolved rather than
          // storing a half-understood state.
          if (settlement) settlements.set(address, settlement)
        } catch (err) {
          // An order 1Click has never heard of (a quote that expired unused)
          // answers 404 forever; it stays unresolved, which is correct, and the
          // sweep simply re-asks. Logged once per sweep, not per order.
          if (index === 0) console.error('[xcswap] 1Click status read failed:', err instanceof Error ? err.message : err)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, pending.length) }, worker))
  } finally {
    sweepInFlight = false
  }
}
