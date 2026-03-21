import { describe, it, expect } from 'vitest'

// Inline the pure functions for testing (same logic as ui/src/utils/iconUrls.ts)
const ICON_CDN = 'https://cdn.jsdelivr.net/gh/galacticcouncil/intergalactic-asset-metadata@master/v2'

function assetIconUrl(assetId: number): string {
  return `${ICON_CDN}/polkadot/2034/assets/${assetId}/icon.svg`
}

function chainIconUrl(parachainId: number): string {
  return `${ICON_CDN}/polkadot/${parachainId}/icon.svg`
}

describe('assetIconUrl', () => {
  it('constructs correct CDN URL for asset icon', () => {
    expect(assetIconUrl(0)).toBe(
      'https://cdn.jsdelivr.net/gh/galacticcouncil/intergalactic-asset-metadata@master/v2/polkadot/2034/assets/0/icon.svg'
    )
  })

  it('handles large asset IDs', () => {
    expect(assetIconUrl(1000099)).toContain('/assets/1000099/icon.svg')
  })
})

describe('chainIconUrl', () => {
  it('constructs correct CDN URL for chain icon', () => {
    expect(chainIconUrl(1000)).toBe(
      'https://cdn.jsdelivr.net/gh/galacticcouncil/intergalactic-asset-metadata@master/v2/polkadot/1000/icon.svg'
    )
  })

  it('works for Polkadot relay chain (parachainId 0 edge case)', () => {
    expect(chainIconUrl(0)).toContain('/polkadot/0/icon.svg')
  })
})
