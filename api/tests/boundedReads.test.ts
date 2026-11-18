import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const hdxService = readFileSync(new URL('../src/services/hdxService.ts', import.meta.url), 'utf8')
const body = (src: string, signature: string): string => {
  const at = src.indexOf(signature)
  expect(at, signature).toBeGreaterThan(-1)
  return src.slice(at, src.indexOf('\n}\n', at))
}

// A join builds its RIGHT side whole. price_data.blocks has one row per block (16.8M,
// past 2^24), so joining it unfiltered behind a lookup that is not on block_height made
// the whole table the hash table: 1–2 GiB for one extrinsic.
describe('spec_version joins read only the blocks they need', () => {
  for (const fn of ['export async function getExtrinsic(', 'async function hydrateOnBehalfExtrinsics(']) {
    it(fn, () => {
      const src = body(explorerService, fn)
      expect(src).not.toMatch(/JOIN price_data\.blocks b ON/)
      expect(src).toMatch(/LEFT JOIN \(SELECT block_height, spec_version FROM price_data\.blocks\s+WHERE block_height IN \(/)
    })
  }
})

// The events total is a distinct (block, event) count. With one answering account it is
// that account's distinct sort keys, which a FINAL count reads at a fifth of the bitmap's
// cost; any set where two accounts answer, and any event-name filter, keeps the bitmap.
describe('the events total', () => {
  const src = body(explorerService, 'async function countAccountEvents(')
  it('takes the FINAL count only when at most one account answers and no event filter applies', () => {
    expect(src).toContain('if (!eventFilter && new Set(accounts).size <= EVENT_TOTAL_FINAL_MAX_ACCOUNTS)')
    expect(src).toContain('SELECT uniqExact(account) AS n, count() AS c')
    expect(src).toContain('FROM price_data.account_activity_v3 FINAL')
    expect(src).toContain('do_not_merge_across_partitions_select_final: 1')
    expect(src).toContain("if (Number(row?.n ?? 0) <= 1) return Number(row?.c ?? 0)")
  })
  it('falls through to the bitmap otherwise', () => {
    expect(src.indexOf('groupBitmap(')).toBeGreaterThan(src.indexOf('if (Number(row?.n ?? 0) <= 1)'))
  })
})

// Over-budget is a yes/no question: each side stops one row past the budget.
describe('the transfer candidate budget', () => {
  it('reads each side at most one row past the budget', () => {
    const src = body(explorerService, 'async function transferCandidatesExceedExactBudget(')
    expect(src.match(/LIMIT \{cap:UInt32\}/g)).toHaveLength(2)
    expect(src).toContain('cap: MAX_EXACT_TRANSFER_CANDIDATES + 1')
    expect(src).toContain('> MAX_EXACT_TRANSFER_CANDIDATES')
  })
})

// has() over a constant array scans it per row; on the weekly HDX closes that was more
// than half of each read.
describe('HDX tag membership over many rows', () => {
  for (const fn of ['async function loadRotationAnchors(', 'export function hdxRealizedWeeklySql(']) {
    it(fn, () => {
      const src = body(hdxService, fn)
      expect(src).not.toMatch(/has\((special_accts|kraken_accts|pool_accts),/)
      expect(src).toContain('tagAccountSetSql(')
    })
  }
})

describe('the activity leaderboard at boot', () => {
  it('waits out the cold start before its first pass', () => {
    const src = body(explorerService, 'export function startActivityLeaderboardRefresh(')
    expect(src).toContain('}, ACTIVITY_LEADERBOARD_FIRST_DELAY_MS)')
    expect(src).not.toMatch(/\n {2}void cycle\(\)/)
  })
})
