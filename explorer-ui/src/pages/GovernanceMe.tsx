import { useEffect } from 'react'
import { useQueries } from '@tanstack/react-query'
import { useDocumentTitle, useNoindex } from '../hooks/useDocumentTitle'
import { useNow } from '../hooks/useNow'
import { Link, paths, setQuery, useQueryValue } from '../router'
import { Amt, Crumbs, F } from '../components/ui'
import { govApi } from '../api/explorer'
import { snapshotRetry } from '../hooks/useGovernance'
import { AccountGovernance } from '../components/gov/AccountGovernance'
import { lockTotals, voteStateNote } from '../components/gov/govTotals'
import { NeedsYourVote, WatchAccountsForm } from '../components/gov/GovLists'
import { GovPopover, MomentText, accountLabel, spendableNowOf } from '../components/gov/GovUi'
import { GovTerms } from '../components/gov/Disclosure'
import { useReaderVotes } from '../components/gov/readerVotes'
import { useMyGovernanceAccounts } from '../governanceAccounts'
import { reconnectRemembered, useChainWallets } from '../chainWallet'
import { WalletAccounts } from '../components/gov/WalletAccounts'
import { openVote, openWallets } from '../vote/voteBus'

// /governance/me: the reader's own governance — one ribbon across the accounts in
// view (to vote, locked, unlockable, next unlock), what they still need to vote on,
// and per account its votes, locks and unlock dates. It works without signing
// anything: the signed-in account, the accounts of connected wallets, and the
// addresses followed on this device; "Manage accounts" holds the wallets, the
// accounts they can vote for as a proxy, and the follow form.

/** "3M HDX ready to unlock" across the accounts in view: only HDX that would really become spendable. The page's first action when present. */
function ReadyToUnlock({ ready }: { ready: { address: string; spendable: bigint }[] }) {
  if (!ready.length) return null
  const total = ready.reduce((a, r) => a + r.spendable, 0n)
  return (
    <div className="gov-ready" role="status">
      <span><strong>{F.amount(total.toString(), 12)} HDX</strong> ready to unlock{ready.length > 1 ? ` across ${ready.length} accounts` : ''}.</span>
      <button type="button" className="gov-btn gov-btn-primary" onClick={() => openVote({ kind: 'unlock', address: ready[0].address })}>Unlock</button>
    </div>
  )
}

/** The wallets, the accounts they can vote for, and the followed addresses: one step away from the page. */
function ManageAccounts({ signedIn }: { signedIn: string | null }) {
  return (
    <GovPopover label="Manage accounts" className="gov-manage">
      {signedIn && <p className="gov-fineprint">Signed in as <Link to={paths.account(signedIn)} className="hash mono">{F.shortAddr(signedIn)}</Link>.</p>}
      <WalletAccounts />
      <p className="gov-pop-sub">Follow an address</p>
      <WatchAccountsForm idSuffix="-manage" />
    </GovPopover>
  )
}

export function GovernanceMe() {
  useDocumentTitle('My governance')
  useNoindex(true)
  const now = useNow(30_000)
  const mine = useMyGovernanceAccounts()
  const { accounts } = useChainWallets()
  // The wallets' account lists as they are now, not as they were last remembered.
  useEffect(() => { void reconnectRemembered() }, [])
  // `?account=` narrows the page to one account; without it the page covers them all.
  const requested = useQueryValue('account', '')
  const selected = mine.find(m => m.address === requested)?.address ?? null
  const inView = (selected ? [selected] : mine.map(m => m.address)).slice(0, 10)
  const govs = useQueries({
    queries: inView.map(a => ({ queryKey: ['gov-account', a], queryFn: ({ signal }: { signal: AbortSignal }) => govApi.accountGovernance(a, signal), staleTime: 30_000, ...snapshotRetry })),
  })
  const loaded = govs.flatMap(g => (g.data ? [g.data] : []))
  const reader = useReaderVotes(selected ? [selected] : null)
  const t = lockTotals(loaded)
  const seen = new Set<string>()
  const ready = govs.flatMap((g, i) => (g.data?.locks ?? []).map(l => ({ address: inView[i], account: l.account, spendable: spendableNowOf(l) })))
    .filter(r => { if (r.spendable <= 0n || seen.has(r.account)) return false; seen.add(r.account); return true })
  const nameOf = (address: string) => accounts.find(a => a.address === address)?.name ?? null
  const labelOf = (m: { address: string; source: string }) => accountLabel(m.address, m.source === 'session' ? 'you' : nameOf(m.address) ?? (m.source === 'watched' ? 'followed' : null))
  const signedIn = mine.find(m => m.source === 'session')?.address ?? null
  const toVote = reader.q.data ? reader.rows.length : null
  return (
    <div className="wrap gov-me">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Governance', to: paths.governance() }, { label: 'My governance' }]} />
        <h1 className="page-title">My governance<span className="sub">votes to cast, HDX locked and when it frees</span></h1>
      </div>
      <GovTerms terms={['conviction', 'locks', 'delegation']} extra={loaded[0] ? [voteStateNote(loaded[0])] : undefined} className="gov-head-terms" />

      {!mine.length ? (
        <section className="pf-card gov-hub-card gov-me-empty" aria-labelledby="me-start">
          <h2 id="me-start" className="gov-h3">Start with your account</h2>
          <p>Connect a wallet to see what your accounts still need to vote on, what is locked and when it unlocks, and to vote from here. Connecting only shares your addresses; nothing is signed.</p>
          <button type="button" className="gov-btn gov-btn-primary gov-btn-big" onClick={openWallets}>Connect a wallet</button>
          <p className="gov-fineprint">Or follow an address without connecting:</p>
          <WatchAccountsForm compact />
        </section>
      ) : (
        <>
          <div className="ribbon standalone gov-ribbon" aria-label={selected ? 'This account' : mine.length > 1 ? `Your ${mine.length} accounts` : 'Your account'}>
            <div className="cell"><span className="k">To vote</span><span className="v">{toVote ?? '…'}</span><span className="s">{toVote === 0 ? 'all voted' : toVote != null ? (toVote === 1 ? 'referendum' : 'referenda') : ''}</span></div>
            <div className="cell"><span className="k">Locked by votes</span><span className="v">{loaded.length ? <><Amt raw={t.locked} dec={12} /> HDX</> : '…'}</span></div>
            <div className="cell"><span className="k">Unlockable now</span><span className={`v${t.unlockable > 0n ? ' good' : ''}`}>{loaded.length ? <><Amt raw={t.unlockable.toString()} dec={12} /> HDX</> : '…'}</span></div>
            <div className="cell"><span className="k">Next unlock</span><span className="v">{t.next ? <MomentText at={t.next.at} now={now} withTime={false} /> : loaded.length ? '—' : '…'}</span>{!t.next && t.waiting && <span className="s">after {t.waiting} end</span>}</div>
          </div>

          <div className="gov-me-accounts">
            {mine.length > 1 ? (
              <div className="activity-chips" role="group" aria-label="Accounts in view">
                <button type="button" aria-pressed={!selected} className={`activity-chip${!selected ? ' on' : ''}`} onClick={() => setQuery({ account: null })}>All</button>
                {mine.map(m => (
                  <button key={m.address} type="button" aria-pressed={m.address === selected} className={`activity-chip${m.address === selected ? ' on' : ''}`} onClick={() => setQuery({ account: m.address })}>{labelOf(m)}</button>
                ))}
              </div>
            ) : <span className="gov-me-one mono">{labelOf(mine[0])}</span>}
            <ManageAccounts signedIn={signedIn} />
          </div>

          <ReadyToUnlock ready={ready} />
          <NeedsYourVote now={now} only={selected ? [selected] : null} onShowAll={() => setQuery({ account: null })} />

          {inView.map(a => {
            const m = mine.find(x => x.address === a)!
            return (
              <section key={a} className="gov-section" aria-label={`Votes and locks of ${labelOf(m)}`}>
                <h2 className="gov-h2">Votes and locks{inView.length > 1 || mine.length > 1 ? <span className="gov-h2-sub">{labelOf(m)}</span> : null}<Link to={`${paths.account(a)}?view=governance`} className="gov-more-link">open the account</Link></h2>
                <AccountGovernance address={a} showHistory={false} />
              </section>
            )
          })}
        </>
      )}
    </div>
  )
}
