import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ayeSharePct, orderVoters, selectTally, type DisplayTally } from '../src/utils/referendumVotes'
import { TallySummary } from '../src/pages/Referendum'
import type { ReferendumVoter } from '../src/types'

const voter = (over: Partial<ReferendumVoter>): ReferendumVoter => ({
  account: null, kind: 'Standard', side: 'Aye', conviction: 'Locked1x', convictionIndex: 1,
  balance: '0', ayeBalance: '0', nayBalance: '0', abstainBalance: '0',
  weightedAye: '0', weightedNay: '0', weighted: '0', valueUsd: null,
  blockHeight: 1, eventIndex: 0, extrinsicIndex: 0, timestamp: '', removed: false, ...over,
})

describe('orderVoters', () => {
  const aye = voter({ blockHeight: 100, weighted: '10', weightedAye: '10' })
  const bigAye = voter({ blockHeight: 50, weighted: '324720460268124120655', weightedAye: '324720460268124120655' })
  const nay = voter({ blockHeight: 200, weighted: '20', weightedNay: '20' })
  const split = voter({ kind: 'Split', side: 'Split', blockHeight: 150, weighted: '30', weightedAye: '10', weightedNay: '20' })
  const all = [aye, bigAye, nay, split]

  it('sorts newest first by default', () => {
    expect(orderVoters(all, 'time', 'all').map(v => v.blockHeight)).toEqual([200, 150, 100, 50])
  })

  it('breaks a same-block tie on event index', () => {
    const a = voter({ blockHeight: 10, eventIndex: 1 }), b = voter({ blockHeight: 10, eventIndex: 7 })

    expect(orderVoters([a, b], 'time', 'all').map(v => v.eventIndex)).toEqual([7, 1])
  })

  // Weights are 21-digit planck values, so they are compared as BigInt: subtracting
  // them as doubles silently ties values that differ in their low digits.
  it('sorts by votes without losing precision', () => {
    const near = voter({ weighted: '324720460268124120654', weightedAye: '324720460268124120654' })

    expect(orderVoters([near, bigAye], 'votes', 'all').map(v => v.weighted))
      .toEqual(['324720460268124120655', '324720460268124120654'])
  })

  it('filters to one side', () => {
    expect(orderVoters(all, 'time', 'aye').map(v => v.blockHeight)).toEqual([150, 100, 50])
    expect(orderVoters(all, 'time', 'nay').map(v => v.blockHeight)).toEqual([200, 150])
  })

  // A Split vote backs both sides at once, so it belongs under either filter.
  it('keeps a split vote on both sides', () => {
    expect(orderVoters([split], 'time', 'aye')).toHaveLength(1)
    expect(orderVoters([split], 'time', 'nay')).toHaveLength(1)
  })

  it('does not mutate its input', () => {
    const input = [aye, nay]
    orderVoters(input, 'votes', 'all')

    expect(input).toEqual([aye, nay])
  })
})

// Which tally a page may show, and what it is allowed to call it.
//
// OpenGov carries the chain's own figure on its lifecycle events. The Democracy pallet
// carries none on ANY of its events and keeps its Tally only in storage while the
// referendum is Ongoing, so a Democracy page has nothing authoritative to show and falls
// back to the sum of the votes we indexed — the chain's DIRECT tally, without delegated
// power. The two must never be presented as the same thing.
describe('selectTally', () => {
  const directTally = {
    ayes: '1726862239116327685341', nays: '100003594056846489466',
    rawAyes: '405587145643483155404', rawNays: '25810953053914510321',
    support: '405587145643483155404',
    ayeVoters: 153, nayVoters: 18, splitVoters: 0, voters: 171,
  }

  it('prefers the chain tally once it is final', () => {
    const onChainTally = {
      ayes: '1779098767527936185457', nays: '102519899710184616184', support: '414293233712084572090',
      final: true, blockHeight: 9_684_303, timestamp: '2025-10-17 11:47:54',
    }

    expect(selectTally({ onChainTally, directTally }))
      .toEqual({ ayes: onChainTally.ayes, nays: onChainTally.nays, support: onChainTally.support, source: 'chain' })
  })

  it('falls back to the attributed votes and says so', () => {
    const tally = selectTally({ onChainTally: null, directTally })

    expect(tally.source).toBe('attributed')
    expect(tally.ayes).toBe(directTally.ayes)
    expect(tally.nays).toBe(directTally.nays)
    expect(tally.support).toBe(directTally.support)
    // Nothing was superseded — the Democracy pallet never published a tally at all.
    expect(tally.snapshot).toBeUndefined()
  })

  it('never labels a reconstruction as the chain figure', () => {
    expect(selectTally({ onChainTally: null, directTally }).source).not.toBe('chain')
  })

  // The reported bug: OpenGov 370's only tally event was the decision-start snapshot
  // (19.2M AYE, 4.92M support, block 13342550), and showing it as "On-chain tally"
  // hid the 789.5M the thirty votes indexed since already add up to.
  it('does not present a decision-start snapshot as the tally', () => {
    const snapshot = {
      ayes: '19211236354479984589', nays: '0', support: '4924401572117738847',
      final: false, blockHeight: 13_342_550, timestamp: '2026-07-27 11:38:03',
    }

    const tally = selectTally({ onChainTally: snapshot, directTally })

    expect(tally.source).toBe('attributed')
    expect(tally.ayes).toBe(directTally.ayes)
    expect(tally.support).toBe(directTally.support)
    // ...and the superseded figure travels with it, so the page can say what the chain
    // last published and when, rather than dropping it silently.
    expect(tally.snapshot).toEqual(snapshot)
  })
})

// Percentages are taken from 21-digit planck values, so they are computed in BigInt.
describe('ayeSharePct', () => {
  it('splits the weighted tally', () => {
    expect(ayeSharePct('1779098767527936185457', '102519899710184616184')).toBeCloseTo(94.55, 2)
    // Floors at two decimals rather than rounding up: 3.8679% reads 3.86.
    expect(ayeSharePct('39416704000000000000', '979531133503937968168')).toBe(3.86)
  })

  // Democracy 206's chain tally: the double route rounds both operands before dividing.
  it('does not round the operands first', () => {
    expect(ayeSharePct('1000000000000000000001', '1000000000000000000000')).toBe(50)
    expect(ayeSharePct('1000000000000000000000', '1000000000000000000001')).toBe(49.99)
  })

  it('is null when nothing has been counted', () => {
    expect(ayeSharePct('0', '0')).toBeNull()
    expect(ayeSharePct('', '0')).toBeNull()
    expect(ayeSharePct('1.5', '0')).toBeNull()
  })
})

describe('TallySummary labelling', () => {
  const render = (tally: DisplayTally, voters = 171) =>
    renderToStaticMarkup(<TallySummary tally={tally} voters={voters} decimals={12} />)

  it('calls the chain figure the on-chain tally and adds no caveat', () => {
    const html = render({ ayes: '1779098767527936185457', nays: '102519899710184616184', support: '414293233712084572090', source: 'chain' })

    expect(html).toContain('On-chain tally')
    expect(html).not.toContain('Attributed votes')
    expect(html).not.toContain('Not the chain')
    expect(html).toContain('support')
  })

  it('names a reconstruction and states what it is missing', () => {
    const html = render({ ayes: '39416704000000000000', nays: '979531133503937968168', support: null, source: 'attributed' })

    expect(html).toContain('Attributed votes')
    expect(html).not.toContain('On-chain tally')
    expect(html).toContain('Not the chain')
    expect(html).toContain('without delegated power')
    expect(html).toContain('171 indexed votes')
  })

  // A running OpenGov referendum carries no caveat at all: the label already says the
  // figure is a reconstruction, and unlike Democracy its numbers move as votes arrive.
  // It must certainly not borrow the Democracy explanation — that pallet has nothing to
  // do with OpenGov 370.
  it('adds no caveat to a running referendum', () => {
    const html = render({
      ayes: '789522038578859970114', nays: '0', support: '139440474770561651358', source: 'attributed',
      snapshot: {
        ayes: '19211236354479984589', nays: '0', support: '4924401572117738847',
        final: false, blockHeight: 13_342_550, timestamp: '2026-07-27 11:38:03',
      },
    }, 30)

    expect(html).toContain('Attributed votes')
    expect(html).not.toContain('tally-note')
    expect(html).not.toContain('Democracy pallet')
    expect(html).not.toContain('Not the chain')
    // The superseded snapshot is not shown either.
    expect(html).not.toContain('13,342,550')
    // ...but the reconstruction's own numbers still are.
    expect(html).toContain('support')
  })

  it('draws the same bar for either source', () => {
    for (const source of ['chain', 'attributed'] as const) {
      const html = render({ ayes: '39416704000000000000', nays: '979531133503937968168', support: null, source })

      expect(html).toContain('class="tally-bar"')
      // 3.86% AYE — a non-zero width from the BigInt share, not a collapsed bar.
      expect(html).toContain('width:3.86%')
      expect(html).toContain('AYE')
      expect(html).toContain('NAY')
    }
  })

  it('says so rather than drawing an empty bar when nothing was counted', () => {
    const html = render({ ayes: '0', nays: '0', support: null, source: 'attributed' }, 0)

    expect(html).toContain('No votes counted yet')
    expect(html).not.toContain('class="tally-bar"')
  })
})
