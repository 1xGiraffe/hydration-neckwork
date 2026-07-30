import { useState } from 'react'
import { useCloseAccounts, useTagCloseAccounts } from '../hooks/useExplorerData'
import { AddrPill, F } from './ui'
import { closeAccountReasonText } from '../utils/closeAccounts'

function lastSeenLabel(value: string): string {
  const date = value.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : value
}

function CloseAccountsLoading() {
  return (
    <div className="close-accounts-loading" role="status" aria-live="polite">
      <span>Comparing activity signals…</span>
      {[0, 1, 2].map(i => <div className="close-account-skeleton" key={i}><span /><span /></div>)}
    </div>
  )
}

function CloseAccountsDisclosure({ address, tagId }: { address: string | null; tagId: string | null }) {
  const [opened, setOpened] = useState(false)
  // Exactly one of the two targets is set; the other hook stays disabled.
  const byAddress = useCloseAccounts(address, opened)
  const byTag = useTagCloseAccounts(tagId, opened)
  const matches = tagId ? byTag : byAddress

  const data = matches.data
  return (
    <details className="close-accounts" onToggle={event => setOpened(event.currentTarget.open)}>
      <summary>
        <span className="close-accounts-summary-copy">
          <span className="close-accounts-title">Close accounts</span>
          <span className="close-accounts-subtitle">Behaviorally similar activity · calculated on demand</span>
        </span>
        <span className="close-accounts-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="close-accounts-body" role="region" aria-label="Close accounts analysis">
        {matches.isPending || (matches.isFetching && !data) ? <CloseAccountsLoading />
          : matches.isError ? (
            <div className="close-accounts-state" role="alert">
              <strong>Couldn’t load close accounts</strong>
              <span>The activity comparison failed. No relationship conclusion was made.</span>
              <button type="button" className="close-accounts-retry" onClick={() => { void matches.refetch() }}>Try again</button>
            </div>
          ) : !data?.accounts.length ? (
            <div className="close-accounts-state">
              <strong>No sufficiently strong links found</strong>
              <span>No account passed the false-positive safeguards{data?.lookbackDays != null ? <> in the last {F.int(data.lookbackDays)} days</> : ' across the indexed history'}.</span>
            </div>
          ) : (
            <>
              <div className="close-accounts-context">Signals found across {data.lookbackDays != null ? <>the last {F.int(data.lookbackDays)} days</> : "the full indexed history"}</div>
              <ul className="close-accounts-list">
                {data.accounts.map(match => (
                  <li className="close-account-match" key={match.account.accountId}>
                    <div className="close-account-head">
                      <AddrPill account={match.account} noTag noCopy />
                      <span className={`close-account-confidence ${match.confidence}`}>{match.confidence} signal</span>
                      <time className="close-account-seen" dateTime={match.lastSeen}>last signal {lastSeenLabel(match.lastSeen)}</time>
                    </div>
                    <ul className="close-account-reasons" aria-label={`Signals for ${match.account.address}`}>
                      {match.reasons.map((reason, index) => <li key={`${reason.type}-${index}`}>{closeAccountReasonText(reason)}</li>)}
                    </ul>
                  </li>
                ))}
              </ul>
            </>
          )}
        {data?.disclaimer && <p className="close-accounts-disclaimer">{data.disclaimer}</p>}
      </div>
    </details>
  )
}

export function CloseAccountsSection({ address, tagId }: { address?: string; tagId?: string }) {
  // Keying the stateful disclosure by canonical address / tag closes it and
  // detaches the old query observer on SPA navigation. React Query then aborts
  // any in-flight request through the signal consumed by the API client.
  return <CloseAccountsDisclosure key={tagId ?? address} address={address ?? null} tagId={tagId ?? null} />
}
