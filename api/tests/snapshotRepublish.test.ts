import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ClickHouseClient } from '../src/db/client.ts'
import { REPUBLISH_FLOOR_MS, skipDecision, type PublishedGeneration } from '../src/services/snapshotRepublish.ts'
import {
  blockProjector, lockRowChecksumFields, persistLockSnapshot, snapProjection, PROJECTION_GRID_MS,
  type BreakdownRow,
} from '../src/services/lockBreakdownService.ts'
import {
  moneyMarketClaimChecksumFields, omnipoolClaimChecksumFields, samePriceGeneration,
} from '../src/services/explorerService.ts'

// The account-value snapshot generations are republished only when they
// changed. Everything below pins the properties that makes that safe: the
// checksum covers every stored column, an intact partition is required, the
// floor still forces a periodic rebuild, and the dated rows hold still while
// the locks behind them do.

const published = (over: Partial<PublishedGeneration> = {}): PublishedGeneration =>
  ({ snapshotId: '1', checksum: 'abc', rowCount: 10, ageMs: 60_000, ...over })

describe('republish skip decision', () => {
  it('skips only a byte-identical generation whose partition is intact and young', () => {
    expect(skipDecision(published(), { checksum: 'abc', rowCount: 10 }, 10)).toBe(true)
  })

  it('republishes whenever the published generation cannot be trusted to match', () => {
    const cases: [string, boolean][] = [
      ['nothing published yet', skipDecision(null, { checksum: 'abc', rowCount: 10 }, 10)],
      ['checksum differs', skipDecision(published(), { checksum: 'zzz', rowCount: 10 }, 10)],
      ['row count differs', skipDecision(published(), { checksum: 'abc', rowCount: 11 }, 11)],
      ['partition dropped underneath the pointer', skipDecision(published(), { checksum: 'abc', rowCount: 10 }, 0)],
      ['partition holds fewer rows than the pointer claims', skipDecision(published(), { checksum: 'abc', rowCount: 10 }, 9)],
      ['floor reached', skipDecision(published({ ageMs: REPUBLISH_FLOOR_MS }), { checksum: 'abc', rowCount: 10 }, 10)],
      ['floor exceeded', skipDecision(published({ ageMs: REPUBLISH_FLOOR_MS + 1 }), { checksum: 'abc', rowCount: 10 }, 10)],
    ]
    expect(cases).toHaveLength(7)
    for (const [reason, decision] of cases) expect(decision, reason).toBe(false)
  })
})

// A fake ClickHouse client that answers the two reads the skip decision makes
// and records every write, so "did not republish" can be asserted as "wrote
// nothing" rather than inferred.
function fakeClient(state: { snapshotId: string; checksum: string; rowCount: number; ageSeconds: number } | null, partitionRows: number) {
  const inserts: string[] = []
  const commands: string[] = []
  const client = {
    query: async ({ query }: { query: string }) => ({
      json: async () => {
        if (query.includes('account_lock_snapshot_state')) {
          return state
            ? [{ snapshot_id: state.snapshotId, checksum: state.checksum, row_count: state.rowCount, age_seconds: state.ageSeconds }]
            : [{ snapshot_id: '', checksum: '', row_count: 0, age_seconds: 0 }]
        }
        if (query.includes('system.parts') && query.includes('sum(rows)')) return [{ rows: String(partitionRows) }]
        if (query.includes('system.parts')) return []
        // The post-insert verification round-trip.
        return [{ c: String(rowsInserted), u: String(rowsInserted) }]
      },
    }),
    insert: async ({ table, values }: { table: string; values: unknown[] }) => {
      inserts.push(table)
      if (table.endsWith('account_lock_snapshots')) rowsInserted += values.length
    },
    command: async ({ query }: { query: string }) => { commands.push(query) },
  }
  let rowsInserted = 0
  return { client: client as unknown as ClickHouseClient, inserts, commands }
}

const breakdownRows = (count: number, amount = 1n): BreakdownRow[] =>
  Array.from({ length: count }, (_, i) => ({
    accountId: `0x${String(i).padStart(64, '0')}`, assetId: 0, kind: 'lock' as const,
    source: 'vesting', amount, claimable: 0n, detail: '',
  }))

// The checksum the service would have stored for a given row set.
async function checksumOf(rows: BreakdownRow[]): Promise<string> {
  const { createHash } = await import('node:crypto')
  const hash = createHash('sha256')
  for (const r of [...rows].sort((a, b) => a.accountId.localeCompare(b.accountId))) hash.update(lockRowChecksumFields(r))
  return hash.digest('hex')
}

describe('persistLockSnapshot republication', () => {
  it('writes nothing when the generation is the one already published', async () => {
    const rows = breakdownRows(1_200)
    const { client, inserts, commands } = fakeClient(
      { snapshotId: '99', checksum: await checksumOf(rows), rowCount: rows.length, ageSeconds: 120 }, rows.length,
    )
    expect(await persistLockSnapshot(client, rows, { blockHeight: 1, relayHeight: 1 })).toBe('unchanged')
    expect(inserts).toEqual([])
    expect(commands).toEqual([])
  })

  it('republishes a changed generation', async () => {
    const rows = breakdownRows(1_200)
    const { client, inserts } = fakeClient(
      { snapshotId: '99', checksum: await checksumOf(breakdownRows(1_200, 2n)), rowCount: rows.length, ageSeconds: 120 }, rows.length,
    )
    expect(await persistLockSnapshot(client, rows, { blockHeight: 1, relayHeight: 1 })).toBe('republished')
    expect(inserts).toEqual([
      'price_data.account_lock_snapshots',
      'price_data.account_lock_snapshot_state',
    ])
  })

  it('republishes an identical generation once the floor is reached', async () => {
    const rows = breakdownRows(1_200)
    const { client, inserts } = fakeClient(
      { snapshotId: '99', checksum: await checksumOf(rows), rowCount: rows.length, ageSeconds: REPUBLISH_FLOOR_MS / 1000 }, rows.length,
    )
    expect(await persistLockSnapshot(client, rows, { blockHeight: 1, relayHeight: 1 })).toBe('republished')
    expect(inserts).toContain('price_data.account_lock_snapshots')
  })

  it('republishes an identical generation whose partition is gone', async () => {
    const rows = breakdownRows(1_200)
    const { client, inserts } = fakeClient(
      { snapshotId: '99', checksum: await checksumOf(rows), rowCount: rows.length, ageSeconds: 120 }, 0,
    )
    expect(await persistLockSnapshot(client, rows, { blockHeight: 1, relayHeight: 1 })).toBe('republished')
    expect(inserts).toContain('price_data.account_lock_snapshots')
  })
})

// Skipping a republish is only safe while the checksum sees everything a reader
// can. These guards pin that against the actual INSERT and the actual schema,
// so a column added to either without being checksummed fails here rather than
// silently freezing that column's values in production.

const serviceSource = (file: string) => readFileSync(new URL(`../src/services/${file}`, import.meta.url), 'utf8')
const schemaSource = readFileSync(new URL('../../clickhouse/schema/001_tables.sql', import.meta.url), 'utf8')

// Column names of a declared table, in declaration order.
function declaredColumns(table: string): string[] {
  const line = schemaSource.split('\n').find(l => l.includes(`CREATE TABLE IF NOT EXISTS price_data.${table} (`))
  if (!line) throw new Error(`no declaration for ${table}`)
  return [...line.matchAll(/`([a-z_0-9]+)`/g)].map(m => m[1])
}

// column → the expression the service inserts into it.
function insertedColumns(source: string, table: string): Map<string, string> {
  const at = source.indexOf(`table: 'price_data.${table}',`)
  if (at < 0) throw new Error(`no insert into ${table}`)
  const body = source.slice(at, source.indexOf("format: 'JSONEachRow'", at))
  const open = body.indexOf('({')
  const literal = body.slice(open + 2, body.lastIndexOf('})'))
  const out = new Map<string, string>()
  for (const part of literal.split(',')) {
    const colon = part.indexOf(':')
    if (colon < 0) continue
    const key = part.slice(0, colon).trim()
    if (!/^[a-z_0-9]+$/.test(key)) continue
    out.set(key, part.slice(colon + 1).trim())
  }
  return out
}

// The row expression as the checksum would have to reference it: no
// presentation wrapper, no boolean encoding.
const bare = (expression: string) => expression.replace(/\.toString\(\)$/, '').replace(/ \? 1 : 0$/, '').trim()

interface CoverageCase {
  table: string
  file: string
  checksum: (...args: never[]) => string
  // Columns that are the generation's own identity, not observable content.
  identity: string[]
  // Columns that are pure functions of a covered column, with the reason.
  derived: Record<string, string>
}

const coverage: CoverageCase[] = [
  {
    table: 'account_lock_snapshots', file: 'lockBreakdownService.ts', checksum: lockRowChecksumFields,
    identity: ['snapshot_id', 'computed_at'], derived: {},
  },
  {
    table: 'omnipool_account_claim_snapshots', file: 'explorerService.ts', checksum: omnipoolClaimChecksumFields,
    identity: ['snapshot_id', 'computed_at'], derived: {},
  },
  {
    table: 'money_market_account_value_snapshots', file: 'explorerService.ts', checksum: moneyMarketClaimChecksumFields,
    identity: ['snapshot_id', 'computed_at'],
    derived: {
      holder: 'the H160 whose account id account_id is',
      market_key: 'the configured market of pool_address',
    },
  },
]

describe('snapshot checksums cover every stored column', () => {
  it('pins the three checksummed snapshot tables', () => {
    expect(coverage.map(c => c.table)).toEqual([
      'account_lock_snapshots',
      'omnipool_account_claim_snapshots',
      'money_market_account_value_snapshots',
    ])
  })

  // Column counts are pinned so a table that grows a column cannot quietly
  // shrink these assertions to nothing.
  const expectedCovered: Record<string, number> = {
    account_lock_snapshots: 7,
    omnipool_account_claim_snapshots: 6,
    money_market_account_value_snapshots: 14,
  }

  for (const c of coverage) {
    it(`${c.table}: every inserted column is declared and checksummed`, () => {
      const declared = declaredColumns(c.table)
      const inserted = insertedColumns(serviceSource(c.file), c.table)
      expect([...inserted.keys()].sort()).toEqual([...declared].sort())

      const source = c.checksum.toString().replace(/ \? 1 : 0\}/g, '}')
      const covered = [...inserted.entries()]
        .filter(([column]) => !c.identity.includes(column) && !(column in c.derived))
        .map(([column, expression]) => {
          expect(source, `${c.table}.${column}`).toContain(`\${${bare(expression)}}`)
          return column
        })
      expect(covered).toHaveLength(expectedCovered[c.table])
      expect(covered.length + c.identity.length + Object.keys(c.derived).length).toBe(declared.length)
    })
  }
})

describe('grid-snapped unlock projections', () => {
  it('projects a fixed block to the same instant while the chain head advances', () => {
    // Real block time runs above the nominal 6s the projection assumes, so the
    // basis drifts steadily; the grid absorbs it instead of rewriting the date.
    const target = 2_000_000
    const projections = new Set<number>()
    for (let cycle = 0; cycle < 60; cycle++) {
      const block = 1_000_000 + cycle * 9
      const headTsMs = 1_700_000_000_000 + cycle * 60_000
      projections.add(blockProjector(headTsMs, block)(target))
    }
    // One hour of drift at ~6.66s per block moves the basis ~6.6 minutes, so a
    // 15-minute grid is crossed at most once across the window.
    expect(projections.size).toBeLessThanOrEqual(2)
    expect(projections.size).toBeGreaterThan(0)
  })

  it('keeps the projected instant within half a grid step of the raw estimate', () => {
    const headTsMs = 1_700_000_123_456
    const project = blockProjector(headTsMs, 1_000_000)
    expect(Math.abs(project(1_000_100) - (headTsMs + 100 * 6000))).toBeLessThanOrEqual(PROJECTION_GRID_MS / 2)
    // The snapped quantity is the basis every date rides on — block 0's instant.
    expect(snapProjection(project(0))).toBe(project(0))
  })
})

describe('pinned account-value price generation', () => {
  const map = (entries: [number, { price: number; change24h: number; priceRaw?: string }][]) => new Map(entries)

  it('treats a moved price or 24h change as a new generation', () => {
    const base = map([[0, { price: 1, change24h: 0.5, priceRaw: '1' }]])
    expect(samePriceGeneration(base, map([[0, { price: 1, change24h: 0.5, priceRaw: '1' }]]))).toBe(true)
    expect(samePriceGeneration(base, map([[0, { price: 2, change24h: 0.5, priceRaw: '2' }]]))).toBe(false)
    expect(samePriceGeneration(base, map([[0, { price: 1, change24h: 0.6, priceRaw: '1' }]]))).toBe(false)
    expect(samePriceGeneration(base, map([]))).toBe(false)
    expect(samePriceGeneration(base, map([[1, { price: 1, change24h: 0.5, priceRaw: '1' }]]))).toBe(false)
  })
})
