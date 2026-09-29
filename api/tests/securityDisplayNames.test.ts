import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The security dashboard and the reserve-cap states are explorer surfaces, so a
// Hydrated pool share reads as the wrapper it IS (GDOT, HEURC, HUSDS…) there too:
// its deposit fuse, its liquidation collateral, its timeline rows and a cap
// notification named 2-Pool-GDOT for the reserve the Borrow tab calls GDOT.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('security and cap surfaces use the explorer display name', () => {
  it('builds every security-dashboard asset and timeline sentence from displayDescriptor', () => {
    const security = source('../src/services/securityService.ts')
    expect(security).toContain('const asset = (id: number): AssetRef => displayDescriptor(id)')
    expect(security).not.toMatch(/\bassetDescriptor\(/)
  })

  it('names a reserve-cap state for display', () => {
    const caps = source('../src/services/moneyMarketCaps.ts')
    expect(caps).toContain('knownExplorerAsset(assetId) ? displayDescriptor(assetId) : null')
    expect(caps).not.toMatch(/\bassetDescriptor\(/)
  })
})
