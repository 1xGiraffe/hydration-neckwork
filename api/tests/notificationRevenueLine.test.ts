import { describe, expect, it } from 'vitest'
import { renderMatch } from '../src/notifications/evaluator.ts'
import { renderNotification } from '../src/notifications/render.ts'
import type { NotificationRule } from '../src/notifications/notificationStore.ts'

// No viewer tags in play: every account renders by its public name or its address.
const noTags = () => null

const rule = {
  ruleId: 'r1', accountId: '0xacct', kind: 'liquidation', name: 'Liquidations',
  params: {}, channels: [], muted: false, cooldownS: 0,
} as NotificationRule

const match = (revenue: unknown) => ({
  payload: {
    lane: 'activity' as const,
    row: {
      type: 'mm', mmAction: 'LiquidationCall', blockHeight: 100, extrinsicIndex: 2,
      eventIndex: 22, timestamp: '2026-08-20 21:13:39', valueUsd: 13700,
      amount: '1', ...(revenue === undefined ? {} : { revenue }),
    },
  },
} as never)

// Only the lanes that watch revenue ask the feed to attach it, so the field's presence
// is itself the signal that this alert is about revenue — the renderer needs no
// knowledge of the rule's kind to decide whether the line belongs.
describe('the protocol revenue line in a message', () => {
  it('reports what the protocol earned when the row carries it', () => {
    const rendered = renderNotification(renderMatch(match({ protocolUsd: 458.4, lpUsd: 321.39, streams: [] }), rule, noTags))

    expect(rendered.body).toContain('Protocol revenue')
    expect(rendered.body).toMatch(/\$458/)
  })

  // A row from a lane that did not ask for revenue has no field at all, and neither
  // does one whose block is too new to have booked or recomputed events. Inventing
  // "$0.00" there would state a number nobody computed.
  it('is left out entirely when the row carries no revenue', () => {
    const rendered = renderNotification(renderMatch(match(undefined), rule, noTags))

    expect(rendered.body).not.toContain('Protocol revenue')
  })

  it('still reports a genuine zero, which is a computed answer', () => {
    const rendered = renderNotification(renderMatch(match({ protocolUsd: 0, lpUsd: 0, streams: [] }), rule, noTags))

    expect(rendered.body).toContain('Protocol revenue')
  })
})
