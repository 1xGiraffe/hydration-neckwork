import { describe, expect, it } from 'vitest'
import { pairDisplay, parseUrlPair } from '../src/utils/pairs'
import type { Asset } from '../src/types'

describe('parseUrlPair', () => {
  it('parses canonical asset pair slugs', () => {
    expect(parseUrlPair('0-10')).toEqual({ baseId: 0, quoteId: 10 })
    expect(parseUrlPair('1000625-222')).toEqual({ baseId: 1_000_625, quoteId: 222 })
  })

  it.each(['1x-10', '1-10x', '-1-10', '01-10', '1-1', '1-2-3', ''])('rejects malformed slug %j', slug => {
    expect(parseUrlPair(slug)).toBeNull()
  })

  it('rejects integers outside JavaScript’s safe range', () => {
    expect(parseUrlPair('9007199254740992-10')).toBeNull()
  })
})

// A stablecoin is not necessarily a dollar: EURC tracks the euro, so a EURC-quoted
// pair is a real cross pair and must be labelled EURC rather than folded into the
// implied "<base> = <base>/USD" naming.
describe('non-USD stablecoin quotes', () => {
  const asset = (assetId: number, symbol: string, flags: { isStablecoin?: boolean; isUsdPegged?: boolean } = {}): Asset => ({
    assetId,
    symbol,
    name: symbol,
    decimals: 6,
    isStablecoin: flags.isStablecoin ?? false,
    isUsdPegged: flags.isUsdPegged ?? false,
    parachainId: null,
  })

  it('names a EURC quote instead of implying USD', () => {
    const hdx = asset(0, 'HDX')
    const eurc = asset(44, 'EURC', { isStablecoin: true })
    const usdc = asset(22, 'USDC', { isStablecoin: true, isUsdPegged: true })

    expect(pairDisplay(hdx, eurc)).toBe('HDXEURC')
    expect(pairDisplay(hdx, usdc)).toBe('HDX')
  })
})
