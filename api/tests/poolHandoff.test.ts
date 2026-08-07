import { describe, expect, it } from 'vitest'
import { poolRowVisible } from '../src/services/pendingHeadService.ts'

// The pool row and the unfinalized row are the same transaction shown by two
// layers, and both failure modes are visible to a reader: retire the pool copy
// too early and the row vanishes for the few hundred milliseconds it takes to
// fetch its block; retire it too late and the same transaction is listed twice.
// Measured before this rule existed: the row was in NO feed for ~1.2s at every
// inclusion, and up to ~3s before the block fetch was made immediate.
describe('poolRowVisible', () => {
  const now = 1_800_000_000_000
  const tx = (over: Partial<{ inPool: boolean; droppedAtMs: number | null; carried: boolean; replacedBy: string | null }>) =>
    ({ inPool: true, droppedAtMs: null, carried: false, replacedBy: null, ...over })

  it('shows what the node still holds', () => {
    expect(poolRowVisible(tx({}), now)).toBe(true)
  })

  it('keeps showing one the node just dropped — its block is on its way here', () => {
    expect(poolRowVisible(tx({ inPool: false, droppedAtMs: now - 500 }), now)).toBe(true)
    // Sized to outlast a reorg flicker: a transaction whose block was orphaned
    // was observed leaving this node's pool for 18s before being re-included.
    expect(poolRowVisible(tx({ inPool: false, droppedAtMs: now - 19_000 }), now)).toBe(true)
  })

  it('gives up on one that never arrived — dropped, replaced, or invalid', () => {
    expect(poolRowVisible(tx({ inPool: false, droppedAtMs: now - 20_001 }), now)).toBe(false)
  })

  // One account can spend a nonce once, so a second transaction at the same
  // nonce REPLACES the first — a fee bump or a correction. Both were listed
  // before this rule, which reads as a duplicate of one intent.
  it('retires the transaction that was replaced at the same nonce', () => {
    expect(poolRowVisible(tx({ replacedBy: '0xabc' }), now)).toBe(false)
    // Even while the node still lists it, and even freshly dropped: it can
    // never be included, so it is never a row again.
    expect(poolRowVisible(tx({ inPool: true, replacedBy: '0xabc' }), now)).toBe(false)
    expect(poolRowVisible(tx({ inPool: false, droppedAtMs: now - 10, replacedBy: '0xabc' }), now)).toBe(false)
  })

  it('retires it the moment a block we hold carries it — never listed twice', () => {
    expect(poolRowVisible(tx({ carried: true }), now)).toBe(false)
    // Even while the node still lists it: the node prunes on its own schedule.
    expect(poolRowVisible(tx({ inPool: true, carried: true }), now)).toBe(false)
    // And even inside the handoff window.
    expect(poolRowVisible(tx({ inPool: false, droppedAtMs: now - 100, carried: true }), now)).toBe(false)
  })
})
