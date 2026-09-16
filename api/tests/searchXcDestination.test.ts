import { describe, expect, it } from 'vitest'
import { XC_DESTINATIONS, xcDestinationBySlug, xcDestinationListItems } from '../src/services/explorerService.ts'

// A cross-chain destination is not a registry asset, but it carries the same
// `origin` every foreign asset does — ecosystem, chain and the key its artwork is
// filed under in the shared metadata CDN. That is the whole mechanism by which a
// NEAR or Zcash hit gets an icon without a code change per chain, so the search
// result has to hand it over; without it the dropdown rendered these with no icon
// at all while the /assets directory showed one for the same destination.

describe('cross-chain destinations carry what an icon needs', () => {
  it('gives every destination a complete CDN origin', () => {
    expect(XC_DESTINATIONS.length).toBeGreaterThan(0)
    for (const d of XC_DESTINATIONS) {
      expect(d.origin, d.platform).toBeTruthy()
      expect(d.origin!.ecosystem, d.platform).toBeTruthy()
      expect(d.origin!.chainId, d.platform).toBeTruthy()
      // The key the icon is filed under. Null would resolve to no URL at all.
      expect(d.origin!.assetId, d.platform).toBeTruthy()
    }
  })

  // The metadata key is NOT always the trading symbol — NEAR's icon is filed under
  // NEAR and a request for wNEAR 404s — so the two must be allowed to differ, and
  // the origin is what the icon is built from.
  it('lets the metadata key differ from the traded symbol', () => {
    const near = XC_DESTINATIONS.find(d => d.platform === 'near')
    expect(near?.symbol).toBe('wNEAR')
    expect(near?.origin?.assetId).toBe('NEAR')
  })

  it('addresses destinations by negative id, so they cannot collide with a registry asset', () => {
    const items = xcDestinationListItems(new Map())
    expect(items.length).toBe(XC_DESTINATIONS.length)
    for (const item of items) {
      expect(item.assetId).toBeLessThan(0)
      expect(item.iconAssetId).toBe(item.assetId)
      expect(item.origin).toBeTruthy()
    }
    // Ids are distinct, or two destinations would share one icon slot.
    expect(new Set(items.map(i => i.assetId)).size).toBe(items.length)
  })

  // The id above is what a link built from one of these rows carries, so it has to
  // resolve back to the same destination. It did not: `/activity?token=-2` matched no
  // registry asset and no slug, and the feed answered empty by construction — the filter
  // the UI generates itself was the one that found nothing.
  it('resolves every id it hands out back to its own destination', () => {
    for (const item of xcDestinationListItems(new Map())) {
      expect(xcDestinationBySlug(String(item.assetId)), String(item.assetId)).toBe(
        XC_DESTINATIONS.find(d => d.symbol === item.symbol))
    }
  })

  // A negative id outside the table must stay unresolved rather than wrap around the
  // array or pick up a neighbour.
  it('refuses an id no destination has', () => {
    expect(xcDestinationBySlug(String(-(XC_DESTINATIONS.length + 1)))).toBeUndefined()
    expect(xcDestinationBySlug('-0')).toBeUndefined()
    expect(xcDestinationBySlug('-')).toBeUndefined()
  })
})
