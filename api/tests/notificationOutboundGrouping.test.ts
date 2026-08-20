import { describe, expect, it } from 'vitest'
import { outboundGroups, renderDigest, MAX_OUTBOUND_SENDS } from '../src/notifications/evaluator.ts'
import { renderNotification, text, usd } from '../src/notifications/render.ts'
import type { NotificationRule } from '../src/notifications/notificationStore.ts'

// One tick spans several blocks (6s ticks against ~4.8s blocks), and the loop used
// to collapse a rule's whole tick into ONE outbound message. Two swaps a block apart
// are two separate events to a reader, so they must arrive as two messages; only
// matches sharing a block are one event worth merging.
//
// The bound matters as much as the split: a catch-up window (the 600-block clamp,
// or a rewound cursor) can hold dozens of blocks, and one push per block would
// then arrive as a burst.
const m = (blockHeight: number, identity = `${blockHeight}-e1`) => ({ blockHeight, identity })

describe('outbound message grouping', () => {
  it('keeps matches from one block together as a single message', () => {
    const groups = outboundGroups([m(100, '100-e1'), m(100, '100-e2')], MAX_OUTBOUND_SENDS)

    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(2)
  })

  it('splits matches from different blocks into separate messages', () => {
    const groups = outboundGroups([m(100), m(101), m(102)], MAX_OUTBOUND_SENDS)

    expect(groups).toHaveLength(3)
    expect(groups.map(g => g.length)).toEqual([1, 1, 1])
    expect(groups.map(g => g[0].blockHeight)).toEqual([100, 101, 102])
  })

  it('collapses the oldest blocks when a catch-up window exceeds the cap', () => {
    const many = Array.from({ length: 12 }, (_, i) => m(100 + i))

    const groups = outboundGroups(many, MAX_OUTBOUND_SENDS)

    // Never more messages than the cap, and the newest blocks keep their own.
    expect(groups).toHaveLength(MAX_OUTBOUND_SENDS)
    expect(groups[0]).toHaveLength(12 - (MAX_OUTBOUND_SENDS - 1))
    for (const g of groups.slice(1)) expect(g).toHaveLength(1)
    // Nothing is dropped, and chain order is preserved.
    expect(groups.flat().map(x => x.blockHeight)).toEqual(many.map(x => x.blockHeight))
  })

  it('returns nothing for no matches', () => {
    expect(outboundGroups([], MAX_OUTBOUND_SENDS)).toEqual([])
  })
})

// The digest listed entry HEADLINES only, so a coalesced message threw away the
// amount/direction/USD line the single-match message already carries.
describe('a digest line', () => {
  const rule: NotificationRule = {
    ruleId: 'r1', accountId: '0xacct', kind: 'large-trade', name: 'Whale watch',
    params: { assetId: 0, minUsd: 500 }, channels: [], muted: false, cooldownS: 0,
  }

  it('carries the entry detail, not just its headline', () => {
    const entry = renderNotification({
      title: 'Swap', body: [[text('10k HDX → 1 DOT ·'), usd(105)]], path: '/a',
    })

    const digest = renderDigest(rule, [entry])

    expect(digest.body).toContain('Swap')
    expect(digest.body).toContain(entry.body.split('\n')[0])
  })

  it('still renders an entry that has no detail line', () => {
    const entry = renderNotification({ title: 'Swap 0', path: '/a' })

    const digest = renderDigest(rule, [entry])

    expect(digest.body).toContain('• Swap 0')
  })
})
