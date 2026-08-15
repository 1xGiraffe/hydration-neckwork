import { pendingNodeApi } from './pendingHeadService.ts'

// Runtime constants read straight out of the node's METADATA.
//
// The pending-head layer already holds a connected ApiPromise for the whole
// process lifetime, and a runtime's `#[pallet::constant]` values are decoded
// into that object when the metadata loads. Reading one is therefore a property
// access on an in-memory object — no round trip, nothing to cache, nothing to
// budget against the archive node. This module is the seam that makes those
// values available to services that must otherwise PIN them in code.
//
// Every reader returns null when the value cannot be had — the pending layer is
// disabled (the '[pending] disabled — RPC connection failed' path), the pallet
// is absent, or the constant is not published. Null means "the chain could not
// be consulted"; it must never be treated as a value, and every caller here
// falls back to a documented pin.
//
// Verified against the live runtime (spec 435, Aug 2026):
//   aura.slotDuration        = 6000       (MILLISECS_PER_BLOCK)
//   gigaHdx.cooldownPeriod   = 403200     (28 days of 6s blocks)
// and, for contrast, pallet_circuit_breaker publishes ONLY its three default
// limit rationals — its `Period = DAYS` is not a metadata constant at all,
// which is why securityService still has to pin that one by hand.

function constantBigInt(pallet: string, name: string): bigint | null {
  const api = pendingNodeApi()
  if (!api) return null
  try {
    const consts = (api.consts as Record<string, Record<string, unknown> | undefined>)[pallet]
    const value = consts?.[name] as { toBigInt?: () => bigint; toString: () => string } | undefined
    if (value == null) return null
    return value.toBigInt ? value.toBigInt() : BigInt(value.toString())
  } catch {
    return null
  }
}

function constantNumber(pallet: string, name: string, max: number): number | null {
  const raw = constantBigInt(pallet, name)
  if (raw == null || raw <= 0n || raw > BigInt(max)) return null
  return Number(raw)
}

// `MILLISECS_PER_BLOCK` — the parachain's nominal slot time. 6000 today, 2000
// after the planned upgrade. This is the AUTHORITATIVE answer to "how long is a
// block scheduled to take"; blockTime.ts prefers it over inferring the same
// number from indexed block timestamps.
export function runtimeSlotDurationMs(): number | null {
  return constantNumber('aura', 'slotDuration', 600_000)
}

// `gigaHdx.cooldownPeriod` — parachain blocks an unstake waits before it
// matures. The runtime is expected to rescale it at the 2s upgrade so the
// cooldown stays 28 days (403 200 → 1 209 600), which is exactly the kind of
// silent redefinition a pinned copy would miss.
export function runtimeGigaCooldownBlocks(): number | null {
  return constantNumber('gigaHdx', 'cooldownPeriod', 100_000_000)
}
