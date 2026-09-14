import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const hooks = readFileSync(new URL('../src/hooks/useExplorerData.ts', import.meta.url), 'utf8')

// A DCA schedule and an ICE intent are progress pages — the reader sits on one to
// watch the percentage climb. Both fetched exactly once: a staleTime only decides
// whether an already-triggered refetch goes to network, and nothing triggered one
// (refetchOnWindowFocus is off globally and neither key is in LIVE_PUSH_KEYS).
function hookBody(name: string): string {
  const start = hooks.indexOf(`export function ${name}(`)
  expect(start, `${name} not found`).toBeGreaterThan(-1)
  const next = hooks.indexOf('\nexport function ', start + 1)
  return hooks.slice(start, next === -1 ? undefined : next)
}

describe('progress detail pages refresh themselves', () => {
  for (const name of ['useDcaSchedule', 'useIntentOrder']) {
    it(`${name} polls while the order is live`, () => {
      const body = hookBody(name)
      expect(body).toContain('refetchInterval')
      // Only the first page: a live refetch of a deeper page would shuffle rows
      // under the reader mid-scroll.
      expect(body).toContain('offset === 0')
      // And it stops once the order can no longer change.
      expect(body).toMatch(/LIVE_STATUSES\.has/)
    })
  }

  // The statuses that keep polling must be ones the wire actually sends, or the
  // page either never refreshes or never stops.
  it('names live statuses that exist on the wire', () => {
    const types = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8')
    expect(types).toContain("'open' | 'partially-filled'")
    expect(types).toMatch(/status: 'active' \| 'completed' \| 'terminated'/)
    expect(hooks).toContain("DCA_LIVE_STATUSES = new Set(['active'])")
    expect(hooks).toContain("INTENT_LIVE_STATUSES = new Set(['open', 'partially-filled'])")
  })

  // The detail pages that already refreshed must not have regressed.
  it('keeps account, asset and tag detail on their own intervals', () => {
    for (const name of ['useAddress', 'useAsset', 'useTag']) {
      expect(hookBody(name), name).toContain('refetchInterval: useInterval(')
    }
  })
})
