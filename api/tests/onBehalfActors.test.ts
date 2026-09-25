import { describe, expect, it } from 'vitest'
import { onBehalfActor, onBehalfCandidates } from '../src/services/onBehalfActors.ts'

// The two on-behalf read models fold into one candidate set per extrinsic, and the
// same fold serves the extrinsic page (actorsFor) and the account-first swap
// projection (accountSwapQueue) — so both name the same actor for a proxied swap.
describe('on-behalf candidates', () => {
  it('groups every proxy dispatch of an extrinsic with the multisig it executed as', () => {
    const candidates = onBehalfCandidates(
      [
        { block_height: 42, extrinsic_index: 3, call_address: 'root', real_account: '0xouter' },
        { block_height: 42, extrinsic_index: 3, call_address: '0.0', real_account: '0xinner' },
        { block_height: 42, extrinsic_index: 4, call_address: 'root', real_account: '0xother' },
      ],
      [{ block_height: 42, extrinsic_index: 3, multisig: '0xms' }],
    )

    expect([...candidates.keys()].sort()).toEqual(['42:3', '42:4'])
    expect(candidates.get('42:3')).toEqual({
      proxies: [{ callAddress: 'root', account: '0xouter' }, { callAddress: '0.0', account: '0xinner' }],
      multisig: '0xms',
    })
    expect(candidates.get('42:4')).toEqual({ proxies: [{ callAddress: 'root', account: '0xother' }] })
    // Multisig.as_multi → Proxy.proxy(real=X): X's origin ran the calls, so X is the actor.
    expect(onBehalfActor(candidates.get('42:3')!)).toBe('0xinner')
    expect(onBehalfActor(candidates.get('42:4')!)).toBe('0xother')
  })

  it('keeps the first multisig an extrinsic executed as', () => {
    const candidates = onBehalfCandidates([], [
      { block_height: 7, extrinsic_index: 1, multisig: '0xfirst' },
      { block_height: 7, extrinsic_index: 1, multisig: '0xsecond' },
    ])
    expect(onBehalfActor(candidates.get('7:1')!)).toBe('0xfirst')
  })

  it('folds nothing for an ordinary signed extrinsic', () => {
    expect(onBehalfCandidates([], []).size).toBe(0)
  })
})
