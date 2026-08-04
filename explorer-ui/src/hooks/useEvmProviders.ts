import { useEffect, useState } from 'react'
import { discoverEvmProviders } from '../wallets'
import type { EvmProviderDetail } from '../wallets'

// EIP-6963 providers announce asynchronously; re-poll the same discovery
// handle's list() whenever another one arrives while the dialog is open.
// `onAnnounce` both seeds the initial snapshot and serves as the ongoing
// subscription callback, so this stays "subscribe to an external store".
// Shared by the login ConnectDialog and the contract tab's wallet dialog.
export function useEvmProviders(open: boolean): EvmProviderDetail[] {
  const [providers, setProviders] = useState<EvmProviderDetail[]>([])
  useEffect(() => {
    if (!open) return
    const discovery = discoverEvmProviders()
    const onAnnounce = () => setProviders(discovery.list())
    onAnnounce()
    window.addEventListener('eip6963:announceProvider', onAnnounce)
    return () => { window.removeEventListener('eip6963:announceProvider', onAnnounce); discovery.stop() }
  }, [open])
  return providers
}
