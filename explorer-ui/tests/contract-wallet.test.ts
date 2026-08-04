import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getContractWallet, setContractWallet, rememberedContractWallet, restoreContractWallet,
  CONTRACT_WALLET_STORAGE_KEY,
} from '../src/contractWallet'
import { getSession, SESSION_STORAGE_KEY } from '../src/session'
import type { Eip1193Provider } from '../src/wallets'

// Same browser-global stand-ins the session/wallets tests use: a Map-backed
// Storage and a bare EventTarget window (no jsdom in this repo).
function memoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size },
  }
}

type StubWindow = EventTarget & { injectedWeb3?: unknown; ethereum?: unknown }
function stubWindow(): StubWindow {
  const win = new EventTarget() as StubWindow
  vi.stubGlobal('window', win)
  return win
}

// An EIP-6963 wallet that answers announce requests and serves accounts —
// what a real extension leaves behind on window after a page reload.
function announceEvmProvider(win: StubWindow, rdns: string, accounts: string[]) {
  const provider: Eip1193Provider = {
    request: async ({ method }) => {
      if (method === 'eth_accounts') return accounts
      throw new Error(`unexpected ${method}`)
    },
  }
  const announce = () => win.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
    detail: { info: { rdns, name: 'Test Wallet', icon: '' }, provider },
  }))
  win.addEventListener('eip6963:requestProvider', announce)
  return provider
}

const H160 = '0x9a1c2b3d4e5f60718293a4b5c6d7e8f901234567'

beforeEach(() => {
  stubWindow()
  vi.stubGlobal('sessionStorage', memoryStorage())
  vi.stubGlobal('localStorage', memoryStorage())
  setContractWallet(null)
})

describe('contract wallet store', () => {
  it('keeps the live handle in memory and only the descriptor in sessionStorage', () => {
    const provider: Eip1193Provider = { request: async () => null }
    setContractWallet({ kind: 'evm', key: 'io.metamask', address: H160, walletName: 'MetaMask', evmFrom: H160, provider })
    expect(getContractWallet()?.provider).toBe(provider)
    const persisted = JSON.parse(sessionStorage.getItem(CONTRACT_WALLET_STORAGE_KEY)!)
    expect(persisted).toEqual({ kind: 'evm', key: 'io.metamask', address: H160, walletName: 'MetaMask' })
    expect(rememberedContractWallet()).toEqual(persisted)
  })

  it('disconnect clears both the memory handle and the remembered descriptor', () => {
    setContractWallet({ kind: 'evm', key: 'io.metamask', address: H160, walletName: 'MetaMask', evmFrom: H160 })
    setContractWallet(null)
    expect(getContractWallet()).toBeNull()
    expect(sessionStorage.getItem(CONTRACT_WALLET_STORAGE_KEY)).toBeNull()
    expect(rememberedContractWallet()).toBeNull()
  })

  it('ignores a malformed remembered value', () => {
    sessionStorage.setItem(CONTRACT_WALLET_STORAGE_KEY, '{broken')
    expect(rememberedContractWallet()).toBeNull()
  })

  it('never touches the login session', () => {
    setContractWallet({ kind: 'evm', key: 'io.metamask', address: H160, walletName: 'MetaMask', evmFrom: H160 })
    setContractWallet(null)
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
    expect(localStorage.length).toBe(0)
    expect(getSession()).toBeNull()
  })
})

// The hard isolation requirement (spec §7.5): the contract-write wallet layer
// must never touch the login session. The runtime test above proves no write
// happens on the flows we exercise; this one pins the import graph so a future
// edit can't quietly wire the dialog into session.ts or the authed userApi.
describe('login-session isolation (import graph)', () => {
  const files = [
    'src/contractWallet.ts',
    'src/components/WalletPicker.tsx',
    'src/components/ContractWalletDialog.tsx',
    'src/components/ContractWriteTab.tsx',
  ]
  it.each(files)('%s never imports session.ts or userApi', file => {
    const content = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8')
    expect(content).not.toMatch(/from '[^']*\/session'|from '\.\/session'/)
    expect(content).not.toMatch(/import[^\n]*\buserApi\b/)
    expect(content).not.toMatch(/\buserApi\s*\./)
    expect(content).not.toMatch(/\bsetSession\s*\(/)
  })
})

describe('restoreContractWallet', () => {
  it('silently reconnects a remembered EVM wallet that still authorizes the address', async () => {
    const win = stubWindow()
    const provider = announceEvmProvider(win, 'io.metamask', [H160.toUpperCase().replace('0X', '0x')])
    sessionStorage.setItem(CONTRACT_WALLET_STORAGE_KEY, JSON.stringify({ kind: 'evm', key: 'io.metamask', address: H160, walletName: 'MetaMask' }))
    const conn = await restoreContractWallet(0)
    expect(conn?.address).toBe(H160)
    expect(conn?.evmFrom).toBe(H160)
    expect(conn?.provider).toBe(provider)
    expect(getContractWallet()).toBe(conn)
  })

  it('stays disconnected when the wallet no longer authorizes the remembered address', async () => {
    const win = stubWindow()
    announceEvmProvider(win, 'io.metamask', ['0x' + '22'.repeat(20)])
    sessionStorage.setItem(CONTRACT_WALLET_STORAGE_KEY, JSON.stringify({ kind: 'evm', key: 'io.metamask', address: H160, walletName: 'MetaMask' }))
    expect(await restoreContractWallet(0)).toBeNull()
    expect(getContractWallet()).toBeNull()
  })

  it('stays disconnected when the remembered provider is gone or nothing is remembered', async () => {
    expect(await restoreContractWallet(0)).toBeNull()
    sessionStorage.setItem(CONTRACT_WALLET_STORAGE_KEY, JSON.stringify({ kind: 'evm', key: 'io.gone', address: H160, walletName: 'Gone' }))
    expect(await restoreContractWallet(0)).toBeNull()
  })

  it('reconnects a remembered substrate wallet and re-derives the truncated H160 source', async () => {
    const win = stubWindow()
    const signer = { signPayload: async () => ({ signature: '0x' }) }
    const ss58 = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'
    win.injectedWeb3 = {
      'polkadot-js': {
        enable: async () => ({ accounts: { get: async () => [{ address: ss58, name: 'Stash' }] }, signer }),
      },
    }
    sessionStorage.setItem(CONTRACT_WALLET_STORAGE_KEY, JSON.stringify({ kind: 'substrate', key: 'polkadot-js', address: ss58, walletName: 'Polkadot{.js}' }))
    const conn = await restoreContractWallet(0)
    expect(conn?.kind).toBe('substrate')
    expect(conn?.evmFrom).toBe('0xba896f978f18d179207937a73758022ff6b405bc')
    expect(conn?.signer).toBe(signer)
    expect(getContractWallet()).toBe(conn)
  })

  it('stays disconnected when the remembered substrate account is no longer offered', async () => {
    const win = stubWindow()
    win.injectedWeb3 = {
      'polkadot-js': {
        enable: async () => ({ accounts: { get: async () => [{ address: '13QPjZbNQBevMFty4jyUeMupdBnq6JgtSSKVvXfrhWCsdGqu' }] }, signer: {} }),
      },
    }
    sessionStorage.setItem(CONTRACT_WALLET_STORAGE_KEY, JSON.stringify({ kind: 'substrate', key: 'polkadot-js', address: '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ', walletName: 'Polkadot{.js}' }))
    expect(await restoreContractWallet(0)).toBeNull()
    expect(getContractWallet()).toBeNull()
  })
})
