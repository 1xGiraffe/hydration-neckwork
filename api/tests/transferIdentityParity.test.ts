import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  EVM_TRANSFER_EVENT_NAME,
  transferEventPriority,
  transferPrioritySql,
  transferLegAccountSql,
} from '../src/services/explorerService.ts'

const source = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// Transfer identity is decided in FIVE places: dedupeTransferEvents in TypeScript,
// and four SQL windows — the global feed's LIMIT 1 BY, the NTT-out feed's, the
// account candidate window's PARTITION BY, and getDailyActivity's uniqExact tuple.
// They must agree. If SQL groups on the full account id while TypeScript groups on
// the 20-byte truncation, an EVM leg and its substrate twin are one identity to one
// and two to the other, so a page's row count stops matching its own total.
describe('transfer identity is expressed once for SQL and TypeScript', () => {
  it('derives the SQL priority expression from the same table as the TS function', () => {
    const sql = transferPrioritySql('event_name')
    for (const name of ['Currencies.Transferred', 'Tokens.Transfer', EVM_TRANSFER_EVENT_NAME]) {
      expect(sql).toContain(`'${name}', ${transferEventPriority(name)}`)
    }
  })

  it('leaves no hand-written priority expression behind', () => {
    expect(source).not.toMatch(/multiIf\(event_name = 'Currencies\.Transferred', 3/)
  })

  it('compares accounts truncated in every SQL identity window', () => {
    // A transfer identity window is one that groups on (asset, accounts, amount) —
    // which distinguishes the four from the unrelated LIMIT 1 BY windows that
    // deduplicate calls or events. The four name their columns differently
    // (from_acc vs from_account), so assert on the truncation, not one spelling.
    const windows = source.split('\n').filter(l =>
      (l.includes('LIMIT 1 BY block_height') || l.includes('PARTITION BY block_height') || l.includes('uniqExact(tuple(block_height'))
      && l.includes('asset_id') && l.includes('amount'))
    expect(windows).toHaveLength(4)
    for (const w of windows) {
      expect(w, w.trim().slice(0, 80)).toContain('transferLegAccountSql')
      expect(w, w.trim().slice(0, 80)).not.toMatch(/lower\((from_acc|from_account)\)/)
    }
  })

  it('truncates an ETH-prefixed account to its H160 in SQL', () => {
    const sql = transferLegAccountSql('acc')
    expect(sql).toContain("'0x45544800'")
    expect(sql).toContain('11, 40')  // ETH-prefixed: skip the marker, take the H160
    expect(sql).toContain('3, 40')   // otherwise: the first 20 bytes
  })
})
