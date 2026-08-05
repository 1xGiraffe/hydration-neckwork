/* eslint-disable react-refresh/only-export-components -- proxy note card + the useProxyContract hook the contract sub-tabs share */
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/explorer'
import { useContractAbi } from '../hooks/useExplorerData'
import { Link, paths } from '../router'
import { AddrPill, ShortAddr } from './ui'
import { detectProxy, proxyKindLabel, type ProxyInfo } from '../proxyDetect'
import type { ContractAbiPayload } from '../types'

// Proxy resolution shared by the contract sub-tabs: one detection query per
// address (proxyDetect.ts, browser-side RPC like the tab's other reads), plus
// the implementation's verified ABI through the same lazy artifact endpoint
// every contract uses. Read/Write render the implementation's functions
// against the proxy address — that is what a proxy is for — and the note card
// names the implementation so the reader can jump to its source.

export interface ProxyContract {
  proxy: ProxyInfo | null
  implAbi: ContractAbiPayload | null
  implUnverified: boolean   // detected proxy whose implementation has no verified ABI
  resolving: boolean        // detection (or the implementation ABI) still loading
}

export function useProxyContract(address: string): ProxyContract {
  const detection = useQuery({
    queryKey: ['proxy-impl', address],
    queryFn: () => detectProxy(address),
    // Upgrades are rare but real — keep the window short enough that a fresh
    // visit after an upgrade sees the new implementation.
    staleTime: 300_000,
    retry: false,
  })
  const proxy = detection.data ?? null
  const implAbi = useContractAbi(proxy?.implementation, !!proxy)
  return {
    proxy,
    implAbi: implAbi.data ?? null,
    implUnverified: !!proxy && implAbi.isError,
    resolving: detection.isPending || (!!proxy && implAbi.isPending),
  }
}

// The implementation as a proper account pill when its ref resolves (verified
// contract name, emoji, link), degrading to a linked short address.
function ImplPill({ address }: { address: string }) {
  const refQuery = useQuery({
    queryKey: ['proxy-impl-ref', address],
    queryFn: ({ signal }) => api.accountRefs([address], signal),
    staleTime: 300_000,
    retry: false,
  })
  const ref = refQuery.data?.[0] ?? null
  if (ref) return <AddrPill account={ref} />
  return <span className="mono"><Link className="hash" to={paths.account(address)}><ShortAddr addr={address} /></Link></span>
}

export function ProxyNoteCard({ proxy, implUnverified }: { proxy: ProxyInfo; implUnverified: boolean }) {
  return (
    <div className="id-card">
      <div className="write-bar" style={{ fontSize: 13 }}>
        <span>
          This contract is an {proxyKindLabel(proxy.kind)} — it delegates calls to the implementation{' '}
          <ImplPill address={proxy.implementation} />.{' '}
          {implUnverified
            ? 'The implementation is not verified, so its functions cannot be shown — verify it on its own contract tab.'
            : 'Read and Write use the implementation\'s ABI, executed on this proxy.'}
        </span>
      </div>
    </div>
  )
}
