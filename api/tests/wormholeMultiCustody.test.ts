import { describe, expect, it } from 'vitest'
import { addCustody, type CustodyRead } from '../src/services/wormholeNttService.ts'

// A burning manager on Hydration can register a peer on more than one chain, and
// each of those peers can be a LOCKING manager holding its own custody. WETH is
// the live case: 71.210163720 held on Ethereum and 0.005639660 on Robinhood Chain
// (wormhole id 72), both backing one Hydration supply.
//
// Reading only the registry origin understated backing by the second custody, and
// the monitor reported a shortfall that did not exist — $14.68 of WETH "unbacked"
// while the tokens were sitting in a custody nobody asked about.

const read = (r: Partial<CustodyRead>): CustodyRead => ({ locked: 0n, decimals: 18, paused: false, at: 1000, ...r })

describe('custody sums across every chain that backs an asset', () => {
  it('adds a second custody to the first', () => {
    const eth = read({ locked: 71210163720000000000n })
    const robinhood = read({ locked: 5639660000000000n })
    expect(addCustody(addCustody(undefined, eth, 18), robinhood, 18).locked)
      .toBe(71215803380000000000n)
  })

  it('leaves a single custody exactly as it was read', () => {
    const only = read({ locked: 123n, decimals: 6 })
    expect(addCustody(undefined, only, 18)).toBe(only)
  })

  // Each chain states its balance in its own token's decimals, so a custody has to
  // be rescaled before it is added — adding raw units of different scales would
  // invent or destroy backing outright.
  it('rescales a custody held at different decimals', () => {
    const base = read({ locked: 1_000000n, decimals: 6 })          // 1.0 at 6dp
    const other = read({ locked: 2_000000000000000000n, decimals: 18 }) // 2.0 at 18dp
    expect(addCustody(base, other, 18)).toMatchObject({ locked: 3_000000n, decimals: 6 })
    // ...and in the other direction, where the total keeps the FIRST scale seen.
    expect(addCustody(other, base, 18)).toMatchObject({ locked: 3_000000000000000000n, decimals: 18 })
  })

  // A total is only as fresh as its least fresh part: a sum that contains one
  // carried-over balance must not be presented as a current reading, because the
  // verdict refuses to confirm a shortfall against stale custody.
  it('carries staleness into the total', () => {
    expect(addCustody(read({ locked: 1n }), read({ locked: 1n, stale: true }), 18).stale).toBe(true)
    expect(addCustody(read({ locked: 1n, stale: true }), read({ locked: 1n }), 18).stale).toBe(true)
    expect(addCustody(read({ locked: 1n }), read({ locked: 1n }), 18).stale).toBeUndefined()
  })

  // Pausing any one custody pauses the asset's backing: the tokens in that
  // manager cannot be released, so the page must not read as unpaused.
  it('treats a pause anywhere as a pause for the asset', () => {
    expect(addCustody(read({ locked: 1n }), read({ locked: 1n, paused: true }), 18).paused).toBe(true)
    expect(addCustody(read({ locked: 1n, paused: true }), read({ locked: 1n }), 18).paused).toBe(true)
  })

  // An unreadable balance must not silently count as zero — that would subtract a
  // whole custody and manufacture the shortfall this change exists to remove.
  it('marks the total stale rather than treating an unread balance as zero', () => {
    const out = addCustody(read({ locked: 10n }), read({ locked: null }), 18)
    expect(out.locked).toBe(10n)
    expect(out.stale).toBe(true)
  })

  it('takes the newest timestamp of the parts', () => {
    expect(addCustody(read({ locked: 1n, at: 10 }), read({ locked: 1n, at: 99 }), 18).at).toBe(99)
    expect(addCustody(read({ locked: 1n, at: 99 }), read({ locked: 1n, at: 10 }), 18).at).toBe(99)
  })
})
