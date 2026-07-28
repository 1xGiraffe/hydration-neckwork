import { describe, it, expect, beforeEach, vi } from 'vitest'
import { listSubstrateWallets, discoverEvmProviders, toHexMessage, accountRowLabel } from '../src/wallets'

// jsdom/happy-dom aren't project dependencies, so there is no ambient `window`
// under the default Node test environment. Node's own EventTarget already
// implements add/removeEventListener + dispatchEvent, so a bare instance with
// a couple of extra properties stands in for it — mirrors the memoryStorage
// stub in tests/session.test.ts. A fresh one per test keeps the EIP-6963
// listener wallets.ts attaches from leaking across tests.
type StubWindow = EventTarget & { injectedWeb3?: unknown; ethereum?: unknown }
function stubWindow(): StubWindow {
  const win = new EventTarget() as StubWindow
  vi.stubGlobal('window', win)
  return win
}

describe('wallet registry', () => {
  beforeEach(() => { stubWindow() })

  it('marks known substrate wallets installed when injected', () => {
    ;(window as { injectedWeb3?: unknown }).injectedWeb3 = { 'polkadot-js': { enable: async () => ({}) }, talisman: { enable: async () => ({}) } }
    const wallets = listSubstrateWallets()
    const byId = new Map(wallets.map(w => [w.id, w]))
    expect(byId.get('polkadot-js')?.installed).toBe(true)
    // Nova is its own tile (distinct name/icon/install link) but connects
    // through the SAME injected key as Polkadot{.js} — both read "installed"
    // off one extension, never two independent checks that could disagree.
    expect(byId.get('nova')?.installed).toBe(true)
    expect(byId.get('nova')?.injectedKey).toBe('polkadot-js')
    expect(byId.get('talisman')?.installed).toBe(true)
    expect(byId.get('subwallet-js')?.installed).toBe(false)
    expect(byId.get('subwallet-js')?.installUrl).toContain('http')
  })

  it('sorts installed wallets ahead of uninstalled ones, declaration order as the tiebreak', () => {
    ;(window as { injectedWeb3?: unknown }).injectedWeb3 = { 'subwallet-js': { enable: async () => ({}) } }
    const ids = listSubstrateWallets().map(w => w.id)
    expect(ids).toEqual(['subwallet-js', 'polkadot-js', 'nova', 'talisman', 'aleph-zero', 'enkrypt', 'fearless-wallet', 'polkagate'])
  })

  it('collects EIP-6963 announced providers', () => {
    const providers = discoverEvmProviders()
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { info: { rdns: 'io.metamask', name: 'MetaMask', icon: 'data:image/svg+xml,' }, provider: { request: async () => [] } },
    }))
    expect(providers.list()).toHaveLength(1)
    expect(providers.list()[0].info.name).toBe('MetaMask')
    providers.stop()
  })

  it('hex-encodes a message for signRaw/personal_sign', () => {
    expect(toHexMessage('ab')).toBe('0x6162')
  })

  it('labels a picker row like an account pill: profile → identity → wallet name → address', () => {
    const ref = {
      accountId: '0x' + 'ab'.repeat(32), address: '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ',
      emoji: '🦊', tag: null, identity: null, profile: null,
    }
    // Canonical display address always comes from the ref, never the raw input.
    // `kind` says which source won, so the caller can style the name the way
    // an AddrPill would (profile → amber italic, identity → plain).
    expect(accountRowLabel({ ...ref, profile: { name: 'Maf', avatarVersion: 0 } }, 'Wallet 1'))
      .toEqual({ primary: 'Maf', kind: 'profile', address: ref.address })
    expect(accountRowLabel({ ...ref, identity: { display: 'Chain Name', verified: true, email: '', web: '', twitter: '' } }, 'Wallet 1'))
      .toEqual({ primary: 'Chain Name', kind: 'identity', address: ref.address })
    expect(accountRowLabel(ref, 'Wallet 1')).toEqual({ primary: 'Wallet 1', kind: 'name', address: ref.address })
    // No name anywhere: the address IS the primary label, not shown twice.
    expect(accountRowLabel(ref, undefined)).toEqual({ primary: null, kind: null, address: ref.address })
    // Refs unavailable (endpoint down): degrade to the wallet name + raw input.
    expect(accountRowLabel(null, 'Wallet 1', '5FHneW46...')).toEqual({ primary: 'Wallet 1', kind: 'name', address: '5FHneW46...' })
    expect(accountRowLabel(undefined, undefined, '5FHneW46...')).toEqual({ primary: null, kind: null, address: null })
  })
})
