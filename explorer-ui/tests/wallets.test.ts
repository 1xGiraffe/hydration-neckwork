import { describe, it, expect, beforeEach, vi } from 'vitest'
import { listSubstrateWallets, discoverEvmProviders, toHexMessage, accountRowLabel, WALLET_APP_LINKS } from '../src/wallets'

// jsdom/happy-dom aren't project dependencies, so there is no ambient `window`
// under the default Node test environment. Node's own EventTarget already
// implements add/removeEventListener + dispatchEvent, so a bare instance with
// a couple of extra properties stands in for it — mirrors the memoryStorage
// stub in tests/session.test.ts. A fresh one per test keeps the EIP-6963
// listener wallets.ts attaches from leaking across tests.
type StubWindow = EventTarget & { injectedWeb3?: unknown; ethereum?: unknown; walletExtension?: unknown }
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
    // Outside Nova's browser the polkadot-js key IS Polkadot{.js}: Nova is only an install link.
    expect(byId.get('nova')?.installed).toBe(false)
    expect(byId.get('nova')?.injectedKey).toBe('polkadot-js')
    expect(byId.get('talisman')?.installed).toBe(true)
    expect(byId.get('subwallet-js')?.installed).toBe(false)
    expect(byId.get('subwallet-js')?.installUrl).toContain('http')
  })

  it('inside Nova\'s browser the polkadot-js key is Nova, and the Polkadot{.js} tile is hidden', () => {
    const w = window as { injectedWeb3?: unknown; walletExtension?: unknown }
    w.injectedWeb3 = { 'polkadot-js': { enable: async () => ({}) } }
    w.walletExtension = { isNovaWallet: true }
    const wallets = listSubstrateWallets()
    expect(wallets.find(x => x.id === 'nova')?.installed).toBe(true)
    expect(wallets.some(x => x.id === 'polkadot-js')).toBe(false)
    expect(wallets[0].id).toBe('nova')
  })

  it('sorts installed wallets ahead of uninstalled ones WITHIN each group, shortlist group first', () => {
    ;(window as { injectedWeb3?: unknown }).injectedWeb3 = { 'subwallet-js': { enable: async () => ({}) } }
    const ids = listSubstrateWallets().map(w => w.id)
    expect(ids).toEqual(['subwallet-js', 'talisman', 'nova', 'polkadot-js', 'aleph-zero', 'enkrypt', 'fearless-wallet', 'polkagate', 'manta-wallet-js'])
  })

  it('shortlists exactly Talisman, Nova and SubWallet when nothing is installed', () => {
    const wallets = listSubstrateWallets()
    expect(wallets.filter(w => w.shortlist).map(w => w.id)).toEqual(['talisman', 'nova', 'subwallet-js'])
    expect(wallets.filter(w => !w.shortlist).map(w => w.id)).toEqual(['polkadot-js', 'aleph-zero', 'enkrypt', 'fearless-wallet', 'polkagate', 'manta-wallet-js'])
  })

  it('an installed Polkadot{.js} joins the shortlist and leads it; Nova stays an install link', () => {
    ;(window as { injectedWeb3?: unknown }).injectedWeb3 = { 'polkadot-js': { enable: async () => ({}) } }
    const wallets = listSubstrateWallets()
    expect(wallets.map(w => w.id).slice(0, 4)).toEqual(['polkadot-js', 'talisman', 'nova', 'subwallet-js'])
    expect(wallets.find(w => w.id === 'nova')?.installed).toBe(false)
    expect(wallets.find(w => w.id === 'polkadot-js')).toMatchObject({ installed: true, shortlist: true })
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
    expect(accountRowLabel({ ...ref, profile: { name: 'Alice', avatarVersion: 0 } }, 'Wallet 1'))
      .toEqual({ primary: 'Alice', kind: 'profile', address: ref.address })
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

describe('WALLET_APP_LINKS', () => {
  it('opens the exact page, encoded, in SubWallet\'s in-app browser, and lists only verified wallets', () => {
    const url = 'https://hydration-explorer.neckwork.net/referendum/opengov/450?tab=votes&x=a b'
    const sub = WALLET_APP_LINKS.find(w => w.id === 'subwallet-js')!
    expect(sub.link(url)).toBe(`https://mobile.subwallet.app/browser?url=${encodeURIComponent(url)}`)
    expect(new URL(sub.link(url)).searchParams.get('url')).toBe(url)
    // Nova's app link works only for catalog-listed dApps; Talisman documents none.
    expect(WALLET_APP_LINKS.map(w => w.id)).toEqual(['subwallet-js'])
  })
})
