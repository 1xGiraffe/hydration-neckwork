import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  enactmentOutcomeFrom,
  referendumEnactmentTaskId,
  referendumTimelineFrom,
  tasksFiledBy,
} from '../src/services/governanceService.ts'

const governanceService = readFileSync(new URL('../src/services/governanceService.ts', import.meta.url), 'utf8')
const tables = readFileSync(new URL('../../clickhouse/schema/001_tables.sql', import.meta.url), 'utf8')
const views = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

// A referendum's own events stop at Referenda.Confirmed; whether the approved call actually
// ran is a Scheduler event, which names its task and never its referendum. The only join is
// the name pallet_referenda derives, so if this derivation is wrong the page shows no
// enactment at all — or, worse, another task's.
//
// Both ids below are the ones the chain actually emitted, so they pin the SCALE layout of
// (ASSEMBLY_ID, "enactment", index) against real rows rather than against a re-reading of the
// pallet: fixed-width [u8; 8] with no length prefix, compact-prefixed "enactment", and the
// index little-endian. Across the indexed chain the derivation accounts for every one of the
// 347 confirmed OpenGov referenda — 346 through Scheduler.Dispatched, and referendum 33
// through Scheduler.CallUnavailable.
describe('the OpenGov enactment task name', () => {
  it('derives the name the chain dispatched referendum 383 under', () => {
    // Scheduler.Dispatched at block 13,681,337, 100 blocks after Confirmed, result Ok.
    expect(referendumEnactmentTaskId(383))
      .toBe('0xc4dacac2d61c3369c9629e3e33d106c067046c4b5084dd9521885798c9e9c7b9')
  })

  it('derives the name referendum 33 never got to run under', () => {
    // Scheduler.CallUnavailable at block 7,051,030: confirmed, but the preimage was gone by
    // enactment time. The one confirmed referendum with no Dispatched row.
    expect(referendumEnactmentTaskId(33))
      .toBe('0x84c108e68bbde930d2925776a976845fd356f7d5770169a7859ead8bd92c0abe')
  })

  it('encodes the index as a little-endian u32, not host order', () => {
    // 383 is 0x0000017F, so a big-endian slip would hash 7F over the wrong byte and silently
    // return a name nothing ever scheduled.
    expect(referendumEnactmentTaskId(383)).not.toBe(referendumEnactmentTaskId(0x7F000000))
    expect(new Set([0, 1, 33, 383].map(referendumEnactmentTaskId)).size).toBe(4)
  })
})

describe('what the enactment event says happened', () => {
  it('reads a successful dispatch', () => {
    expect(enactmentOutcomeFrom('Scheduler.Dispatched', '{"task":[13681337,0],"result":{"__kind":"Ok"}}')).toBe('ok')
  })

  it('reads a dispatch that errored', () => {
    const args = '{"task":[7050930,1],"result":{"__kind":"Err","value":{"__kind":"Module","value":{"index":37,"error":"0x00000000"}}}}'
    expect(enactmentOutcomeFrom('Scheduler.Dispatched', args)).toBe('failed')
  })

  it('reads a call that was never available', () => {
    expect(enactmentOutcomeFrom('Scheduler.CallUnavailable', '{"task":[7051030,0],"id":"0x84c1"}')).toBe('unavailable')
  })

  // An unreadable result is not a failed one: a Scheduler.Dispatched always carries a result,
  // so its absence is a data fault, and reporting it as a failed enactment would put a red
  // dot and "Execution failed" on a referendum that may well have succeeded.
  it('claims nothing when the result is missing or unparseable', () => {
    expect(enactmentOutcomeFrom('Scheduler.Dispatched', '{"task":[13681337,0]}')).toBeNull()
    expect(enactmentOutcomeFrom('Scheduler.Dispatched', 'not json')).toBeNull()
  })
})

// Referendum 33's real shape, which is why the enactment is merged rather than appended: its
// call went unavailable 100 blocks after confirmation, but its submission deposit came back
// 211,867 blocks later. Appending would have listed the enactment after that refund.
describe('the timeline places the enactment in block order', () => {
  const lifecycle = [
    { event_name: 'Referenda.Submitted', block_height: 7_049_051, extrinsic_index: 2, ts: '2025-02-28 15:59:00' },
    { event_name: 'Referenda.Confirmed', block_height: 7_050_930, extrinsic_index: null, ts: '2025-02-28 23:11:42' },
    { event_name: 'Referenda.SubmissionDepositRefunded', block_height: 7_262_897, extrinsic_index: 4, ts: '2025-04-03 06:56:30' },
  ]
  const unavailable = {
    event_name: 'Scheduler.CallUnavailable', block_height: 7_051_030, event_index: 5,
    extrinsic_index: null, ts: '2025-02-28 23:37:12', args_json: '{"task":[7051030,0],"id":"0x84c1"}',
  }

  it('slots it between the conclusion and the refunds that trail it', () => {
    const timeline = referendumTimelineFrom(lifecycle, unavailable)
    expect(timeline.map(entry => entry.event)).toEqual([
      'Referenda.Submitted',
      'Referenda.Confirmed',
      'Scheduler.CallUnavailable',
      'Referenda.SubmissionDepositRefunded',
    ])
    expect(timeline[2].outcome).toBe('unavailable')
  })

  it('leaves the lifecycle untouched when there is no enactment', () => {
    const timeline = referendumTimelineFrom(lifecycle, null)
    expect(timeline).toHaveLength(3)
    expect(timeline.every(entry => entry.outcome === undefined)).toBe(true)
  })

  // Same-block rows keep the event_index order the query returned them in; the sort must not
  // reorder a Confirmed that shares its block with the deposit refund that closed a batch.
  it('keeps same-block lifecycle rows in query order', () => {
    const sameBlock = [
      { event_name: 'Referenda.Confirmed', block_height: 900, extrinsic_index: null, ts: '2026-01-01 00:00:00' },
      { event_name: 'Referenda.DecisionDepositRefunded', block_height: 900, extrinsic_index: 1, ts: '2026-01-01 00:00:00' },
    ]
    expect(referendumTimelineFrom(sameBlock, null).map(entry => entry.event))
      .toEqual(['Referenda.Confirmed', 'Referenda.DecisionDepositRefunded'])
  })
})

// The projection exists so the enactment is a point lookup instead of a scan over the 218,470
// Scheduler.Dispatched rows in raw_events, 217,925 of which are anonymous agenda entries with
// no name to match at all.
describe('the named-dispatch projection declaration matches what the reader selects', () => {
  it('declares the table keyed task-first', () => {
    expect(tables).toContain('CREATE TABLE IF NOT EXISTS price_data.scheduler_named_dispatches (`task_id` String, `block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `event_name` LowCardinality(String), `args_json` String, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY tuple() ORDER BY (task_id, block_height, event_index) SETTINGS index_granularity = 1024;')
  })

  it('captures both terminal named events, and prunes on an IN list', () => {
    expect(occurrences(views, 'price_data.scheduler_named_dispatches_mv')).toBe(1)
    expect(views).toContain(`WHERE (event_name IN ('Scheduler.Dispatched', 'Scheduler.CallUnavailable')) AND JSONHas(args_json, 'id')`)
    expect(views).toContain(`JSONExtractString(args_json, 'id') AS task_id`)
    // Scheduler.Scheduled and Scheduler.Canceled report {when, index} and never the name, so
    // they cannot be attributed to a task and must stay out of a name-keyed table.
    expect(occurrences(views, "'Scheduler.Scheduled'")).toBe(0)
    expect(occurrences(views, "'Scheduler.Canceled'")).toBe(0)
  })

  it('reads it by the derived name, with FINAL bounded by that key', () => {
    // Two reads and only two: the detail page's point lookup on the key prefix,
    // and the directory's bulk read — the latter unbounded on purpose, because
    // the projection IS the 545 named rows and the directory wants all of them.
    expect(occurrences(governanceService, 'price_data.scheduler_named_dispatches FINAL')).toBe(2)
    expect(governanceService).toContain('WHERE task_id = {task:String}')
    // Never by scanning the raw table for the name: the id is on 545 of its rows and finding
    // them means decoding args_json on every Scheduler event the scan reaches. The chain walk
    // does read raw Scheduler events, but only ever for a named list of block heights — the
    // table's sort-key prefix — so it is a point read per block and never a hunt for an id.
    expect(governanceService).not.toContain("JSONExtractString(args_json, 'id')")
    // The chain walk does read raw Scheduler events, but only ever for a named list of block
    // heights — the table's sort-key prefix — so it is a point read per block, never a hunt.
    // One WHERE and no PREWHERE beside it: this ClickHouse silently returns a fraction of the
    // matching rows for the two-clause form, which here would drop whole executions.
    expect(governanceService).toContain("WHERE block_height IN {blocks:Array(UInt32)} AND event_name LIKE 'Scheduler.%'")
    expect(governanceService).not.toContain('PREWHERE')
  })
})

// An approved call often does not DO the thing — it files the thing. Referendum 405 dispatched
// Ok at 14,672,011 having scheduled one anonymous task for 14,672,012, and everything it was
// voted through to do happened there, in a block its timeline never named. Attribution is the
// whole feature: an anonymous task carries no name to join on, so which Scheduled events belong
// to an enactment is decided by WHERE they sit between the scheduler's terminal events.
describe('the executions an enactment filed', () => {
  // Block 14,672,011 as the chain emitted it: the enactment ran as a batch that noted a
  // preimage and scheduled the next block, then closed with its own Dispatched at 216.
  const ref405Block = [
    { event_index: 213, event_name: 'Scheduler.Scheduled', args_json: '{"when":14672012,"index":0}' },
    { event_index: 216, event_name: 'Scheduler.Dispatched', args_json: '{"task":[14672011,0],"id":"0x790d","result":{"__kind":"Ok"}}' },
  ]

  it('credits the enactment with the task it filed', () => {
    expect(tasksFiledBy(ref405Block, 216)).toEqual([{ when: 14_672_012, index: 0 }])
  })

  // Block 8,438,295 ran six due tasks back to back, each filing one before closing. Only the
  // events after the previous terminal event are this dispatch's doing — reading everything
  // below its own index instead would hand one referendum five other tasks' work.
  const sixTasks = [
    { event_index: 72, event_name: 'Scheduler.Dispatched', args_json: '{"task":[8438295,0],"id":"0x4113","result":{"__kind":"Ok"}}' },
    { event_index: 73, event_name: 'Scheduler.Scheduled', args_json: '{"when":8475910,"index":0}' },
    { event_index: 74, event_name: 'Scheduler.Dispatched', args_json: '{"task":[8438295,1],"result":{"__kind":"Ok"}}' },
    { event_index: 75, event_name: 'Scheduler.Scheduled', args_json: '{"when":8481816,"index":11}' },
    { event_index: 76, event_name: 'Scheduler.Dispatched', args_json: '{"task":[8438295,2],"result":{"__kind":"Ok"}}' },
  ]

  it('gives each dispatch only what it filed, not the whole block', () => {
    // The first dispatch in the block filed nothing: its window opens at the block's start.
    expect(tasksFiledBy(sixTasks, 72)).toEqual([])
    expect(tasksFiledBy(sixTasks, 74)).toEqual([{ when: 8_475_910, index: 0 }])
    expect(tasksFiledBy(sixTasks, 76)).toEqual([{ when: 8_481_816, index: 11 }])
  })

  it('ignores what a later task files', () => {
    // 75 sits above this dispatch and belongs to the one that closes at 76.
    expect(tasksFiledBy(sixTasks, 74).map(t => t.when)).not.toContain(8_481_816)
  })

  // A CallUnavailable closes a task exactly as a Dispatched does, so it opens the next window.
  it('treats every terminal event as a window boundary', () => {
    const rows = [
      { event_index: 4, event_name: 'Scheduler.Scheduled', args_json: '{"when":900,"index":0}' },
      { event_index: 5, event_name: 'Scheduler.CallUnavailable', args_json: '{"task":[800,0],"id":"0x84c1"}' },
      { event_index: 6, event_name: 'Scheduler.Scheduled', args_json: '{"when":901,"index":0}' },
      { event_index: 7, event_name: 'Scheduler.Dispatched', args_json: '{"task":[800,1],"result":{"__kind":"Ok"}}' },
    ]
    expect(tasksFiledBy(rows, 7)).toEqual([{ when: 901, index: 0 }])
  })

  // The scheduled rows merge into the timeline by block like everything else, so a follow-on
  // sits after the enactment that filed it and before the refunds that trail both.
  it('places the filed executions in block order', () => {
    const enactment = {
      event_name: 'Scheduler.Dispatched', block_height: 14_672_011, event_index: 216,
      extrinsic_index: null, ts: '2026-09-15 10:00:00',
      args_json: '{"task":[14672011,0],"id":"0x790d","result":{"__kind":"Ok"}}',
    }
    const timeline = referendumTimelineFrom(
      [
        { event_name: 'Referenda.Confirmed', block_height: 14_671_711, extrinsic_index: null, ts: '2026-09-15 09:30:00' },
        { event_name: 'Referenda.SubmissionDepositRefunded', block_height: 14_700_000, extrinsic_index: 3, ts: '2026-09-16 09:30:00' },
      ],
      enactment,
      [{
        event: 'Scheduler.Dispatched', blockHeight: 14_672_012, extrinsicIndex: null,
        ts: '2026-09-15 10:00:06', timestamp: '2026-09-15 10:00:06', outcome: 'ok',
        scheduled: { depth: 1, state: 'ran' },
      } as never],
    )
    expect(timeline.map(e => e.blockHeight)).toEqual([14_671_711, 14_672_011, 14_672_012, 14_700_000])
    expect(timeline[2].scheduled).toEqual({ depth: 1, state: 'ran' })
    // The enactment itself is never marked scheduled — it is the thing that scheduled.
    expect(timeline[1].scheduled).toBeUndefined()
  })
})
