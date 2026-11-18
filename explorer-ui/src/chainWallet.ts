import { useSyncExternalStore } from 'react'
import { connectSubstrate, discoverEvmProviders, isNovaBrowser, listSubstrateWallets, signEvm, signSubstrate } from './wallets'
import type { Eip1193Provider, EvmProviderDetail, InjectedAccount, InjectedExtension } from './wallets'

// The wallets connected for signing on chain — votes, vote removals, unlocks, and
// any later signed action (a forum sign-in signs a message through the same
// connection: `signMessage`). Several wallets can be connected at once (an
// extension and an EVM wallet, say); their accounts form one list.
//
// Separate from the login session (session.ts): connecting a wallet here never
// signs anything and never creates a session. What is remembered (localStorage
// `explorer-chain-wallets`) is public: which wallets were connected and the
// addresses they showed. Live handles (the extension's signer, the EIP-1193
// provider) stay in memory; after a reload the remembered wallets come back
// silently (`reconnectRemembered`) when a signing surface or My governance asks —
// an extension that already authorized the site answers `enable` without a prompt,
// an EVM wallet answers `eth_accounts` without one. Reconnecting re-reads each
// wallet's accounts and subscribes to its changes, so an account added to or
// removed from the wallet since the last visit shows as the wallet has it now.
//
// No SDK here: the chain client loads with the voting chunk (vote/chainWrite.ts).

export const CHAIN_WALLETS_KEY = 'explorer-chain-wallets'

export type ChainAccountKind =
  /** An SS58 account in a substrate extension: signs extrinsics with the extension. */
  | 'substrate'
  /** An EVM wallet account: signs a call permit (or sends to the dispatch precompile) for its mapped Hydration account. */
  | 'evm'
  /** An H160 account held in a substrate extension: it cannot sign Hydration extrinsics. */
  | 'substrate-h160'

export interface ChainWalletEntry {
  /** `substrate:<injectedKey>` or `evm:<rdns>`. */
  id: string
  kind: 'substrate' | 'evm'
  /** window.injectedWeb3 key, or the EIP-6963 rdns ('injected' for a bare window.ethereum). */
  key: string
  name: string
  icon: string
}

export interface ChainAccount {
  /** `${walletId}|${address}` — unique across wallets. */
  id: string
  walletId: string
  walletName: string
  walletIcon: string
  kind: ChainAccountKind
  /**
   * The account as the explorer shows and links it: a substrate account in the
   * Polkadot SS58 format (prefix 0), whatever prefix its wallet uses; an EVM account
   * (or an extension's H160 key) as its 0x H160.
   */
  address: string
  /** A substrate account as its wallet gave it (any SS58 prefix), the spelling handed back to the wallet to sign with; absent when it is `address`. */
  walletAddress?: string
  name: string | null
}

export interface ConnectedWallet {
  entry: ChainWalletEntry
  accounts: ChainAccount[]
  /** 'live' once enabled in this tab; 'remembered' when known from storage but not reconnected yet. */
  status: 'live' | 'remembered'
}

interface LiveHandle { ext?: InjectedExtension; provider?: Eip1193Provider; unsubscribe?: () => void }

let wallets: ConnectedWallet[] = read()
const handles = new Map<string, LiveHandle>()
const listeners = new Set<() => void>()
let snapshot = { wallets, accounts: wallets.flatMap(w => w.accounts) }
function emit() {
  snapshot = { wallets, accounts: wallets.flatMap(w => w.accounts) }
  listeners.forEach(l => l())
}

function read(): ConnectedWallet[] {
  try {
    const raw = localStorage.getItem(CHAIN_WALLETS_KEY)
    if (!raw) return []
    const v = JSON.parse(raw) as { wallets?: { entry: ChainWalletEntry; accounts: ChainAccount[] }[] }
    if (!Array.isArray(v?.wallets)) return []
    return v.wallets
      .filter(w => w?.entry && typeof w.entry.id === 'string' && (w.entry.kind === 'substrate' || w.entry.kind === 'evm') && Array.isArray(w.accounts))
      .map(w => ({
        entry: w.entry,
        accounts: w.accounts.filter(a => a && typeof a.address === 'string' && typeof a.id === 'string').slice(0, 50),
        status: 'remembered' as const,
      }))
  } catch { return [] }
}

function persist() {
  try {
    if (!wallets.length) localStorage.removeItem(CHAIN_WALLETS_KEY)
    else localStorage.setItem(CHAIN_WALLETS_KEY, JSON.stringify({ wallets: wallets.map(w => ({ entry: w.entry, accounts: w.accounts })) }))
  } catch { /* private mode: kept for this tab */ }
}

function upsert(next: ConnectedWallet) {
  const i = wallets.findIndex(w => w.entry.id === next.entry.id)
  wallets = i >= 0 ? wallets.map((w, j) => (j === i ? next : w)) : [...wallets, next]
  persist()
  emit()
}

export function getChainWallets(): ConnectedWallet[] { return wallets }

export function useChainWallets(): { wallets: ConnectedWallet[]; accounts: ChainAccount[] } {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb)
      const onStorage = (e: StorageEvent) => {
        if (e.key !== CHAIN_WALLETS_KEY) return
        // Another tab connected or disconnected: adopt its list, keeping this tab's live handles.
        const live = new Set(wallets.filter(w => w.status === 'live').map(w => w.entry.id))
        wallets = read().map(w => (live.has(w.entry.id) && handles.has(w.entry.id) ? { ...w, status: 'live' as const } : w))
        emit()
      }
      window.addEventListener('storage', onStorage)
      return () => { listeners.delete(cb); window.removeEventListener('storage', onStorage) }
    },
    () => snapshot,
    () => snapshot,
  )
}

/** True when a substrate extension's account is an H160 (Ethereum) key. */
export function isH160(address: string): boolean { return /^0x[0-9a-fA-F]{40}$/.test(address) }

type Respell = (address: string) => string | null

/** The ss58 helper, loaded once the first wallet account needs re-spelling. */
const loadRespell = (): Promise<Respell> => import('./ss58').then(m => m.toPolkadotAddress)

/** A substrate account in the explorer's format, keeping the wallet's own spelling for signing. */
function respelled(a: ChainAccount, respell: Respell): ChainAccount {
  if (a.kind !== 'substrate') return a
  const wallet = a.walletAddress ?? a.address
  const shown = respell(wallet) ?? wallet
  return shown === wallet ? { ...a, address: wallet, walletAddress: undefined } : { ...a, address: shown, walletAddress: wallet }
}

function substrateAccounts(entry: ChainWalletEntry, found: InjectedAccount[], respell: Respell): ChainAccount[] {
  return found.map(a => respelled({
    id: `${entry.id}|${a.address}`,
    walletId: entry.id,
    walletName: entry.name,
    walletIcon: entry.icon,
    kind: a.type === 'ethereum' || isH160(a.address) ? 'substrate-h160' as const : 'substrate' as const,
    address: a.address,
    name: a.name ?? null,
  }, respell))
}

/** The account's address in the spelling its wallet knows it by (what signing hands back to the wallet). */
export function walletAddressOf(account: ChainAccount): string {
  return account.walletAddress ?? account.address
}

function evmAccounts(entry: ChainWalletEntry, addresses: string[]): ChainAccount[] {
  return addresses.filter(isH160).map(address => ({
    id: `${entry.id}|${address.toLowerCase()}`,
    walletId: entry.id,
    walletName: entry.name,
    walletIcon: entry.icon,
    kind: 'evm' as const,
    address,
    name: null,
  }))
}

// Remembered substrate accounts stored in their wallet's spelling (before the explorer
// re-spelled them) are re-spelled once, in the background, and stored again.
if (wallets.some(w => w.accounts.some(a => a.kind === 'substrate' && !a.walletAddress && !/^1/.test(a.address)))) {
  void loadRespell().then(respell => {
    wallets = wallets.map(w => ({ ...w, accounts: w.accounts.map(a => respelled(a, respell)) }))
    persist()
    emit()
  }).catch(() => { /* kept as stored; a reconnect re-spells them */ })
}

export { isNovaBrowser }

/** The substrate extensions to offer: the shared catalog, which already labels the polkadot-js key as Nova only inside Nova. */
export function signingSubstrateWallets() {
  return listSubstrateWallets()
}

/** An EIP-6963 provider's display name; Nova's in-app EVM provider poses as MetaMask, so it is named for what it is. */
export function evmProviderName(detail: EvmProviderDetail): string {
  const p = detail.provider as { isNovaWallet?: boolean }
  if (p.isNovaWallet || (detail.info.rdns === 'injected' && isNovaBrowser())) return 'Nova Wallet (EVM)'
  return detail.info.name
}

export async function connectSubstrateWallet(w: { injectedKey: string; title: string; icon: string }): Promise<ConnectedWallet> {
  const entry: ChainWalletEntry = { id: `substrate:${w.injectedKey}`, kind: 'substrate', key: w.injectedKey, name: w.title, icon: w.icon }
  const [{ accounts, ext }, respell] = await Promise.all([connectSubstrate(w.injectedKey), loadRespell()])
  return adoptSubstrate(entry, ext, accounts, respell)
}

function adoptSubstrate(entry: ChainWalletEntry, ext: InjectedExtension, found: InjectedAccount[], respell: Respell): ConnectedWallet {
  handles.get(entry.id)?.unsubscribe?.()
  const handle: LiveHandle = { ext }
  // Extensions push account changes (added, removed, renamed) through accounts.subscribe.
  const sub = (ext.accounts as { subscribe?: (cb: (accounts: InjectedAccount[]) => void) => (() => void) | Promise<() => void> }).subscribe
  if (typeof sub === 'function') {
    try {
      const un = sub.call(ext.accounts, next => {
        const cur = wallets.find(x => x.entry.id === entry.id)
        if (!cur || cur.status !== 'live' || !Array.isArray(next)) return
        upsert({ ...cur, accounts: substrateAccounts(entry, next, respell) })
      })
      handle.unsubscribe = () => { void Promise.resolve(un).then(f => typeof f === 'function' && f()).catch(() => {}) }
    } catch { /* an extension without a working subscribe keeps its first list */ }
  }
  handles.set(entry.id, handle)
  const next: ConnectedWallet = { entry, accounts: substrateAccounts(entry, found, respell), status: 'live' }
  upsert(next)
  return next
}

export async function connectEvmWallet(detail: EvmProviderDetail): Promise<ConnectedWallet> {
  const entry: ChainWalletEntry = { id: `evm:${detail.info.rdns}`, kind: 'evm', key: detail.info.rdns, name: evmProviderName(detail), icon: detail.info.icon || '' }
  const addresses = await detail.provider.request({ method: 'eth_requestAccounts' }) as string[]
  if (!Array.isArray(addresses) || !addresses.length) throw new Error('The wallet shared no accounts — unlock it and allow this site')
  return adoptEvm(entry, detail.provider, addresses)
}

function adoptEvm(entry: ChainWalletEntry, provider: Eip1193Provider, addresses: string[]): ConnectedWallet {
  handles.get(entry.id)?.unsubscribe?.()
  const handle: LiveHandle = { provider }
  const p = provider as { on?: (e: string, cb: (a: string[]) => void) => void; removeListener?: (e: string, cb: (a: string[]) => void) => void }
  if (typeof p.on === 'function') {
    const onChange = (next: string[]) => {
      const cur = wallets.find(x => x.entry.id === entry.id)
      if (!cur) return
      if (!Array.isArray(next) || !next.length) { disconnectWallet(entry.id); return }
      upsert({ ...cur, accounts: evmAccounts(entry, next), status: 'live' })
    }
    try {
      p.on('accountsChanged', onChange)
      handle.unsubscribe = () => { try { p.removeListener?.('accountsChanged', onChange) } catch { /* ignore */ } }
    } catch { /* ignore */ }
  }
  handles.set(entry.id, handle)
  const next: ConnectedWallet = { entry, accounts: evmAccounts(entry, addresses), status: 'live' }
  upsert(next)
  return next
}

export function disconnectWallet(walletId: string): void {
  handles.get(walletId)?.unsubscribe?.()
  handles.delete(walletId)
  wallets = wallets.filter(w => w.entry.id !== walletId)
  persist()
  emit()
}

/**
 * Bring remembered wallets back to life without prompting. A wallet that no longer
 * answers (removed, locked, authorization revoked) stays listed as remembered, so
 * its accounts keep showing and one click reconnects it.
 */
let reconnecting: Promise<void> | null = null
export function reconnectRemembered(settleMs = 200): Promise<void> {
  if (reconnecting) return reconnecting
  const pending = wallets.filter(w => w.status === 'remembered')
  if (!pending.length) return Promise.resolve()
  reconnecting = (async () => {
    const discovery = pending.some(w => w.entry.kind === 'evm') ? discoverEvmProviders() : null
    if (discovery && settleMs > 0) await new Promise(resolve => setTimeout(resolve, settleMs))
    for (const w of pending) {
      try {
        if (w.entry.kind === 'substrate') {
          const injected = (window as { injectedWeb3?: Record<string, unknown> }).injectedWeb3?.[w.entry.key]
          if (!injected) continue
          const [{ accounts, ext }, respell] = await Promise.all([connectSubstrate(w.entry.key), loadRespell()])
          adoptSubstrate(w.entry, ext, accounts, respell)
        } else {
          const detail = discovery?.list().find(p => p.info.rdns === w.entry.key)
          if (!detail) continue
          const addresses = await detail.provider.request({ method: 'eth_accounts' }) as string[]
          if (!Array.isArray(addresses) || !addresses.length) continue
          adoptEvm(w.entry, detail.provider, addresses)
        }
      } catch { /* stays remembered */ }
    }
    discovery?.stop()
  })().finally(() => { reconnecting = null })
  return reconnecting
}

export type AccountSigner =
  | { kind: 'substrate'; signer: unknown; ext: InjectedExtension }
  | { kind: 'evm'; provider: Eip1193Provider }

/** The live signer for an account, or null when its wallet is not connected in this tab. */
export function signerFor(account: ChainAccount): AccountSigner | null {
  const h = handles.get(account.walletId)
  if (!h) return null
  if (account.kind === 'substrate' && h.ext) return { kind: 'substrate', signer: h.ext.signer, ext: h.ext }
  if (account.kind === 'evm' && h.provider) return { kind: 'evm', provider: h.provider }
  return null
}

/**
 * Sign a plain message with a connected account — substrate `signRaw` (the
 * extension wraps it in <Bytes>) or EVM `personal_sign` — the form
 * `/user/auth/verify` checks. No transaction, no fee.
 */
export async function signMessage(account: ChainAccount, message: string): Promise<string> {
  const s = signerFor(account)
  if (!s) throw new Error(`${account.walletName} is not connected in this tab — reconnect it first`)
  return s.kind === 'substrate' ? signSubstrate(s.ext, walletAddressOf(account), message) : signEvm(s.provider, account.address, message)
}
