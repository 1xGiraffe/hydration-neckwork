import { useSyncExternalStore } from 'react'
import { useSession } from './session'
import { useChainWallets } from './chainWallet'

// The accounts "my governance" is about: the signed-in account (if any), the
// accounts of the wallets connected for signing (chainWallet.ts), and the addresses
// the reader chose to follow on this device. Nothing here signs anything.
//
// Stored in localStorage on this device only; never sent anywhere except as the
// `accounts` of the needs-vote read.

export const GOV_WATCH_KEY = 'explorer-gov-watch'
export const GOV_WATCH_MAX = 10 // the needs-vote route takes at most 20 accounts, with the session's

function read(): string[] {
  try {
    const raw = localStorage.getItem(GOV_WATCH_KEY)
    const v = raw ? JSON.parse(raw) as unknown : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 128).slice(0, GOV_WATCH_MAX) : []
  } catch { return [] }
}

let watched: string[] = read()
// Followed addresses are kept in the explorer's own format (Polkadot SS58, or an H160),
// so one account is never listed twice under two spellings; an older list written in
// another prefix is re-spelled once, in the background.
if (watched.some(a => !/^(1|0x)/.test(a))) {
  void import('./ss58').then(({ toPolkadotAddress }) => setWatchedAccounts(watched.map(a => toPolkadotAddress(a) ?? a))).catch(() => { /* kept as stored */ })
}
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())

export function setWatchedAccounts(next: string[]): void {
  watched = [...new Set(next.map(s => s.trim()).filter(Boolean))].slice(0, GOV_WATCH_MAX)
  try { localStorage.setItem(GOV_WATCH_KEY, JSON.stringify(watched)) } catch { /* private mode: kept for this tab only */ }
  emit()
}

export function useWatchedAccounts(): string[] {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb)
      const onStorage = (e: StorageEvent) => { if (e.key === GOV_WATCH_KEY) { watched = read(); cb() } }
      window.addEventListener('storage', onStorage)
      return () => { listeners.delete(cb); window.removeEventListener('storage', onStorage) }
    },
    () => watched,
    () => [],
  )
}

export type GovAccountSource = 'session' | 'wallet' | 'watched'

/**
 * The signed-in account first, then connected wallet accounts, then the followed
 * addresses, de-duplicated — every substrate account in the Polkadot SS58 format the
 * rest of the explorer shows (the session's from the api, the wallets' and followed
 * ones re-spelled), so the same account never appears twice. An EVM wallet account is
 * listed by its H160 (the api reads it as its mapped Hydration account); an Ethereum
 * key inside a Polkadot extension cannot vote on Hydration and is left out.
 */
export function useMyGovernanceAccounts(): { address: string; source: GovAccountSource }[] {
  const session = useSession()
  const list = useWatchedAccounts()
  const { accounts } = useChainWallets()
  const out: { address: string; source: GovAccountSource }[] = []
  if (session?.address) out.push({ address: session.address, source: 'session' })
  for (const a of accounts) if (a.kind !== 'substrate-h160' && !out.some(o => o.address === a.address)) out.push({ address: a.address, source: 'wallet' })
  for (const a of list) if (!out.some(o => o.address === a)) out.push({ address: a, source: 'watched' })
  return out
}
