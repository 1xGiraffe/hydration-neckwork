import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

const explorerService = read('../src/services/explorerService.ts')
const erc20WalletService = read('../src/services/erc20WalletService.ts')
const tables = read('../../clickhouse/schema/001_tables.sql')
const materializedViews = read('../../clickhouse/schema/003_materialized_views.sql')

const directoryDdl = tables
  .split('\n')
  .find(line => line.startsWith('CREATE TABLE IF NOT EXISTS price_data.account_alias_directory ')) ?? ''
const directoryMv = materializedViews
  .split('\n')
  .find(line => line.startsWith('CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.account_alias_directory_mv ')) ?? ''

// raw_account_aliases records an alias again on every block it is observed, so
// 19,867 distinct identities sit behind 16.2M rows — and its ORDER BY starts with
// block_height, so no alias predicate (evm_address, account_id, primary_profile,
// relationship) can use the primary index. A reader keyed on one of those scans the
// whole table: the wallet refresh read 16,205,119 rows / 1.90 GiB / 283 ms / 94 MiB
// peak for 1,736 rows of output, and the four shapes together read ~387 GiB per 6h.
//
// A block_height predicate is the one thing the primary index DOES answer, so a
// read bounded on it is allowed — that is how the binding poll stays a 4 ms / 1.9
// MiB point read. The rule is the bound, not the table.
describe('account alias reads', () => {
  it('bounds every raw_account_aliases read on the sort key', () => {
    for (const [name, source] of [['explorerService', explorerService], ['erc20WalletService', erc20WalletService]] as const) {
      let examined = 0
      for (const query of source.split('query:').slice(1)) {
        if (!/FROM\s+price_data\.raw_account_aliases/.test(query)) continue
        // The statement ends at the template literal's closing backtick.
        const statement = query.slice(0, query.indexOf('`', query.indexOf('`') + 1) + 1)
        examined += 1
        expect(statement, `${name}: unbounded raw_account_aliases read`).toMatch(/block_height/)
      }
      // A read the splitter failed to see is a read this test did not check, so
      // the count has to agree with the plain occurrences in the file.
      expect(examined, `${name}: reads seen`).toBe((source.match(/FROM\s+price_data\.raw_account_aliases/g) ?? []).length)
    }
  })

  it('reads the alias directory instead', () => {
    expect((explorerService.match(/FROM\s+price_data\.account_alias_directory/g) ?? []).length).toBe(5)
    expect((erc20WalletService.match(/FROM price_data\.account_alias_directory/g) ?? []).length).toBe(1)
  })

  it('does not re-lower the directory, which is stored canonically lowercase', () => {
    const reads = explorerService.match(/[^\n]*price_data\.account_alias_directory[^\n]*/g) ?? []

    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) expect(read, read).not.toMatch(/lower\(\s*(?:evm_address|account_id)\s*\)/)
  })
})

describe('account_alias_directory schema', () => {
  it('is declared alongside its materialized view', () => {
    expect(directoryDdl).not.toBe('')
    expect(directoryMv).not.toBe('')
  })

  // Raw ranges get re-indexed, so the MV re-emits rows it has already emitted.
  // min/max are idempotent under that replay; sum/count would drift every time.
  it('aggregates only with replay-idempotent functions', () => {
    expect(directoryDdl).toContain('`first_block` SimpleAggregateFunction(min, UInt32)')
    expect(directoryDdl).toContain('`last_block` SimpleAggregateFunction(max, UInt32)')
    expect(directoryDdl).toContain('ENGINE = AggregatingMergeTree')
    expect(directoryDdl).not.toMatch(/SimpleAggregateFunction\((?:sum|count|any)/)
    expect(directoryMv).toContain('min(block_height) AS first_block')
    expect(directoryMv).toContain('max(block_height) AS last_block')
    expect(directoryMv).not.toMatch(/\b(?:sum|count)\(/)
  })

  // resolveRelatedAccounts returns `confidence` in its DISTINCT projection, and
  // 2,401 identities were observed with both 0.8 and 0.95. Collapsing them would
  // silently drop an alias row the account API exposes today, so confidence is
  // part of the grouping key rather than an aggregate.
  it('keeps confidence in the identity key so reader DISTINCT sets are unchanged', () => {
    const identity = ['evm_address', 'account_id', 'alias_type', 'alias_value', 'primary_profile', 'relationship', 'confidence']

    expect(directoryDdl).toContain(`ORDER BY (${identity.join(', ')})`)
    expect(directoryMv).toContain(`GROUP BY ${identity.join(', ')}`)
  })

  it('stores the directory keys as non-nullable canonical lowercase', () => {
    expect(directoryDdl).toContain('`evm_address` String')
    expect(directoryDdl).toContain('`account_id` String')
    expect(directoryMv).toContain("lower(ifNull(evm_address, '')) AS evm_address")
    expect(directoryMv).toContain("lower(ifNull(account_id, '')) AS account_id")
  })
})
