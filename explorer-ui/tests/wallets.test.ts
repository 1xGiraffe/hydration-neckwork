import { describe, it, expect, beforeEach, vi } from 'vitest'
import { listSubstrateWallets, discoverEvmProviders, toHexMessage } from '../src/wallets'

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
    expect(byId.get('talisman')?.installed).toBe(true)
    expect(byId.get('subwallet-js')?.installed).toBe(false)
    expect(byId.get('subwallet-js')?.installUrl).toContain('http')
  })

  it('sorts installed wallets ahead of uninstalled ones, declaration order as the tiebreak', () => {
    ;(window as { injectedWeb3?: unknown }).injectedWeb3 = { 'subwallet-js': { enable: async () => ({}) } }
    const ids = listSubstrateWallets().map(w => w.id)
    expect(ids).toEqual(['subwallet-js', 'polkadot-js', 'talisman', 'aleph-zero', 'enkrypt', 'fearless-wallet', 'polkagate'])
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
})
