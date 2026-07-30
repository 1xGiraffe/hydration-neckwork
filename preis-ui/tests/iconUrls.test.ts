import { describe, expect, it } from 'vitest'
import { assetIconCandidates, originChainIconUrl } from '../src/utils/iconUrls'

describe('origin-aware asset icons', () => {
  const ethereumUsdc = {
    ecosystem: 'ethereum',
    chainId: '1',
    assetId: '0xA0b86991c6218B36c1d19D4a2e9Eb0cE3606eB48',
  }

  it('prefers the canonical Ethereum contract icon', () => {
    expect(assetIconCandidates(1000766, ethereumUsdc)[0]).toContain(
      '/ethereum/1/assets/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/icon.svg',
    )
  })

  it('uses the origin chain icon for the badge', () => {
    expect(originChainIconUrl(ethereumUsdc)).toContain('/ethereum/1/icon.svg')
  })
})
