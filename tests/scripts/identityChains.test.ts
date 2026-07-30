import { describe, expect, it } from 'vitest'
import { HYDRATION_CHAIN_KEY, parseIdentityChains } from '../../src/scripts/identityChains.ts'

const HYDRATION_RPC = 'https://hydration-rpc.neckwork.net'

describe('identity chain configuration', () => {
  it('always leads with Hydration at the highest priority', () => {
    const chains = parseIdentityChains('', HYDRATION_RPC)

    expect(chains).toEqual([{ key: HYDRATION_CHAIN_KEY, url: HYDRATION_RPC, block: null, priority: 0 }])
  })

  it('keeps configured order as display priority', () => {
    const chains = parseIdentityChains(
      'polkadot-people=https://a.example,kusama-people=https://b.example,paseo-people=https://c.example',
      HYDRATION_RPC,
    )

    expect(chains.map(chain => [chain.key, chain.priority])).toEqual([
      [HYDRATION_CHAIN_KEY, 0],
      ['polkadot-people', 1],
      ['kusama-people', 2],
      ['paseo-people', 3],
    ])
  })

  it('pins a historical anchor from a trailing @block', () => {
    const [, relay] = parseIdentityChains('polkadot-relay=https://rpc.example@21000000', HYDRATION_RPC)

    expect(relay).toMatchObject({ key: 'polkadot-relay', url: 'https://rpc.example', block: 21_000_000 })
  })

  it('keeps an @ that belongs to the URL', () => {
    const [, chain] = parseIdentityChains('private=https://user:pass@rpc.example/path', HYDRATION_RPC)

    expect(chain).toMatchObject({ url: 'https://user:pass@rpc.example/path', block: null })
  })

  it('skips malformed, duplicate and non-HTTP entries without losing the good ones', () => {
    const chains = parseIdentityChains(
      [
        'no-url=',                                  // missing endpoint
        'missing-separator',                        // not key=url
        'Bad Key=https://a.example',                // not a slug
        'wss=wss://b.example',                      // not HTTP(S)
        `${HYDRATION_CHAIN_KEY}=https://c.example`, // cannot displace Hydration
        'kusama-people=https://d.example',
        'kusama-people=https://e.example',          // duplicate key
        '  polkadot-people = https://f.example  ',  // padded but valid
      ].join(','),
      HYDRATION_RPC,
    )

    expect(chains.map(chain => chain.key)).toEqual([HYDRATION_CHAIN_KEY, 'kusama-people', 'polkadot-people'])
    expect(chains[0].url).toBe(HYDRATION_RPC)
    expect(chains[1].url).toBe('https://d.example')
    expect(chains[2].url).toBe('https://f.example')
  })

  it('treats an unset value as no extra chains', () => {
    expect(parseIdentityChains(undefined, HYDRATION_RPC).map(chain => chain.key)).toEqual([HYDRATION_CHAIN_KEY])
  })
})
