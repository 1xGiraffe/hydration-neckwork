import { useSyncExternalStore } from 'react'
import { connectSubstrate, discoverEvmProviders } from './wallets'
import type { Eip1193Provider } from './wallets'

// The Write tab's wallet connection — deliberately its own store, completely
// independent of the login session (src/session.ts, /user API): connecting a
// wallet to write to a contract must never sign a login or touch the session
// token. In-memory live handles + a sessionStorage descriptor so a reload
// within the tab can silently reconnect; nothing here outlives the browser
// tab, and nothing here writes localStorage.

export const CONTRACT_WALLET_STORAGE_KEY = 'contract-write-wallet'

// What sessionStorage remembers: enough to find the wallet again (EIP-6963
// rdns / injectedWeb3 key) and the account the visitor picked. Live handles
// (provider, signer) are not serializable and stay in memory only.
export interface ContractWalletDescriptor {
  kind: 'evm' | 'substrate'
  key: string
  address: string
  walletName: string
}

export interface ContractWalletConnection extends ContractWalletDescriptor {
  // The H160 writes act as: the EVM account itself, or (substrate) the
  // truncated first-20-bytes form the runtime's EnsureAddressTruncated maps
  // the signer to. Used as `from` for gas estimates.
  evmFrom: string
  provider?: Eip1193Provider
  // The substrate extension's injected signer (signPayload). Typed loosely so
  // this eager module never imports dedot's types — only the lazy
  // substrateWrite.ts hands it to dedot.
  signer?: unknown
}

let connection: ContractWalletConnection | null = null
const listeners = new Set<() => void>()
function emit() { listeners.forEach(l => l()) }

export function getContractWallet(): ContractWalletConnection | null { return connection }

export function setContractWallet(next: ContractWalletConnection | null): void {
  connection = next
  try {
    if (next) {
      const descriptor: ContractWalletDescriptor = { kind: next.kind, key: next.key, address: next.address, walletName: next.walletName }
      sessionStorage.setItem(CONTRACT_WALLET_STORAGE_KEY, JSON.stringify(descriptor))
    } else {
      sessionStorage.removeItem(CONTRACT_WALLET_STORAGE_KEY)
    }
  } catch { /* ignore */ }
  emit()
}

export function useContractWallet(): ContractWalletConnection | null {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
    () => connection,
    () => connection,
  )
}

export function rememberedContractWallet(): ContractWalletDescriptor | null {
  try {
    const raw = sessionStorage.getItem(CONTRACT_WALLET_STORAGE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as ContractWalletDescriptor
    return v && (v.kind === 'evm' || v.kind === 'substrate') && typeof v.key === 'string' && typeof v.address === 'string' ? v : null
  } catch { return null }
}

// Reconnect the remembered wallet without prompting: eth_accounts (never
// eth_requestAccounts) and a re-enable of an already-authorized substrate
// extension only confirm authorizations that exist. Any miss — provider gone,
// address revoked — resolves to null and leaves the tab in its disconnected
// state; the descriptor stays for a manual reconnect.
export async function restoreContractWallet(settleMs = 150): Promise<ContractWalletConnection | null> {
  const remembered = rememberedContractWallet()
  if (!remembered || connection) return connection
  if (remembered.kind === 'evm') {
    const discovery = discoverEvmProviders()
    if (settleMs > 0) await new Promise(resolve => setTimeout(resolve, settleMs))
    const detail = discovery.list().find(p => p.info.rdns === remembered.key)
    discovery.stop()
    if (!detail) return null
    let accounts: string[]
    try {
      accounts = await detail.provider.request({ method: 'eth_accounts' }) as string[]
    } catch { return null }
    if (!accounts?.some(a => a.toLowerCase() === remembered.address.toLowerCase())) return null
    const restored: ContractWalletConnection = { ...remembered, evmFrom: remembered.address, provider: detail.provider }
    setContractWallet(restored)
    return restored
  }
  try {
    const { accounts, ext } = await connectSubstrate(remembered.key)
    if (!accounts.some(a => a.address === remembered.address)) return null
    // Restoring a substrate connection counts as connecting one: the source
    // derivation lives in the lazy dedot chunk, loaded here on demand.
    const { deriveEvmSource } = await import('./substrateWrite')
    const restored: ContractWalletConnection = {
      ...remembered, evmFrom: deriveEvmSource(remembered.address), signer: ext.signer,
    }
    setContractWallet(restored)
    return restored
  } catch { return null }
}
