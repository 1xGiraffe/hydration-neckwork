import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const src = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const body = (name: string) => { const at = src.indexOf(name); return src.slice(at, src.indexOf('\n}\n', at)) }

// A cache key without the cut and the publication generation serves the previous
// publication for its whole TTL after a month is republished or the cut advances.
describe('User Revenue breakdown cache key', () => {
  it('carries the cut, the publication generation and the account set, like the Borrow earned read', () => {
    const breakdown = body('async function scopedUserRevenueBreakdown')
    expect(breakdown).toContain(':${through}:${publicationGeneration(coverage, fromDay)}:${accountSetFingerprint(accounts)}')
    // The coverage is read BEFORE the cache, so the key can carry it.
    expect(breakdown.indexOf('accountFoldCoverage(client)')).toBeLessThan(breakdown.indexOf('cached('))
    expect(body('export async function getAddressMoneyMarketEarned')).toContain('${publicationGeneration(coverage)}:${accountSetFingerprint(accounts)}')
  })
})
