import { useListTag, useListTagListCount, useListTagMembers, useListTagValueEvents, useMe } from '../hooks/useUser'
import { useSession } from '../session'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { paths, useQueryValue, setQuery, Link } from '../router'
import { Crumbs, F, AddrPill, Copy, ProfilePageSkeleton, DetailTabs, TableSkeleton, TagIcon, accountHref, rowNav } from '../components/ui'
import { AccountsTable } from '../components/AccountsTable'
import { ScopedActivity } from '../components/ScopedActivity'
import { activityListCount, voteListCount } from '../utils/activityPaging'
import { VotesTab } from '../components/VotesTab'
import { moneyMarketDebtUsd, profileTabs, ProfileStats, PortfolioChart, MoneyMarketPositions, ActiveDcaTable, LiquidityPositionsTable } from '../components/AccountSections'
import { BalancesTreemap } from '../components/BalancesTreemap'
import { useTagMapVersion } from '../userTags'
import { useStats } from '../hooks/useExplorerData'
import type { AccountRef } from '../types'

// Provenance affordance: [owner avatar] OwnerName · ListName, one pill
// linking to the list's management page (e.g. "🦒 Giraffe · Personal").
// The tag-detail response itself carries no owner field — only a list's
// OWN summary does — so this reads it off the viewer's /user/me data instead,
// which always has an entry for this tag's list: seeing the tag at all
// means the viewer owns or subscribes to it.
// Where this tag comes from: just the list's name, linking to the list page —
// deliberately quiet (no owner pill; the list page itself introduces the
// owner), so provenance never competes with the tag's own identity. The owner
// still rides along in the tooltip for anyone who wonders.
function ListProvenanceLink({ listId, listName, owner }: { listId: string; listName: string; owner: AccountRef }) {
  const ownerName = owner.profile?.name || owner.identity?.display || null
  return (
    <Link to={paths.list(listId)} className="muted" title={ownerName ? `${listName} · a list by ${ownerName}` : listName}>{listName}</Link>
  )
}

// A list tag's own aggregate view — same structure as the system TagDetail
// page, over a viewer's own (or subscribed) list tag. Unlike a system tag,
// this page has no anonymous form at all: the endpoint is authed and gated by
// ownership/subscription, so a logged-out or unauthorized viewer sees a distinct
// hint rather than the plain "not found" a missing tag id gets.
export function ListTagDetail({ listId, tagId }: { listId: string; tagId: string }) {
  const session = useSession()
  useTagMapVersion()   // re-render if the viewer's own tag map changes (e.g. this tag gets renamed elsewhere)
  const me = useMe()
  const listSummary = [...(me.data?.lists ?? []), ...(me.data?.subscriptions ?? [])].find(l => l.listId === listId)
  const { data, isLoading, isError } = useListTag(listId, tagId)
  // The members as directory rows, requested alongside rather than inside the
  // tag's own payload so neither waits on the other.
  const memberRows = useListTagMembers(listId, tagId)
  const activityTotal = useListTagListCount(listId, tagId, activityListCount('all', '', {}))
  const votesTotal = useListTagListCount(listId, tagId, voteListCount())
  const valueEvents = useListTagValueEvents(listId, tagId)
  useDocumentTitle(data?.name)
  const now = useNow()
  const { data: stats } = useStats(!!data?.activeDcas?.length)
  const headBlock = stats?.headBlock ?? 0
  const view = useQueryValue('view', 'overview')

  if (!session) {
    return (
      <div className="wrap">
        <div className="page-head"><Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Tag' }]} /></div>
        <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Log in to view this tag.</div>
      </div>
    )
  }

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Tags', to: paths.tags() }, { label: data?.name ?? tagId }]} />
      </div>

      {isError ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Tag not found</div>
        : isLoading || !data ? <ProfilePageSkeleton /> : (() => {
          const members = data.members ?? []
          const balances = data.balances ?? []
          const mmList = data.moneyMarket ?? []
          const activeDcas = data.activeDcas ?? []
          const liquidityPositions = data.liquidityPositions ?? []
          const portfolioSeries = data.portfolioSeries ?? []
          const balanceHistory = data.balanceHistory ?? []
          const debtUsd = moneyMarketDebtUsd(mmList)
          const primaryMarket = mmList.find(p => p.role === 'primary') ?? mmList.find(p => p.marketKey === 'core')
          const primarySupplyUsd = Number(primaryMarket?.totalSuppliedBase ?? primaryMarket?.totalCollateralBase ?? 0) / 1e8
          const primaryDebtUsd = Number(primaryMarket?.totalDebtBase ?? 0) / 1e8
          // One entry per supplemental market that actually carries debt, so the
          // hint names each market (GIGAHDX, BIL, …) instead of one blended figure.
          const supplementalDebts = mmList
            .filter(p => p !== primaryMarket && Number(p.totalDebtBase) > 0)
            .map(p => ({ key: p.marketKey, label: p.market, usd: Number(p.totalDebtBase) / 1e8 }))
          const tabs = profileTabs(balances.length, mmList, activeDcas.length, liquidityPositions.length, activityTotal.data, votesTotal.data?.total ?? undefined)
          const activeView = tabs.some(t => t.key === view) ? view : 'overview'
          return (
            <>
              <div className="acct-head">
                <div className="acct-avatar"><TagIcon icon={data.icon} title={data.name} className="acct-avatar-icon" /></div>
                <div className="acct-meta">
                  <div className="tag">{data.name} <span className="em" style={{ color: data.color }}>· tag</span></div>
                  {/* `.full` is shared with the address page's break-all address line;
                      this page's content is prose (account count + the provenance
                      pill), so it opts out of that per-character wrap and wraps at
                      word boundaries instead — otherwise "accounts" mangles mid-word
                      on a narrow viewport once both no longer fit on one line. */}
                  <div className="full" style={{ wordBreak: 'normal', flexWrap: 'wrap' }}>
                    <span className="muted">{members.length} accounts</span>
                    {listSummary && <span className="muted"> · <ListProvenanceLink listId={listId} listName={listSummary.name} owner={listSummary.owner} /></span>}
                  </div>
                </div>
                <ProfileStats tradingVolumeUsd={data.tradingVolumeUsd} liquidationVolumeUsd={data.liquidationVolumeUsd} valueUsd={data.portfolioUsd - debtUsd} valueHint={
                  (primaryDebtUsd > 0 || supplementalDebts.length > 0) && <div className="hint">
                      {primaryDebtUsd > 0 && <>primary {F.usd(primarySupplyUsd)} lent · −{F.usd(primaryDebtUsd)} borrowed</>}
                      {supplementalDebts.map((m, i) => <span key={m.key}>{(primaryDebtUsd > 0 || i > 0) && <span aria-hidden="true"> · </span>}<span className="mm-secondary-debt">{m.label} debt −{F.usd(m.usd)}</span></span>)}
                    </div>
                } />
              </div>

              <DetailTabs tabs={tabs} active={activeView} onChange={k => setQuery({ view: k === 'overview' ? null : k })} />

              {activeView === 'overview' && (<>
              {/* The same table /accounts renders — a tag is a slice of the
                  directory, so it shows the value, holdings and lending a
                  reader was just looking at. The member pills stand in while
                  the rows load; their names are already known. */}
              <div className="sec-title">Accounts · {members.length}</div>
              {memberRows.data?.rows.length
                ? <AccountsTable rows={memberRows.data.rows} skeletonRows={Math.min(members.length, 12)} />
                : <div className="panel"><table className="tbl">
                  <thead><tr><th>Account</th></tr></thead>
                  <tbody>
                    {memberRows.isLoading
                      ? <TableSkeleton cols={1} rows={Math.min(members.length, 8)} />
                      : members.map(m => (
                        <tr key={m.accountId} {...rowNav(accountHref(m))}>
                          <td>
                            <span className="row gap6" style={{ alignItems: 'center' }}>
                              <AddrPill account={m} noCopy noTag />
                              <Copy text={m.address} />
                            </span>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table></div>}

              <PortfolioChart title="Value" netUsd={data.portfolioUsd - debtUsd} series={portfolioSeries} dates={data.portfolioDates} balanceHistory={balanceHistory} valueEvents={valueEvents.data} />
              </>)}

              {activeView === 'balances' && (
              <BalancesTreemap balances={balances} balanceHistory={balanceHistory} />
              )}

              {activeView === 'positions' && (<>
              <MoneyMarketPositions markets={mmList} />
              {activeDcas.length > 0 && <ActiveDcaTable dcas={activeDcas} headBlock={headBlock} headTime={stats?.headTime} now={now} blockSec={stats?.avgBlockSec} />}
              {liquidityPositions.length > 0 && <LiquidityPositionsTable positions={liquidityPositions} />}
              </>)}

              {activeView === 'activity' && <ScopedActivity scope={{ kind: 'list-tag', listId, tagId }} />}

              {activeView === 'votes' && <VotesTab scope={{ kind: 'list-tag', listId, tagId }} />}
            </>
          )
        })()}
    </div>
  )
}
