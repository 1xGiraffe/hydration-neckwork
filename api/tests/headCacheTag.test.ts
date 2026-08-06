import { describe, expect, it } from 'vitest'
import { headCacheTag } from '../src/services/explorerService.ts'

// Live feed cache keys carry the ingested head so a page is reused only until
// the next block lands; time-windowed pages don't shift with the head and get
// a stable tag instead. The tag shape is the durable invariant every feed key
// builds on — two feeds disagreeing on it would silently stop sharing the
// per-block invalidation semantics.
describe('headCacheTag', () => {
  it('tags live pages with the ingested head', () => {
    expect(headCacheTag(13486711)).toBe('h13486711')
  })

  it('tags time-windowed pages with a head-independent constant', () => {
    expect(headCacheTag(null)).toBe('tw')
  })
})
