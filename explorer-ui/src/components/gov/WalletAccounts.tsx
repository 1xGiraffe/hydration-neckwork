import { useQueries } from '@tanstack/react-query'
import { govApi } from '../../api/explorer'
import { useChainWallets } from '../../chainWallet'
import { openWallets } from '../../vote/voteBus'
import { AddrPill } from '../ui'
import { accountLabel } from './GovUi'
import { snapshotRetry } from '../../hooks/useGovernance'

// The wallets part of /governance/me's "Manage accounts": the connected wallets'
// accounts, and the accounts they can vote for as a Governance or Any proxy with no
// delay (from the indexed Proxy.Proxies). Reads the api only; the chain client loads
// with the voting sheet.

export function WalletAccounts() {
  const { accounts } = useChainWallets()
  const usable = accounts.filter(a => a.kind !== 'substrate-h160').slice(0, 10)
  const govs = useQueries({
    queries: usable.map(a => ({
      queryKey: ['gov-account', a.address],
      queryFn: ({ signal }: { signal: AbortSignal }) => govApi.accountGovernance(a.address, signal),
      staleTime: 30_000,
      ...snapshotRetry,
    })),
  })
  if (!accounts.length) {
    return (
      <div className="gov-wallets">
        <p className="gov-fineprint">Connect a wallet to vote from here, directly or for the accounts it is a proxy for. Connecting signs nothing.</p>
        <button type="button" className="gov-btn" onClick={openWallets}>Connect a wallet</button>
      </div>
    )
  }
  const proxied = new Map<string, { ref: NonNullable<(typeof govs)[number]['data']>['proxies']['canActFor'][number]['account']; via: string; type: string }>()
  govs.forEach((g, i) => {
    for (const p of g.data?.proxies.canActFor ?? []) {
      if (p.canVote && !proxied.has(p.account.accountId)) proxied.set(p.account.accountId, { ref: p.account, via: accountLabel(usable[i].address, usable[i].name), type: p.proxyType })
    }
  })
  return (
    <div className="gov-wallets">
      <ul className="gov-proxy-list">
        {govs.map((g, i) => (
          <li key={usable[i].id}>
            {g.data ? <AddrPill account={g.data.account} noCopy /> : <span className="mono">{accountLabel(usable[i].address)}</span>}
            <span className="muted"> {usable[i].name ? `${usable[i].name} · ` : ''}{usable[i].walletName}</span>
          </li>
        ))}
      </ul>
      {proxied.size > 0 && (
        <>
          <p className="gov-pop-sub">Can vote for</p>
          <ul className="gov-proxy-list">
            {[...proxied.values()].map(p => <li key={p.ref.accountId}><AddrPill account={p.ref} noCopy /> <span className="muted">through {p.via} · {p.type} proxy</span></li>)}
          </ul>
        </>
      )}
      <div className="gov-wallet-actions">
        <button type="button" className="gov-btn" onClick={openWallets}>Manage wallets</button>
      </div>
    </div>
  )
}
