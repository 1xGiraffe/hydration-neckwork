import { lazy, Suspense, useEffect, useState } from 'react'
import { useAddress, useAddressHistory, useAddressValueEvents, useAccountActivityCounts, useAccountListCount, useStats } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths, redirect, useQueryValue, setQuery } from '../router'
import { Crumbs, F, Copy, ShortAddr, ProfilePageSkeleton, DetailTabs, moduleName, emojiName, TagIcon, AccountEmoji, UserTagPill, rowNav, EmptyRow } from '../components/ui'
import { PortfolioChart, ProfileStats, MoneyMarketPositions, moneyMarketDebtUsd, profileTabs, ActiveDcaTable, LiquidityPositionsTable, ProxyMultisigSection, ContractSection } from '../components/AccountSections'
import { BalancesTreemap } from '../components/BalancesTreemap'
import { CloseAccountsSection } from '../components/CloseAccountsSection'
import { ScopedActivity } from '../components/ScopedActivity'
import { NotifyButton } from '../components/NotifyButton'
import { activityListCount, voteListCount } from '../utils/activityPaging'
import { VotesTab } from '../components/VotesTab'
import { useSession } from '../session'
import { requestConnect } from '../connectDialog'
import { useAddressLists, useAddressTaggedIn, useMe } from '../hooks/useUser'
import { allAssociations, useTagMapVersion } from '../userTags'
import type { ListSummaryRef } from '../types'

// Radix + the dialog are only needed once the account owner actually opens the
// editor, so it's a route-chunk-style lazy import (matching ConnectDialog from
// the Topbar) rather than a static one carried by every visitor's entry chunk.
const EditProfileDialog = lazy(() => import('../components/EditProfileDialog').then(m => ({ default: m.EditProfileDialog })))

// The contract tab (source viewer, verify form, read panel) is only relevant on
// the few hundred contract accounts — a lazy chunk keeps it (and, one dynamic
// import deeper, the viem ABI codec) out of every other account page load.
const ContractTab = lazy(() => import('../components/ContractTab').then(m => ({ default: m.ContractTab })))

// Hydration opens any route with the account preselected, so the app shows this
// account's balances and positions. Deep-link to the swap page: it is the app's
// landing route, and every other section stays one click away.
function hydrationAppUrl(address: string): string {
  return `https://app.hydration.net/trade/swap/market?account=${encodeURIComponent(address)}`
}

export function Account({ address }: { address: string }) {
  useTagMapVersion()   // re-render when the viewer's tag map changes
  const { data, isLoading, isError } = useAddress(address)
  const session = useSession()
  const isOwn = !!session && !!data && session.accountId === data.accountId
  const me = useMe()
  const libs = useAddressLists(address)
  const taggedIn = useAddressTaggedIn(address)
  const [editOpen, setEditOpen] = useState(false)
  const [editMounted, setEditMounted] = useState(false)
  const now = useNow()
  // Both the DCA countdowns and the proxy announcement delays are block counts
  // the page states in time, so they convert at the chain's measured pace.
  const { data: stats } = useStats(!!data?.activeDcas?.length || !!data?.proxy)
  const canonicalAddress = data ? (data.evmAddress ?? data.ss58Polkadot) : null
  const rawView = useQueryValue('view', 'overview')
  const legacyAtab = useQueryValue('atab', '')
  // Old links nested Extrinsics/Events under ?view=activity&atab=…; both are
  // first-level views now, so those URLs land on the promoted tab.
  const view = rawView === 'activity' && (legacyAtab === 'extrinsics' || legacyAtab === 'events') ? legacyAtab : rawView
  // Only the Balances treemap reads the per-asset balance history, and it is 98-99%
  // of the history payload — so the Overview asks for the value series alone. The
  // need latches: a reader who lands on `?view=balances` gets the full shape on the
  // first request, and coming back to the Overview reuses it instead of trading it
  // for the light one.
  const [needBalanceHistory, setNeedBalanceHistory] = useState(view === 'balances')
  if (view === 'balances' && !needBalanceHistory) setNeedBalanceHistory(true)
  const history = useAddressHistory(canonicalAddress, !needBalanceHistory)
  const valueEvents = useAddressValueEvents(canonicalAddress)
  // The Activity tab badge is the exact length of the activity list, shared with
  // the list's own unfiltered total; absent while it resolves, and absent for good
  // on a feed too deep to count (rather than showing an overshooting estimate).
  const activityTotal = useAccountListCount(canonicalAddress, activityListCount('all', '', {}))
  const votesTotal = useAccountListCount(canonicalAddress, voteListCount())
  // Raw extrinsic/event counts badge the two promoted tabs; ScopedActivity asks
  // for the same key, so the two share one request.
  const activityCounts = useAccountActivityCounts(address)
  const headBlock = stats?.headBlock ?? 0

  // Document title mirrors the header's display-name logic: best-known name
  // (module > profile name > identity > emoji name) plus the
  // short canonical address.
  const shortAddr = data ? F.shortAddr(data.evmAddress ?? data.ss58Polkadot) : null
  // The document title names the ACCOUNT itself (module → profile → identity →
  // emoji name) — its tag memberships are chips on the page, not its name.
  const acctName = data ? (moduleName(data.accountId) ?? data.profile?.name ?? data.identity?.display ?? data.emojiName ?? emojiName(data.emoji)) : null
  useDocumentTitle(data ? (acctName ? `${acctName} · ${shortAddr}` : shortAddr) : undefined)

  // Canonicalize the URL: always show the Polkadot SS58 (substrate) or EVM H160
  // address, never the raw AccountId32 / Hydration SS58. Replace (not push) so the
  // back button still works.
  useEffect(() => {
    if (!data) return
    const canonical = data.evmAddress ?? data.ss58Polkadot
    if (canonical && address !== canonical) redirect(`${paths.account(canonical)}${window.location.search}`)
  }, [data, address])

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Accounts', to: paths.accounts() }, { label: data ? F.shortAddr(data.evmAddress ?? data.ss58Polkadot) : '…' }]} />
      </div>

      {isError ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Address not recognized</div>
        : isLoading || !data ? <ProfilePageSkeleton /> : (() => {
          const mod = moduleName(data.accountId)
          const associations = allAssociations(data)
          const mmList = data.moneyMarket
          const explicitEvmBinding = data.aliases.find(alias => alias.relationship === 'explicit_binding' && alias.evmAddress)?.evmAddress
          // Debt counts from every market and is netted out of the portfolio Value.
          const debtUsd = moneyMarketDebtUsd(mmList)
          const tabs = profileTabs(data.balances.length, mmList, data.activeDcas?.length ?? 0, data.liquidityPositions?.length ?? 0, activityTotal.data, votesTotal.data?.total ?? undefined, !!data.contract, activityCounts.data?.extrinsics, activityCounts.data?.events)
          const activeView = tabs.some(t => t.key === view) ? view : 'overview'
          return (
            <>
              {/* Above the header card and right-aligned, matching "Open in preis"
                  on the asset page and "Open in Subsquare" on a referendum. */}
              <div className="ext-link-row">
                {isOwn && <button type="button" className="ext-link" style={{ cursor: 'pointer' }} onClick={() => { setEditMounted(true); setEditOpen(true) }}>Edit profile</button>}
                {/* Watching an account is the single most-asked-for alert, and
                    this is the only page that knows which address is meant. */}
                <NotifyButton
                  variant="link"
                  label="Get notified"
                  title="Alert me on this account's activity"
                  rule={{ kind: 'account-activity', params: { target: { kind: 'address', address: canonicalAddress ?? address } }, name: `Activity of ${F.shortAddr(canonicalAddress ?? address)}` }}
                />
                <a className="ext-link" href={hydrationAppUrl(canonicalAddress ?? address)} target="_blank" rel="noopener">Open in Hydration ↗</a>
              </div>
              <div className="acct-head">
                {/* The page is about the ACCOUNT, so the header always wears the
                    account's own face — profile image (via AccountEmoji) or its
                    emoji — never the tag's. Tag membership lives in the chip row
                    below, where it links to the tag's aggregate page instead of
                    making every member page impersonate the tag. */}
                <div className="acct-avatar">{mod ? '⚙️'
                  : <AccountEmoji account={data} className="acct-avatar-icon" imgClass="acct-avatar-img" />}</div>
                <div className="acct-meta">
                  <div className="tag">{mod
                    ? <span style={{ fontSize: 18 }}>{mod}</span>
                    : data.profile?.name
                      ? <span style={{ fontSize: 18, fontStyle: 'italic', color: 'var(--amber)' }}>{data.profile.name}</span>
                      : data.identity?.display
                        ? <span style={{ fontSize: 18 }}>{data.identity.display}{data.identity.verified && <span className="id-verified" title="Verified identity" style={{ marginLeft: 5 }}>✓</span>}</span>
                        : data.contract?.verification?.name
                          // A verified contract's name fills the name slot the way
                          // an identity display name does (never the ✓ — that stays
                          // exclusive to registrar-verified identities).
                          ? <span style={{ fontSize: 18 }}>{data.contract.verification.name}</span>
                          : <span style={{ fontSize: 18 }}>{emojiName(data.emoji) ?? 'Account'}</span>}
                    {data.contract && <span className="badge" title="Deployed EVM smart contract — this address holds code" style={{ color: 'var(--neutral)', background: 'color-mix(in srgb, var(--neutral) 14%, transparent)' }}>contract</span>}
                    {data.contract?.destroyed && <span className="badge" title="No code at this address anymore (selfdestructed or removed); history stays addressable" style={{ color: 'var(--neutral)', background: 'color-mix(in srgb, var(--neutral) 14%, transparent)' }}>destroyed</span>}
                    {data.proxy?.isPure && <span className="badge" title="Keyless pure-proxy account — controlled only through its proxies" style={{ color: 'var(--neutral)', background: 'color-mix(in srgb, var(--neutral) 14%, transparent)' }}>pure proxy</span>}
                    {data.multisig && <span className="badge" title={`Multisig account — any ${data.multisig.threshold} of ${data.multisig.signatories.length} signatories can act`} style={{ color: 'var(--neutral)', background: 'color-mix(in srgb, var(--neutral) 14%, transparent)' }}>{data.multisig.threshold}/{data.multisig.signatories.length} multisig</span>}</div>
                  {/* No EVM badge here: the 0x prefix already says it (and the
                      identities card shows "EVM (H160)") — the badge forced the
                      address to wrap mid-token on phones. */}
                  <div className="full">
                    <span className="mono"><ShortAddr addr={data.evmAddress ?? data.ss58Polkadot} full /></span> <Copy text={data.evmAddress ?? data.ss58Polkadot} />
                  </div>
                  {associations.length > 0 && (
                    <div className="row gap6" style={{ marginTop: 2, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span className="muted" style={{ fontFamily: 'GeistMono', fontSize: 11 }}>Tags</span>
                      {associations.map(a => <UserTagPill key={a.listId ?? `system-${a.id}`} tag={a} address={data.evmAddress ?? data.ss58Polkadot} noCopy noMemberSuffix />)}
                    </div>
                  )}
                  {/* Logged-out teaser, one quiet self-contained line — it names
                      no list on purpose (the contents stay behind the login). */}
                  <TaggedInHint taggedIn={taggedIn.data ?? []} session={session} />
                </div>
                <ProfileStats tradingVolumeUsd={data.tradingVolumeUsd} liquidationVolumeUsd={data.liquidationVolumeUsd} revenueUsd={data.revenueUsd} valueUsd={data.portfolioUsd - debtUsd} />
              </div>

              <DetailTabs tabs={tabs} active={activeView} onChange={k => setQuery({ view: k === 'overview' ? null : k })} />

              {activeView === 'overview' && (<>
              {(() => {
                // Identity rows beyond what the header already shows: on-chain identity
                // fields, plus the account's OTHER address form — the bound SS58 for an
                // EVM account, the observed H160 (if any) for a substrate account. The
                // header's primary address, and the raw account id, are never repeated.
                const observedEvm = !data.evmAddress ? data.aliases.find(a => a.evmAddress)?.evmAddress : null
                const rows: { dt: string; dd: React.ReactNode }[] = []
                if (data.identity?.display) rows.push({
                  dt: 'On-chain identity',
                  dd: <>{data.identity.display}{data.identity.verified
                    ? <span className="badge ok" style={{ marginLeft: 6 }}>Verified</span>
                    : <span className="muted mono" style={{ fontSize: 11, marginLeft: 6 }}>unverified</span>}</>,
                })
                if (data.identity?.email) rows.push({ dt: 'Email', dd: <span className="mono"><a href={`mailto:${data.identity.email}`}>{data.identity.email}</a></span> })
                if (data.identity?.web) rows.push({ dt: 'Website', dd: <span className="mono"><a href={data.identity.web} target="_blank" rel="noopener">{data.identity.web}</a></span> })
                if (data.identity?.twitter) {
                  const handle = data.identity.twitter.replace(/^@/, '')
                  rows.push({ dt: 'X', dd: <span className="mono"><a href={`https://x.com/${handle}`} target="_blank" rel="noopener">@{handle}</a></span> })
                }
                if (data.evmAddress && data.ss58Polkadot) rows.push({ dt: 'Polkadot (SS58)', dd: <span className="mono"><ShortAddr addr={data.ss58Polkadot} full /> <Copy text={data.ss58Polkadot} /></span> })
                if (observedEvm) rows.push({ dt: 'EVM (H160)', dd: <span className="mono"><ShortAddr addr={observedEvm} full /> <Copy text={observedEvm} /></span> })
                if (!rows.length) return null
                return (
                  <div className="id-card">
                    <div className="id-card-head">Identities</div>
                    <div className="dl">
                      {rows.map(r => <span key={r.dt} style={{ display: 'contents' }}><div className="dt">{r.dt}</div><div className="dd">{r.dd}</div></span>)}
                    </div>
                  </div>
                )
              })()}

              <ContractSection contract={data.contract} now={now} />

              <ProxyMultisigSection proxy={data.proxy} multisig={data.multisig} memberships={data.multisigMemberships} now={now} blockSec={stats?.avgBlockSec} />

              <CloseAccountsSection address={canonicalAddress ?? address} />

              <ListsSection publicLists={libs.data ?? []} ownLists={isOwn ? (me.data?.lists ?? []) : []} isOwn={isOwn} />

              <PortfolioChart title="Value" netUsd={data.portfolioUsd - debtUsd} series={history.data?.portfolioSeries ?? data.portfolioSeries ?? []} dates={history.data?.portfolioDates ?? data.portfolioDates} balanceHistory={history.data?.balanceHistory ?? data.balanceHistory} loading={history.isLoading || (history.isFetching && !history.data)} valueEvents={valueEvents.data} />
              </>)}

              {activeView === 'balances' && (
              <BalancesTreemap balances={data.balances} balanceHistory={history.data?.balanceHistory ?? data.balanceHistory} />
              )}

              {activeView === 'positions' && (<>
              <MoneyMarketPositions markets={mmList} defisimAddress={data.evmAddress ?? explicitEvmBinding ?? data.accountId} />
              {data.activeDcas && <ActiveDcaTable dcas={data.activeDcas} headBlock={headBlock} headTime={stats?.headTime} now={now} blockSec={stats?.avgBlockSec} />}
              {data.liquidityPositions && <LiquidityPositionsTable positions={data.liquidityPositions} />}
              </>)}

              {activeView === 'contract' && data.contract && (
                <Suspense fallback={null}>
                  <ContractTab address={data.evmAddress ?? data.contract.address} contract={data.contract} />
                </Suspense>
              )}

              {activeView === 'activity' && <ScopedActivity scope={{ kind: 'account', address }} tab="activity" />}

              {activeView === 'extrinsics' && <ScopedActivity scope={{ kind: 'account', address }} tab="extrinsics" />}

              {activeView === 'events' && <ScopedActivity scope={{ kind: 'account', address }} tab="events" />}

              {activeView === 'votes' && <VotesTab scope={{ kind: 'account', address }} />}
            </>
          )
        })()}
      {editMounted && (
        <Suspense fallback={null}>
          {/* The page's own data prefills the form — no /user/me round trip to
              race against (a cold me query used to open the dialog blank). */}
          {data && <EditProfileDialog open={editOpen} onOpenChange={setEditOpen} account={data} profile={data.profile ?? null} />}
        </Suspense>
      )}
    </div>
  )
}

// A viewed account's tag lists: the public ones it's an owner/tagged member
// of (every viewer sees these), plus — on the account's own page — every one of
// the owner's OWN lists including their private ones. `ownLists` is the
// superset for anything the viewer owns, so a list owned by the viewed
// account is deduped against it rather than shown twice.
export function ListsSection({ publicLists, ownLists, isOwn }: {
  publicLists: ListSummaryRef[]
  ownLists: ListSummaryRef[]
  isOwn: boolean
}) {
  const seen = new Set(ownLists.map(l => l.listId))
  const rows = isOwn ? [...ownLists, ...publicLists.filter(l => !seen.has(l.listId))] : publicLists
  if (!rows.length && !isOwn) return null
  return (
    <>
      <div className="sec-title">Lists{rows.length > 0 ? ` · ${rows.length}` : ''}</div>
      <div className="panel"><table className="tbl">
        <thead><tr><th>List</th><th className="r">Accounts</th></tr></thead>
        <tbody>
          {!rows.length
            ? <EmptyRow cols={2}>Not listed in any list yet</EmptyRow>
            : rows.map(lib => (
              <tr key={lib.listId} {...rowNav(paths.list(lib.listId))}>
                <td data-label="List">
                  <Link to={paths.list(lib.listId)} className="addr-pill" onClick={e => e.stopPropagation()}>
                    <TagIcon icon="📚" title={lib.name} />
                    <span className="tag">{lib.name}</span>
                  </Link>
                  {lib.visibility === 'private' && <span className="muted" style={{ marginLeft: 8, fontSize: 11 }}>only you can see this</span>}
                </td>
                <td data-label="Accounts" className="r mono">{lib.accountCount}</td>
              </tr>
            ))}
        </tbody>
      </table></div>
      {isOwn && <div className="ext-link-row"><Link to={paths.lists()} className="ext-link">Manage lists →</Link></div>}
    </>
  )
}

// A quiet nudge for a visitor with no session: GET /explorer/address/:address
// /tagged-in (userListService.publicListsTagging) reveals only that a public
// list TAGS this account as a member of one of its tags — never the tag's own
// name or its other members, which stay hidden from a non-owner/non-subscriber
// everywhere else (see listDetailResponse's identical boundary). This is
// deliberately independent of ListsSection above: that section is about
// lists the viewed account itself OWNS and made public, which is a different
// question — an account can own zero public lists while still being tagged
// in someone else's, and that's exactly the case this exists to surface. Logged
// in (owner or not), the affordance disappears — a viewer who already has a
// session either owns the list, already sees the tag through their own
// tag-map, or gets nothing extra from being told "log in" when they're
// already logged in. `session` is passed in (rather than read via
// useSession() here) purely so this stays unit-testable without a real
// session — same DI PublicListsPanel already uses.
export function TaggedInHint({ taggedIn, session }: {
  taggedIn: ListSummaryRef[]
  session: ReturnType<typeof useSession>
}) {
  if (session || !taggedIn.length) return null
  // Deliberately names no list and counts nothing — just that tags exist.
  return (
    <span className="muted lists-login-hint">
      Tags available for this account · <button type="button" className="hint-link" onClick={requestConnect}>login to subscribe</button>
    </span>
  )
}
