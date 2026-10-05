import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ClickHouseClient } from '../src/db/client.ts'
import {
  DATA_UPGRADES, DATA_UPGRADE_CHUNK_BLOCKS, applyDataUpgrades, applySchema, dataUpgradeChunks, dataUpgradeState,
  declaredObjects, mergeRanges, selectSchemaFiles, splitSqlStatements, swapView,
} from '../src/db/schemaBootstrap.ts'

const dir = new URL('../../clickhouse/schema/', import.meta.url)
const statements = selectSchemaFiles(readdirSync(dir)).flatMap(f => splitSqlStatements(readFileSync(new URL(f, dir), 'utf8')))

describe('schema data upgrades', () => {
  // The backfill must be the MV's own SELECT/WHERE, or an upgraded database would
  // hold different rows than a fresh one.
  it('replays exactly the MV SELECT of each upgraded table', () => {
    for (const u of DATA_UPGRADES) {
      const mv = statements.find(st => new RegExp(`CREATE MATERIALIZED VIEW IF NOT EXISTS \\S+ TO ${u.table.replace('.', '\\.')} `).test(st))
      expect(mv, u.table).toBeDefined()
      expect(mv).toContain(`AS SELECT ${u.select} FROM price_data.raw_events WHERE raw_events.event_name = '${u.eventName}'`)
    }
  })

  it('covers raw\'s first record through its head in chunks', () => {
    expect(dataUpgradeChunks(null, 100)).toEqual([])
    const C = DATA_UPGRADE_CHUNK_BLOCKS
    expect(dataUpgradeChunks(50, 50 + C)).toEqual([{ from: 50, to: 50 + C }, { from: 50 + C, to: 51 + C }])
    expect(mergeRanges([{ from: 3, to: 5 }, { from: 0, to: 3 }, { from: 9, to: 10 }])).toEqual([{ from: 0, to: 5 }, { from: 9, to: 10 }])
  })

  it('names every declared table and view for validation', () => {
    const names = declaredObjects(statements)
    expect(names).toContain('price_data.gigahdx_reward_records')
    expect(names).toContain('price_data.gigahdx_reward_records_mv')
    expect(names).toContain('price_data.account_activity_v3')
    expect(names.length).toBeGreaterThan(350)
  })
})

// ClickHouse substitutes a SELECT alias into WHERE: `concat(database, '.', name) AS
// name … WHERE concat(database, '.', name) IN …` matched nothing, so the MV upgrade
// plan was always empty and validation saw every object as missing.
describe('system.tables lookups', () => {
  it('never alias the qualified name as `name`', () => {
    const src = readFileSync(new URL('../src/db/schemaBootstrap.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/concat\(database, '\.', name\) AS name\b/)
    expect(src.match(/AS qname, create_table_query/g)?.length).toBe(2)
  })
})

// An in-memory raw_events + upgraded table, answering the bootstrap's own queries
// by their query_params, so the coverage logic runs against real chunk arithmetic.
function fakeUpgradeDb(rawBlocks: number[], opts: { failInsertFrom?: number } = {}) {
  const u = DATA_UPGRADES[0]
  const table = new Set<number>()
  let failNext = opts.failInsertFrom
  const queries: string[] = []
  const inRange = (b: number, p: Record<string, unknown>) => b >= Number(p.lo) && b < Number(p.hi)
  const client = {
    async query({ query, query_params = {} }: { query: string; query_params?: Record<string, unknown> }) {
      queries.push(query)
      let v: number | null
      if (/SELECT max\(block_height\) AS v FROM price_data\.raw_events/.test(query)) v = Math.max(...rawBlocks)
      else if (/NOT IN/.test(query)) v = rawBlocks.filter(b => inRange(b, query_params) && !table.has(b)).length
      else if (/min\(block_height\)/.test(query)) { const m = rawBlocks.filter(b => inRange(b, query_params)); v = m.length ? Math.min(...m) : null }
      else throw new Error('unexpected query ' + query)
      return { json: async () => [{ v }] }
    },
    async command({ query, query_params = {} }: { query: string; query_params?: Record<string, unknown> }) {
      queries.push(query)
      expect(query).toContain(`INSERT INTO ${u.table}`)
      if (failNext != null && Number(query_params.lo) >= failNext) { failNext = undefined; throw new Error('chunk insert failed') }
      for (const b of rawBlocks) if (inRange(b, query_params)) table.add(b)
      return {}
    },
  }
  return { client: client as unknown as ClickHouseClient, table, queries }
}

describe('data upgrade coverage', () => {
  const C = DATA_UPGRADE_CHUNK_BLOCKS
  const first = DATA_UPGRADES[0].fromBlock + 10
  // Rows in three chunks: [first], [first + C .. ], [first + 2C ..].
  const raw = [first, first + 5, first + C + 1, first + C + 7, first + 2 * C + 3]

  it('is incomplete after a later chunk fails, though the table reaches raw\'s first record', async () => {
    const db = fakeUpgradeDb(raw, { failInsertFrom: first + C })
    await expect(applyDataUpgrades(db.client)).rejects.toThrow('chunk insert failed')
    expect(db.table.has(first)).toBe(true) // the lowest row IS present — a boundary test would call this complete
    const [state] = await dataUpgradeState(db.client)
    expect(state.incomplete).toEqual([{ from: first + C, to: first + 2 * C }, { from: first + 2 * C, to: first + 2 * C + 4 }])
    expect(state.missing).toEqual([{ from: first + C, to: first + 2 * C + 4 }])
    // The re-run replays only the incomplete chunks, then the state is complete.
    expect(await applyDataUpgrades(db.client)).toBe(2)
    expect([...db.table].sort((a, b) => a - b)).toEqual(raw)
    expect((await dataUpgradeState(db.client))[0].incomplete).toEqual([])
    expect(await applyDataUpgrades(db.client)).toBe(0)
  })

  it('finds a hole in the middle of the table', async () => {
    const db = fakeUpgradeDb(raw)
    for (const b of raw) if (b !== first + C + 7) db.table.add(b)
    expect((await dataUpgradeState(db.client))[0].incomplete).toEqual([{ from: first + C, to: first + 2 * C }])
  })

  // On CH 26.3 an explicit PREWHERE paired with a separate WHERE silently returns a
  // fraction of the rows: every raw read keeps its predicates in one PREWHERE.
  it('never pairs a PREWHERE with a separate WHERE on raw', async () => {
    const db = fakeUpgradeDb(raw, { failInsertFrom: first + C })
    await applyDataUpgrades(db.client).catch(() => {})
    await applyDataUpgrades(db.client)
    for (const q of db.queries.filter(q => q.includes('PREWHERE'))) {
      const afterPrewhere = q.slice(q.indexOf('PREWHERE')).split(/\)\s*WHERE/)[0]
      expect(afterPrewhere, q).not.toMatch(/\bWHERE\b/)
    }
  })
})

// A fake server holding one view: DROP/CREATE change `live` exactly as ClickHouse
// would; `lose` makes a statement EXECUTE and then still throw at the client (the
// ambiguous timeout), `refuse` makes it throw without executing. `failReads` makes the
// next N system.tables readbacks throw; `slowDrop` makes the DROP throw at the client
// while it is still running for that many system.processes polls, and only then drop;
// `slowRestore` does the same to the restore (a CREATE of the captured `restoreOf` text);
// `hangingDrop` makes the DROP take effect at once yet throw at the client and stay in
// system.processes for that many polls (its completion changes nothing further);
// `linger` makes a statement execute and RETURN normally at the client, yet stay listed
// in system.processes for that many polls.
// system.processes is modelled per query_id: every poll is one tick for every running
// statement, and it answers the count of ONLY the ids it was asked about. Each poll's
// ids and settings are recorded (`polls`), so a test can assert what was waited for.
// The server clock advances a second per read, from 12:00:00.
function fakeViewDb(initial: string | null, opts: { lose?: (q: string) => boolean; refuse?: (q: string) => boolean; failReads?: number; slowDrop?: number; slowRestore?: number; hangingDrop?: number; linger?: (q: string) => number } = {}) {
  const running = new Map<string, { left: number; settle: () => void }>()
  const state = { live: initial as string | null, commands: [] as string[], queryIds: [] as Array<string | undefined>, reads: 0, polls: [] as Array<{ ids: string[]; query: string }>, failReads: opts.failReads ?? 0, clock: 0 }
  const run = (id: string | undefined, left: number, settle: () => void) => { expect(id, 'every statement runs under a query_id').toBeTruthy(); running.set(id!, { left, settle }) }
  const client = {
    command: vi.fn(async ({ query, query_id }: { query: string; query_id?: string }) => {
      state.commands.push(query)
      state.queryIds.push(query_id)
      if (opts.refuse?.(query)) throw new Error('refused')
      if (query.startsWith('DROP VIEW') && opts.slowDrop) { run(query_id, opts.slowDrop, () => { state.live = null }); throw new Error('Timeout error') }
      if (query.startsWith('DROP VIEW') && opts.hangingDrop) { state.live = null; run(query_id, opts.hangingDrop, () => {}); throw new Error('Timeout error') }
      if (query === initial && opts.slowRestore && state.live == null) {
        run(query_id, opts.slowRestore, () => { state.live = query })
        throw new Error('Timeout error')
      }
      if (query.startsWith('DROP VIEW')) state.live = null
      else if (query.startsWith('CREATE')) {
        if (state.live != null && !/IF NOT EXISTS/.test(query)) throw new Error('already exists')
        if (state.live == null) state.live = query
      }
      const lingers = opts.linger?.(query) ?? 0
      if (lingers > 0) run(query_id, lingers, () => {})
      if (opts.lose?.(query)) throw new Error('Timeout error')
    }),
    query: vi.fn(async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      if (query.includes('system.processes')) {
        expect(query).toContain('query_id IN {ids:Array(String)}')
        const ids = query_params?.ids as string[]
        expect(Array.isArray(ids) && ids.length > 0).toBe(true)
        state.polls.push({ ids: [...ids], query })
        for (const [id, r] of [...running]) if (--r.left === 0) { running.delete(id); r.settle() }
        return { json: async () => [{ n: String(ids.filter(id => running.has(id)).length) }] }
      }
      if (query.includes('now()')) return { json: async () => [{ t: `2026-10-05 12:00:${String(state.clock++).padStart(2, '0')}` }] }
      state.reads++
      if (state.failReads > 0) { state.failReads--; throw new Error('connect ECONNRESET') }
      return { json: async () => state.live == null ? [] : [{ q: state.live }] }
    }),
  } as unknown as ClickHouseClient
  return { client, state }
}
const noSleep = { sleep: async () => {} }

describe('MV upgrade swap', () => {
  const OLD = 'CREATE MATERIALIZED VIEW price_data.v_mv AS SELECT 1 FROM hand_list'
  const NEW = 'CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.v_mv AS SELECT 1 FROM erc20_wallet_contracts'
  const MARK = 'erc20_wallet_contracts'
  // An MV_UPGRADES entry whose catch-up is a spy recording the windows it was run over.
  const up = (backfill: string) => ({ marker: MARK, backfill, catchUp: vi.fn(async (_c: ClickHouseClient, w: { from: string; to: string }) => `filled ${w.from}..${w.to}`) })
  // The swap's own settle poll asks for exactly its DROP's and CREATE's query_ids.
  const expectSwapPoll = (db: ReturnType<typeof fakeViewDb>) => {
    const [poll] = db.state.polls
    expect(poll.ids).toHaveLength(2)
    expect(poll.ids[0]).toBe(db.state.queryIds[0])
    if (db.state.queryIds.length > 1 && db.state.commands[1] === NEW) expect(poll.ids[1]).toBe(db.state.queryIds[1])
    expect(new Set(poll.ids).size).toBe(2)
  }

  // A clean swap leaves a window — rows inserted between the DROP and the CREATE
  // reached no view — so its catch-up runs over exactly that window, every time.
  it('swaps a view, checks the new definition is live, and runs the catch-up for its window', async () => {
    const db = fakeViewDb(OLD)
    const u = up('the catch-up')
    expect(await swapView(db.client, 'price_data.v_mv', OLD, NEW, u, noSleep)).toBe(2)
    expect(db.state.live).toBe(NEW)
    // Settlement is checked on the clean path too, for the two statements it sent.
    expect(db.state.polls).toHaveLength(1)
    expectSwapPoll(db)
    expect(db.state.polls[0].ids).toEqual(db.state.queryIds)
    // The window opens before the DROP (first clock read) and closes after the CREATE.
    expect(u.catchUp).toHaveBeenCalledTimes(1)
    expect(u.catchUp).toHaveBeenCalledWith(db.client, { from: '2026-10-05 12:00:00', to: '2026-10-05 12:00:01' })
    expect(u.catchUp.mock.invocationCallOrder[0]).toBeGreaterThan((db.client.command as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[1])
  })

  // The new definition reads back, but the DROP is still listed in system.processes:
  // no success is claimed and no catch-up is run.
  it('reports UNKNOWN, not success, when the new marker reads back but the drop is still running', async () => {
    const db = fakeViewDb(OLD, { linger: q => q.startsWith('DROP') ? 50 : 0 })
    const u = up('the catch-up')
    const err = await swapView(db.client, 'price_data.v_mv', OLD, NEW, u, { ...noSleep, settleAttempts: 4 }).then(() => new Error('resolved'), e => e as Error)
    expect(db.state.live).toBe(NEW) // the marker IS visible
    expect(err.message).toMatch(/NEW definition reads back live.*state is UNKNOWN.*still in system\.processes.*NO catch-up was run.*the catch-up/)
    expect(err.message).toContain(db.state.queryIds[0]!)
    expect(db.state.polls).toHaveLength(4)
    for (const poll of db.state.polls) expect(poll.ids).toEqual(db.state.queryIds)
    expect(u.catchUp).not.toHaveBeenCalled()
  })

  it('succeeds once a lingering drop leaves system.processes within the wait', async () => {
    const db = fakeViewDb(OLD, { linger: q => q.startsWith('DROP') ? 3 : 0 })
    const u = up('x')
    expect(await swapView(db.client, 'price_data.v_mv', OLD, NEW, u, { ...noSleep, settleAttempts: 4 })).toBe(2)
    expect(db.state.polls).toHaveLength(3)
    expect(u.catchUp).toHaveBeenCalledTimes(1)
  })

  // A statement of SOMETHING ELSE still running is not this swap's business: the poll
  // asks only for the swap's own ids, and the server answers only for those.
  it('waits only for its own query ids', async () => {
    const db = fakeViewDb(OLD, { linger: q => q === 'SELECT sleep(3)' ? 50 : 0 })
    await db.client.command({ query: 'SELECT sleep(3)', query_id: 'unrelated' })
    expect(await swapView(db.client, 'price_data.v_mv', OLD, NEW, up('x'), { ...noSleep, settleAttempts: 2 })).toBe(2)
    expect(db.state.polls).toHaveLength(1)
    expect(db.state.polls[0].ids).toEqual(db.state.queryIds.slice(1))
    expect(db.state.polls[0].ids).not.toContain('unrelated')
  })

  it('fails the upgrade, naming the window, when the catch-up after a clean swap fails', async () => {
    const db = fakeViewDb(OLD)
    const u = { ...up('the catch-up'), catchUp: vi.fn(async () => { throw new Error('insert refused') }) }
    await expect(swapView(db.client, 'price_data.v_mv', OLD, NEW, u, { ...noSleep, attempts: 2 })).rejects.toThrow(/NEW definition is live, but its catch-up for rows inserted between 2026-10-05 12:00:00 and 2026-10-05 12:00:01.*insert refused.*the catch-up/)
    expect(u.catchUp).toHaveBeenCalledTimes(2) // retried: it is idempotent
    expect(db.state.live).toBe(NEW)
  })

  it('restores the old view and names the gap when the new definition is refused', async () => {
    const db = fakeViewDb(OLD, { refuse: q => q === NEW })
    const u = up('the catch-up')
    await expect(swapView(db.client, 'price_data.v_mv', OLD, NEW, u, noSleep)).rejects.toThrow(/old definition was restored.*between 2026-10-05 12:00:00 and 2026-10-05 12:00:01.*missed both views; its catch-up filled them/)
    expect(db.state.commands).toEqual(['DROP VIEW IF EXISTS price_data.v_mv', NEW, OLD])
    expect(db.state.live).toBe(OLD)
    expectSwapPoll(db)
    // The gap closes at the restore: the catch-up runs over drop..restore.
    expect(u.catchUp).toHaveBeenCalledWith(db.client, { from: '2026-10-05 12:00:00', to: '2026-10-05 12:00:01' })
  })

  // The case the old code missed: the DROP executes on the server, the client
  // times out, and the error used to leave before anything was checked or restored.
  it('restores the old view when the drop executed but the client errored', async () => {
    const db = fakeViewDb(OLD, { lose: q => q.startsWith('DROP') })
    await expect(swapView(db.client, 'price_data.v_mv', OLD, NEW, up('the catch-up'), noSleep)).rejects.toThrow(/Timeout error.*old definition was restored.*missed both views; its catch-up filled them/)
    expectSwapPoll(db)
    expect(db.state.commands).toEqual(['DROP VIEW IF EXISTS price_data.v_mv', OLD])
    expect(db.state.live).toBe(OLD)
  })

  it('reports nothing missed when the drop never ran', async () => {
    const db = fakeViewDb(OLD, { refuse: q => q.startsWith('DROP') })
    await expect(swapView(db.client, 'price_data.v_mv', OLD, NEW, up('x'), noSleep)).rejects.toThrow(/OLD definition is still live.*no rows were missed/)
    expect(db.state.live).toBe(OLD)
  })

  // A DROP that reports success without running turns `CREATE … IF NOT EXISTS` into a no-op.
  it('fails when a clean CREATE left the old definition live', async () => {
    const db = fakeViewDb(OLD)
    const client = { ...db.client, command: vi.fn(async ({ query }: { query: string }) => { if (!query.startsWith('DROP')) await db.client.command({ query }) }) } as unknown as ClickHouseClient
    await expect(swapView(client, 'price_data.v_mv', OLD, NEW, up('x'), noSleep)).rejects.toThrow(/OLD definition is still live/)
  })

  it('succeeds when the create executed but the client errored, and runs the catch-up', async () => {
    const db = fakeViewDb(OLD, { lose: q => q === NEW })
    const u = up('x')
    expect(await swapView(db.client, 'price_data.v_mv', OLD, NEW, u, noSleep)).toBe(2)
    expect(db.state.live).toBe(NEW)
    expectSwapPoll(db)
    expect(u.catchUp).toHaveBeenCalledWith(db.client, { from: '2026-10-05 12:00:00', to: '2026-10-05 12:00:01' })
  })

  it('says the view is absent when the restore fails too', async () => {
    const db = fakeViewDb(OLD, { refuse: q => q.startsWith('CREATE') })
    const u = up('x')
    await expect(swapView(db.client, 'price_data.v_mv', OLD, NEW, u, noSleep)).rejects.toThrow(/ABSENT.*since 2026-10-05 12:00:00/)
    expect(u.catchUp).not.toHaveBeenCalled()
    expect(db.state.live).toBeNull()
  })

  it('retries a readback that fails transiently, then restores', async () => {
    const db = fakeViewDb(OLD, { lose: q => q.startsWith('DROP'), failReads: 3 })
    await expect(swapView(db.client, 'price_data.v_mv', OLD, NEW, up('the catch-up'), noSleep)).rejects.toThrow(/old definition was restored.*its catch-up filled them/)
    expect(db.state.live).toBe(OLD)
    expect(db.state.reads).toBeGreaterThanOrEqual(5)
  })

  it('says the view may be absent when it can never be read back, without guessing', async () => {
    const db = fakeViewDb(OLD, { lose: q => q.startsWith('DROP'), failReads: 100 })
    await expect(swapView(db.client, 'price_data.v_mv', OLD, NEW, up('x'), { ...noSleep, attempts: 3 })).rejects.toThrow(/could not be read back.*failed after 3 attempts.*may be ABSENT/)
    expect(db.state.commands).toEqual(['DROP VIEW IF EXISTS price_data.v_mv'])
  })

  // The restore's own client error is as ambiguous as the swap's: it executed, the
  // response was lost. Read back, it is restored — not "absent", and not retried into
  // an "already exists".
  it('reconciles a restore whose response failed by reading it back', async () => {
    const db = fakeViewDb(OLD, { lose: q => q.startsWith('DROP') || q === OLD })
    await expect(swapView(db.client, 'price_data.v_mv', OLD, NEW, up('x'), noSleep)).rejects.toThrow(/old definition was restored — rows inserted between/)
    expect(db.state.commands).toEqual(['DROP VIEW IF EXISTS price_data.v_mv', OLD])
    expect(db.state.live).toBe(OLD)
  })

  it('retries a restore that did not take while the view is still absent', async () => {
    let refusals = 2
    const db = fakeViewDb(OLD, { lose: q => q.startsWith('DROP'), refuse: q => q === OLD && refusals-- > 0 })
    await expect(swapView(db.client, 'price_data.v_mv', OLD, NEW, up('x'), noSleep)).rejects.toThrow(/old definition was restored/)
    expect(db.state.commands.filter(c => c === OLD)).toHaveLength(3)
    expect(db.state.live).toBe(OLD)
  })

  // The DROP's client errors while the server is still executing it: read back at once,
  // the old view is still there and the swap would report "nothing missed" — then the
  // DROP lands and the view is gone. Waiting for it to leave system.processes first
  // sees the absent view, and restores it.
  it('waits for a still-running drop before deciding nothing was missed', async () => {
    const db = fakeViewDb(OLD, { slowDrop: 3 })
    await expect(swapView(db.client, 'price_data.v_mv', OLD, NEW, up('the catch-up'), noSleep)).rejects.toThrow(/old definition was restored.*missed both views/)
    expect(db.state.polls).toHaveLength(3)
    for (const poll of db.state.polls) expect(poll.ids[0]).toBe(db.state.queryIds[0])
    expect(db.state.live).toBe(OLD)
  })

  it('never claims nothing was missed while the drop is still running', async () => {
    const db = fakeViewDb(OLD, { slowDrop: 50 })
    await expect(swapView(db.client, 'price_data.v_mv', OLD, NEW, up('x'), { ...noSleep, settleAttempts: 4 })).rejects.toThrow(/still in system\.processes.*DROP may still be executing/)
  })

  // The view reads back absent while the DROP is still in system.processes after the
  // wait: a restore now could be dropped again by the DROP completing after it, and
  // reported "restored" while the view is gone. Nothing is restored; UNKNOWN, naming
  // the unsettled query ids.
  it('reports UNKNOWN and issues no restore while an absent view\'s drop is unsettled', async () => {
    const db = fakeViewDb(OLD, { hangingDrop: 50 })
    const u = up('the catch-up')
    const err = await swapView(db.client, 'price_data.v_mv', OLD, NEW, u, { ...noSleep, settleAttempts: 4 }).then(() => new Error('resolved'), e => e as Error)
    expect(u.catchUp).not.toHaveBeenCalled()
    expect(err.message).toMatch(/state is UNKNOWN.*still in system\.processes.*NO restore was issued.*re-run.*the catch-up/)
    expect(err.message).toContain(db.state.queryIds[0]!)
    expect(err.message).not.toMatch(/restored|is ABSENT/)
    expect(db.state.commands).toEqual(['DROP VIEW IF EXISTS price_data.v_mv'])
    expect(db.state.polls).toHaveLength(4)
    for (const poll of db.state.polls) expect(poll.ids[0]).toBe(db.state.queryIds[0])
    expect(db.state.live).toBeNull()
  })

  it('restores an absent view once the drop has settled, and reads the restore back', async () => {
    const db = fakeViewDb(OLD, { hangingDrop: 3 })
    await expect(swapView(db.client, 'price_data.v_mv', OLD, NEW, up('the catch-up'), noSleep)).rejects.toThrow(/old definition was restored.*missed both views; its catch-up filled them/)
    expect(db.state.commands).toEqual(['DROP VIEW IF EXISTS price_data.v_mv', OLD])
    expect(db.state.polls).toHaveLength(3)
    expect(db.state.reads).toBe(2) // the swap's readback, then the restore's
    expect(db.state.live).toBe(OLD)
  })

  // The restore's client errors while the server is still executing it. Read back at
  // once, the view is absent and would be declared ABSENT (or the restore re-sent into an
  // "already exists"); waiting for its query_id to leave system.processes first finds it
  // restored.
  it('waits for a still-running restore before deciding the view is absent', async () => {
    const db = fakeViewDb(OLD, { lose: q => q.startsWith('DROP'), slowRestore: 3 })
    await expect(swapView(db.client, 'price_data.v_mv', OLD, NEW, up('the catch-up'), noSleep)).rejects.toThrow(/old definition was restored.*missed both views; its catch-up filled them/)
    expect(db.state.commands.filter(c => c === OLD)).toHaveLength(1)
    expect(db.state.polls).toHaveLength(1 + 3) // the swap's settle, then the restore's
    expectSwapPoll(db)
    // The restore's polls ask for the restore's own query_id only.
    const restoreId = db.state.queryIds[db.state.commands.indexOf(OLD)]
    for (const poll of db.state.polls.slice(1)) expect(poll.ids).toEqual([restoreId])
    expect(db.state.live).toBe(OLD)
    // Every statement, the restore included, ran under a query_id it can be settled by.
    expect(db.state.queryIds.every(id => typeof id === 'string' && id.length > 0)).toBe(true)
  })

  it('reports UNKNOWN, never ABSENT, while the restore is still running after the wait', async () => {
    const db = fakeViewDb(OLD, { lose: q => q.startsWith('DROP'), slowRestore: 50 })
    const u = up('the catch-up')
    const err = await swapView(db.client, 'price_data.v_mv', OLD, NEW, u, { ...noSleep, settleAttempts: 4 }).then(() => new Error("resolved"), e => e as Error)
    expect(u.catchUp).not.toHaveBeenCalled()
    expect(err.message).toMatch(/UNKNOWN \(restore may still be running\).*query_id .*still in system\.processes.*the catch-up/)
    expect(err.message).not.toMatch(/is ABSENT/)
    // Not re-sent behind a CREATE that may still land.
    expect(db.state.commands.filter(c => c === OLD)).toHaveLength(1)
  })

  it('reports UNKNOWN when the restored state can never be read back', async () => {
    const db = fakeViewDb(OLD, { lose: q => q.startsWith('DROP') })
    let reads = 0
    const client = {
      ...db.client,
      query: vi.fn(async (args: { query: string }) => {
        if (args.query.includes('system.tables') && ++reads > 1) throw new Error('connect ECONNRESET')
        return (db.client.query as unknown as (a: { query: string }) => Promise<unknown>)(args)
      }),
    } as unknown as ClickHouseClient
    const err = await swapView(client, 'price_data.v_mv', OLD, NEW, up('x'), { ...noSleep, attempts: 2 }).then(() => new Error("resolved"), e => e as Error)
    expect(err.message).toMatch(/UNKNOWN \(it could not be read back\)/)
    expect(err.message).not.toMatch(/is ABSENT/)
  })

  // The erc20 view's catch-up is the refresher's own insert-only-missing fill, over the
  // buckets holding Transfer logs INGESTED in the window (± the margin).
  it('wires the erc20 view\'s catch-up to the bounded insert-only-missing fill over the window', async () => {
    const { MV_UPGRADES } = await import('../src/db/schemaBootstrap.ts')
    const { CATCHUP_INSERT_SQL, CATCHUP_WINDOW_BUCKETS_SQL, CATCHUP_BUCKET_BLOCKS, CATCHUP_WINDOW_MARGIN_SECONDS } = await import('../src/services/erc20WalletService.ts')
    const u = MV_UPGRADES.find(m => m.name === 'price_data.erc20_transfer_deltas_mv')!
    const A = '0x531a654d1696ed52e7275a8cede955e82620f99a'
    const B = '0x6a21891db0940491603f3cca0a9f4dba4c6e810c'
    const params: Array<Record<string, unknown> | undefined> = []
    const inserts: Array<Record<string, unknown>> = []
    const client = {
      query: vi.fn(async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
        params.push(query_params)
        if (query.includes('erc20:wallet-contracts:current')) return { json: async () => [{ contract: A, asset_id: 222, active: 1 }, { contract: B, asset_id: 69, active: 1 }, { contract: '0xdead', asset_id: 1, active: 0 }] }
        expect(query).toBe(CATCHUP_WINDOW_BUCKETS_SQL)
        return { json: async () => [{ contract: A, bucket: '154' }, { contract: B, bucket: 154 }] }
      }),
      command: vi.fn(async ({ query, query_params }: { query: string; query_params: Record<string, unknown> }) => { expect(query).toBe(CATCHUP_INSERT_SQL); inserts.push(query_params) }),
    } as unknown as ClickHouseClient
    const summary = await u.catchUp(client, { from: '2026-10-05 12:00:00', to: '2026-10-05 12:00:07' })
    expect(params[1]).toEqual({ cs: [A, B], size: CATCHUP_BUCKET_BLOCKS, from: '2026-10-05 12:00:00', to: '2026-10-05 12:00:07', margin: CATCHUP_WINDOW_MARGIN_SECONDS })
    const lo = 154 * CATCHUP_BUCKET_BLOCKS
    expect(inserts).toEqual([{ c: A, lo, hi: lo + CATCHUP_BUCKET_BLOCKS - 1 }, { c: B, lo, hi: lo + CATCHUP_BUCKET_BLOCKS - 1 }])
    expect(summary).toMatch(/2 bucket\(s\) of 2 contract\(s\)/)
    // The window is read by INGEST time, widened on both sides.
    expect(CATCHUP_WINDOW_BUCKETS_SQL).toMatch(/ingested_at BETWEEN \{from:DateTime\} - INTERVAL \{margin:UInt32\} SECOND AND \{to:DateTime\} \+ INTERVAL \{margin:UInt32\} SECOND/)
  })

  it('declares a marker for every MV upgrade, present in its schema definition', async () => {
    const { MV_UPGRADES, createStatementFor } = await import('../src/db/schemaBootstrap.ts')
    for (const u of MV_UPGRADES) {
      expect(u.marker, u.name).toMatch(/\S/)
      expect(typeof u.catchUp, u.name).toBe('function')
      expect(createStatementFor(statements, u.name), u.name).toContain(u.marker)
    }
  })

  it('applySchema captures the live definition and puts it back on a failed create', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schema-'))
    const name = 'price_data.erc20_transfer_deltas_mv'
    const newCreate = `CREATE MATERIALIZED VIEW IF NOT EXISTS ${name} TO price_data.t AS SELECT 1 FROM erc20_wallet_contracts`
    writeFileSync(join(dir, '001_x.sql'), newCreate + ';\n')
    const oldCreate = `CREATE MATERIALIZED VIEW ${name} TO price_data.t AS SELECT 1 FROM hand_list`
    const db = fakeViewDb(oldCreate, { refuse: q => q === newCreate && db.state.commands.filter(c => c === newCreate).length > 1 })
    const query = db.client.query as unknown as (a: { query: string }) => Promise<{ json: () => Promise<unknown[]> }>
    const client = { command: db.client.command, query: vi.fn(async (a: { query: string }) => a.query.includes('IN {names') ? { json: async () => db.state.live == null ? [] : [{ qname: name, q: db.state.live }] } : query(a)) } as unknown as ClickHouseClient
    await expect(applySchema(client, { schemaDir: dir })).rejects.toThrow(/old definition was restored/)
    expect(db.state.commands.slice(1)).toEqual([`DROP VIEW IF EXISTS ${name}`, newCreate, oldCreate])
    expect(db.state.live).toBe(oldCreate)
  })
})

// A column added by `ALTER TABLE … ADD COLUMN` that never ran leaves the table present
// and every object check green, while every insert naming the column fails.
describe('schema validation compares columns', () => {
  it('reads every declared column with its type, through comments, indexes and ADD COLUMNs', async () => {
    const { declaredColumns } = await import('../src/db/schemaBootstrap.ts')
    const cols = declaredColumns([
      "CREATE TABLE IF NOT EXISTS price_data.t\n(\n    `a` UInt32,\n    -- the manager's key, 'quoted', (paren\n    `b` Nullable(String) DEFAULT NULL,\n    `c` Array(Tuple(x UInt8, y String)) CODEC(ZSTD(1)),\n    `d` Enum8('in' = 1, 'out' = 2),\n    INDEX idx_a a TYPE minmax GRANULARITY 1\n)\nENGINE = MergeTree ORDER BY a",
      'ALTER TABLE price_data.t ADD COLUMN IF NOT EXISTS `e` UInt64 DEFAULT 0 AFTER `d`',
      'CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.t_mv TO price_data.t (`a` UInt32) AS SELECT 1 AS a',
    ])
    expect([...cols.keys()]).toEqual(['price_data.t'])
    expect([...cols.get('price_data.t')!]).toEqual([
      ['a', 'UInt32'], ['b', 'Nullable(String)'], ['c', 'Array(Tuple(x UInt8, y String))'], ['d', "Enum8('in' = 1, 'out' = 2)"], ['e', 'UInt64'],
    ])
    // The real schema: every declared table has its columns read.
    const real = declaredColumns(statements)
    const tables = declaredObjects(statements).filter(n => statements.some(st => st.replace(/^(?:--[^\n]*\n\s*)*/, '').startsWith(`CREATE TABLE IF NOT EXISTS ${n}`)))
    for (const t of tables) expect(real.get(t)?.size, t).toBeGreaterThan(0)
    expect(real.get('price_data.account_activity_totals')?.get('raw_mm_keys')).toBe('UInt64')
    expect(real.get('price_data.account_activity_totals')?.get('raw_change')).toBe('UInt64')
    expect(real.get('price_data.account_activity_totals')?.get('raw_mm_change')).toBe('DateTime')
    expect(real.get('price_data.account_activity_totals')?.get('raw_mm_fp')).toBe('UInt64')
  })

  it('fails validation on a missed ADD COLUMN and on a changed type, whitespace aside', async () => {
    const { validateSchema } = await import('../src/db/schemaBootstrap.ts')
    const dir = mkdtempSync(join(tmpdir(), 'schema-cols-'))
    writeFileSync(join(dir, '001_t.sql'), [
      'CREATE TABLE IF NOT EXISTS price_data.t (`a` UInt32, `b` Decimal(38,18), `c` String) ENGINE = MergeTree ORDER BY a;',
      'ALTER TABLE price_data.t ADD COLUMN IF NOT EXISTS `d` UInt64 DEFAULT 0;',
    ].join('\n'))
    const liveColumns = [{ column: 'a', type: 'UInt32' }, { column: 'b', type: 'Decimal(38, 18)' }, { column: 'c', type: 'Nullable(String)' }]
    const client = {
      query: vi.fn(async ({ query }: { query: string }) => ({
        json: async () => query.includes('system.columns') ? liveColumns.map(c => ({ qname: 'price_data.t', ...c }))
          : query.includes('system.tables') ? [{ qname: 'price_data.t', q: 'CREATE TABLE price_data.t' }]
          : [{ v: null }],
      })),
    } as unknown as ClickHouseClient
    expect(await validateSchema(client, dir)).toEqual([
      'column type differs: price_data.t.c is Nullable(String), declared String',
      'missing column: price_data.t.d UInt64',
    ])
    liveColumns[2].type = 'String'
    liveColumns.push({ column: 'd', type: 'UInt64' })
    expect(await validateSchema(client, dir)).toEqual([])
  })
})
