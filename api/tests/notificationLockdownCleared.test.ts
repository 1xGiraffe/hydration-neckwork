import { describe, expect, it } from 'vitest'
import { evaluateSafety, liveSafetyEvents, resolveWindow } from '../src/notifications/evaluator.ts'
import type { NotificationRule } from '../src/notifications/notificationStore.ts'
import { lockdownTimelineEvents, pairLockdowns } from '../src/services/securityService.ts'

// A deposit lockdown ends at its own `until` block, and the chain says nothing
// then: `AssetLockdownRemoved` comes only with the asset's next deposit, hours or
// days later. The "Deposit lockdown cleared" alert must fire when the lockdown
// actually ends, not when somebody next uses the limit (vDOT, 2026-11-07: the
// window elapsed at 16,745,903, the alert went out with a Bifrost deposit at
// 16,749,751, ~2h25m late).
//
// The lane is replayed here the way safetyLane drives it: each tick builds the
// security timeline from the ledger as far as the chain has reached, matches the
// window (cursor, newest row], and moves the cursor to that newest row.

const VDOT = 15
const LOCKED_AT = 1_000
const UNTIL = 1_500

const row = (event: string, block: number, args: Record<string, unknown>, extrinsic: number | null = null) => ({
  block_height: block, block_timestamp: `ts@${block}`, event_name: `CircuitBreaker.${event}`,
  args_json: JSON.stringify(args), extrinsic_index: extrinsic,
})
const lockdown = (block: number, until: number) => row('AssetLockdown', block, { assetId: VDOT, until })
const removal = (block: number, extrinsic: number | null = null) => row('AssetLockdownRemoved', block, { assetId: VDOT }, extrinsic)

const rule: NotificationRule = {
  ruleId: 'rule-safety', accountId: '0x' + 'aa'.repeat(32), kind: 'safety', name: '',
  params: { kinds: ['lockdown', 'lockdown-lifted'] }, channels: [], muted: false, cooldownS: 0,
}

/** The safety lane over a sequence of ticks; returns every delivered identity with its block. */
function runLane(ticks: { reached: number; rows: ReturnType<typeof row>[] }[], cursor: number): { delivered: { kind: string; block: number }[]; cursor: number } {
  const delivered: { kind: string; block: number }[] = []
  const seen = new Set<string>()
  for (const { reached, rows } of ticks) {
    // The timestamps the dashboard resolves: every `until` the chain has reached.
    const timestamps = new Map<number, string>()
    for (const r of rows) {
      const until = Number(JSON.parse(r.args_json).until ?? 0)
      if (until > 0 && until <= reached) timestamps.set(until, `ts@${until}`)
    }
    const lockdowns = pairLockdowns(rows, { height: reached, timestamps })
    const timeline = lockdownTimelineEvents(lockdowns, { actual: timestamps, head: null, paceMs: 0 })
    const newest = timeline.reduce((max, e) => Math.max(max, e.blockHeight), 0)
    const { window } = resolveWindow(cursor, Math.max(cursor, newest))
    if (window.to > window.from) {
      for (const m of evaluateSafety(liveSafetyEvents(timeline, reached), [rule], window)) {
        // The inbox is keyed on the identity: a repeat is no second message.
        if (seen.has(m.identity)) continue
        seen.add(m.identity)
        delivered.push({ kind: (m.payload as { event: { kind: string } }).event.kind, block: m.blockHeight })
      }
      cursor = window.to
    }
  }
  return { delivered, cursor }
}

describe('deposit lockdown cleared', () => {
  it('fires at the until block with no follow-up event, and the later utilization adds nothing', () => {
    const { delivered } = runLane([
      { reached: 1_100, rows: [lockdown(LOCKED_AT, UNTIL)] },
      { reached: UNTIL - 1, rows: [lockdown(LOCKED_AT, UNTIL)] },
      // The window elapses: nothing on chain, the alert goes out now.
      { reached: UNTIL, rows: [lockdown(LOCKED_AT, UNTIL)] },
      { reached: 1_700, rows: [lockdown(LOCKED_AT, UNTIL)] },
      // The next deposit's removal, ~an hour later, is bookkeeping.
      { reached: 1_900, rows: [lockdown(LOCKED_AT, UNTIL), removal(1_900)] },
      // ...and the deposit after it trips the fuse again: a new lockdown, no second clear.
      { reached: 1_950, rows: [lockdown(LOCKED_AT, UNTIL), removal(1_900), lockdown(1_950, 2_450)] },
    ], LOCKED_AT - 1)
    expect(delivered).toEqual([
      { kind: 'lockdown', block: LOCKED_AT },
      { kind: 'lockdown-lifted', block: UNTIL },
      { kind: 'lockdown', block: 1_950 },
    ])
  })

  it('fires at until when an over-limit deposit re-locks an expired lockdown without a removal', () => {
    const { delivered } = runLane([
      { reached: UNTIL, rows: [lockdown(LOCKED_AT, UNTIL)] },
      { reached: 1_800, rows: [lockdown(LOCKED_AT, UNTIL), lockdown(1_800, 2_300)] },
    ], LOCKED_AT)
    expect(delivered).toEqual([
      { kind: 'lockdown-lifted', block: UNTIL },
      { kind: 'lockdown', block: 1_800 },
    ])
  })

  it('states a clear that only becomes visible with the removal at until, in the same tick', () => {
    // The tick that first sees the chain past `until` also sees the removal and
    // a re-trip: the clear is still dated at until and is above the cursor.
    const { delivered } = runLane([
      { reached: 1_400, rows: [lockdown(LOCKED_AT, UNTIL)] },
      { reached: 1_900, rows: [lockdown(LOCKED_AT, UNTIL), removal(1_900), lockdown(1_901, 2_400)] },
    ], LOCKED_AT)
    expect(delivered).toEqual([
      { kind: 'lockdown-lifted', block: UNTIL },
      { kind: 'lockdown', block: 1_901 },
    ])
  })

  it('dates a governance lift before until by its own call', () => {
    const lockdowns = pairLockdowns([lockdown(LOCKED_AT, UNTIL), removal(1_200, 2)], { height: 1_200, timestamps: new Map() })
    const lifted = lockdownTimelineEvents(lockdowns, { actual: new Map(), head: null, paceMs: 0 }).find(e => e.kind === 'lockdown-lifted')
    expect(lifted).toMatchObject({ blockHeight: 1_200, blockTimestamp: 'ts@1200', extrinsicIndex: 2 })
  })

  it('is silent for a clear at or below the cursor — no burst of historical clears on deploy', () => {
    // The cursor already stands past this lockdown's until — the state a deploy
    // meets for a clear that was delivered when its removal row was indexed.
    const { delivered } = runLane([
      { reached: 2_000, rows: [lockdown(LOCKED_AT, UNTIL), removal(1_900)] },
    ], 1_900)
    expect(delivered).toEqual([])
  })
})
