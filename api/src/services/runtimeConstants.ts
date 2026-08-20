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

// `aura.slotDuration` — the AUTHOR SLOT length, which is NOT the block time and
// must never be used as one.
//
// Runtime 440 decouples the two: `SLOT_DURATION` stays 6000 while
// `MILLISECS_PER_BLOCK` becomes 2000, and `AllowMultipleBlocksPerSlot = true`
// lets one author produce 3 blocks inside its slot
// (runtime/hydradx/src/system.rs: `type SlotDuration = ConstU64<SLOT_DURATION>`).
// So this constant reads 6000 before AND after the switch. It is kept because
// the slot length is a real quantity, but the block time comes from
// `runtimeParaBlockMs()` below.
export function runtimeSlotDurationMs(): number | null {
  return constantNumber('aura', 'slotDuration', 600_000)
}

// `system.blockHashCount` — recent block hashes retained. Declared as a fixed
// WALL-CLOCK retention (4 hours), so the runtime restates the block count when
// the block time changes: 2400 at 6s, 7200 at 2s.
export function runtimeBlockHashCount(): number | null {
  return constantNumber('system', 'blockHashCount', 10_000_000)
}

// Wall-clock premises behind the two constants we derive the block time from.
// Each is a fixed duration the runtime expresses in blocks, so dividing it by
// the published block count yields the milliseconds per block on either side of
// the 2s switch.
const BLOCK_HASH_RETENTION_MS = 4 * 3_600_000
const GIGA_COOLDOWN_MS = 28 * 86_400_000

// Exact integer division only: a premise that no longer divides cleanly means
// the wall-clock quantity itself changed, which is a fact we must not guess at.
function msPerBlock(totalMs: number, blocks: number | null): number | null {
  if (blocks == null || blocks <= 0) return null
  return totalMs % blocks === 0 ? totalMs / blocks : null
}

// The parachain's nominal MILLISECONDS PER BLOCK, derived from constants that
// actually track it (see the note on `runtimeSlotDurationMs` for why the
// obvious one does not). Two independent pallets publish a wall-clock quantity
// in blocks; when both are readable they must agree. A disagreement means one
// of the premises above changed, so we return null and let the caller fall back
// to the measured ladder rather than silently rescaling every projected date.
export function paraBlockMsFromConstants(
  blockHashCount: number | null,
  gigaCooldownBlocks: number | null,
): number | null {
  const fromHashCount = msPerBlock(BLOCK_HASH_RETENTION_MS, blockHashCount)
  const fromCooldown = msPerBlock(GIGA_COOLDOWN_MS, gigaCooldownBlocks)
  if (fromHashCount != null && fromCooldown != null) {
    return fromHashCount === fromCooldown ? fromHashCount : null
  }
  return fromHashCount ?? fromCooldown
}

export function runtimeParaBlockMs(): number | null {
  return paraBlockMsFromConstants(runtimeBlockHashCount(), runtimeGigaCooldownBlocks())
}

// `gigaHdx.cooldownPeriod` — parachain blocks an unstake waits before it
// matures. The runtime is expected to rescale it at the 2s upgrade so the
// cooldown stays 28 days (403 200 → 1 209 600), which is exactly the kind of
// silent redefinition a pinned copy would miss.
export function runtimeGigaCooldownBlocks(): number | null {
  return constantNumber('gigaHdx', 'cooldownPeriod', 100_000_000)
}
