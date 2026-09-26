import { userApi, PUBLIC_LIST_TAG } from '../api/explorer'
import { blockRangeForWindow } from '../utils/chartRefine'
import { useListTag, useListTagActivityCounts, useListTagListCount, useListTagMembers, useListTagValueEvents, useMe, usePublicListTagList } from '../hooks/useUser'
import { useSession } from '../session'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { paths, useQueryValue, setQuery, Link } from '../router'
import { Crumbs, AddrPill, Copy, ProfilePageSkeleton, DetailTabs, TableSkeleton, TagIcon, accountHref, rowNav } from '../components/ui'
import { AccountsTable } from '../components/AccountsTable'
import { NotifyButton } from '../components/NotifyButton'
import { ScopedActivity } from '../components/ScopedActivity'
import { activityListCount, voteListCount } from '../utils/activityPaging'
import { VotesTab } from '../components/VotesTab'
import { RevenueBreakdownTab } from '../components/RevenueBreakdownTab'
import { moneyMarketDebtUsd, profileTabs, resolveProfileView, ProfileStats, PortfolioChart } from '../components/AccountSections'
import { OrdersTab } from '../components/positions/OrdersTab'
import { LiquidityTab } from '../components/positions/LiquidityTab'
import { BorrowTab } from '../components/positions/BorrowTab'
import { tagBorrowAreas } from '../components/positions/borrowAreas'
import { usePositionsPresence } from '../hooks/usePositions'
import { BalancesTreemap } from '../components/BalancesTreemap'
import { useTagMapVersion } from '../userTags'
import { useStats } from '../hooks/useExplorerData'
import type { AccountRef } from '../types'

// Where this tag comes from: just the list's name, linking to the list page —
// deliberately quiet (no owner pill; the list page itself introduces the
// owner), so provenance never competes with the tag's own identity. The owner
// still rides along in the tooltip for anyone who wonders.
// The tag-detail response itself carries no owner field — only a list's
// OWN summary does — so the tooltip's owner comes off the viewer's /user/me
// data instead, which always has an entry for this tag's list: seeing the tag
// at all means the viewer owns or subscribes to it.
function ListProvenanceLink({ listId, listName, owner }: { listId: string; listName: string; owner: AccountRef }) {
  const ownerName = owner.profile?.name || owner.identity?.display || null
  return (
    <Link to={paths.list(listId)} className="muted" title={ownerName ? `${listName} · a list by ${ownerName}` : listName}>{listName}</Link>
  )
}

// A list tag's own aggregate view — same structure as the system TagDetail
// page, over a user list's tag. Reached two ways, which is what `listId` says:
// a real list id means the viewer's own or subscribed tag, read from the authed
// surface; PUBLIC_LIST_TAG means a PUBLIC list's tag reached by a link alone,
// read anonymously and addressed by tag id (see api/explorer.ts). A private
// tag still has no anonymous form, so a logged-out viewer who lands on one sees
// a distinct hint rather than the plain "not found" a missing tag id gets.
export function ListTagDetail({ listId, tagId }: { listId: string; tagId: string }) {
  const session = useSession()
  useTagMapVersion()   // re-render if the viewer's own tag map changes (e.g. this tag gets renamed elsewhere)
  const isPublic = listId === PUBLIC_LIST_TAG
  // The tag-detail response carries no owner field — only a list's own summary
  // does — so provenance comes from the viewer's /user/me for a tag they hold,
  // and from the list the public tag reports belonging to for one they don't.
  const me = useMe()
  const publicList = usePublicListTagList(tagId, isPublic)
  const listSummary = isPublic
    ? publicList.data
    : [...(me.data?.lists ?? []), ...(me.data?.subscriptions ?? [])].find(l => l.listId === listId)
  // Everything addressed BY LIST rather than by tag — the provenance link, a
  // notification rule's target — needs the real id, never the sentinel. The
  // read hooks below keep taking `listId`: the sentinel IS their address.
  const realListId = listSummary?.listId ?? listId
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
  const rawView = useQueryValue('view', 'overview')
  const legacyAtab = useQueryValue('atab', '')
  // Old links nested Extrinsics/Events under ?view=activity&atab=…; both are
  // first-level views now, so those URLs land on the promoted tab.
  const view = rawView === 'activity' && (legacyAtab === 'extrinsics' || legacyAtab === 'events') ? legacyAtab : rawView
  const activityCounts = useListTagActivityCounts(listId, tagId)
  const presence = usePositionsPresence({ kind: 'list-tag', listId, tagId }, !!data)

  if (!session && !isPublic) {
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
          const limitOrders = data.openLimitOrders ?? []
          const liquidityPositions = data.liquidityPositions ?? []
          const portfolioSeries = data.portfolioSeries ?? []
          const balanceHistory = data.balanceHistory ?? []
          // Zoom refinement needs the base points' block heights, aligned 1:1.
          const historyBlocks = data.portfolioBlocks && data.portfolioBlocks.length === portfolioSeries.length ? data.portfolioBlocks : undefined
          const debtUsd = moneyMarketDebtUsd(mmList)
          const borrowAreas = tagBorrowAreas(data.moneyMarketByAccount, mmList)
          const tabs = profileTabs(balances.length, { orders: activeDcas.length + limitOrders.length, liquidity: liquidityPositions.length, borrow: borrowAreas.reduce((n, a) => n + a.markets.length, 0), presence: presence.data, presenceLoading: presence.isLoading, requestedView: view }, activityTotal.data, votesTotal.data?.total ?? undefined, undefined, activityCounts.data?.extrinsics, activityCounts.data?.events, data.revenueUsd)
          const activeView = resolveProfileView(view, tabs)
          return (
            <>
              {/* The account page's bell, over a whole tag: the rule names the
                  LIST tag, so accounts added to it later are watched too. */}
              <div className="ext-link-row">
                <NotifyButton
                  variant="link"
                  label="Get notified"
                  title={`Alert me on activity by anyone tagged ${data.name}`}
                  rule={{ kind: 'account-activity', params: { target: { kind: 'list-tag', listId: realListId, tagId } } }}
                />
              </div>
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
                    {listSummary && <span className="muted"> · <ListProvenanceLink listId={realListId} listName={listSummary.name} owner={listSummary.owner} /></span>}
                  </div>
                </div>
                <ProfileStats tradingVolumeUsd={data.tradingVolumeUsd} liquidationVolumeUsd={data.liquidationVolumeUsd} revenueUsd={data.revenueUsd} valueUsd={data.portfolioUsd - debtUsd} moneyMarket={mmList} farmRewards={data.farmRewards ?? null} moneyMarketRewards={data.moneyMarketRewards ?? null} balances={data.balances} />
              </div>

              <DetailTabs tabs={tabs} active={activeView} onChange={k => setQuery({ view: k === 'overview' ? null : k })} />

              {activeView === 'overview' && (<>
              {/* The same table /accounts renders — a tag is a slice of the
                  directory, so it shows the value, holdings and lending a
                  reader was just looking at. The member pills stand in while
                  the rows load; their names are already known. */}
              <div className="sec-title">Accounts · {members.length}</div>
              {memberRows.data?.rows.length
                ? <AccountsTable rows={memberRows.data.rows} skeletonRows={Math.min(members.length, 12)} memberView />
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

              <PortfolioChart title="Value" netUsd={data.portfolioUsd - debtUsd} series={portfolioSeries} dates={data.portfolioDates} balanceHistory={balanceHistory} valueEvents={valueEvents.data}
                refine={historyBlocks ? async (fromSec, toSec) => {
                  const range = blockRangeForWindow(data.portfolioDates ?? [], historyBlocks, fromSec, toSec)
                  if (!range) return null
                  const w = await userApi.listTagHistoryWindow(listId, tagId, range.fromBlock, range.toBlock)
                  return w.portfolioSeries.length > 1 ? { data: w.portfolioSeries, dates: w.portfolioDates } : null
                } : undefined} />
              </>)}

              {activeView === 'balances' && (
              <BalancesTreemap balances={balances} balanceHistory={balanceHistory}
                refineWindow={(fromBlock, toBlock) => userApi.listTagHistoryWindow(listId, tagId, fromBlock, toBlock)} />
              )}

              {activeView === 'orders' && (
                <OrdersTab scope={{ kind: 'list-tag', listId, tagId }} activeDcas={activeDcas} openLimitOrders={limitOrders} showOwner
                  headBlock={headBlock} headTime={stats?.headTime} now={now} blockSec={stats?.avgBlockSec} />
              )}

              {activeView === 'liquidity' && (
                <LiquidityTab scope={{ kind: 'list-tag', listId, tagId }} positions={liquidityPositions} farmRewards={data.farmRewards ?? null} showOwner />
              )}

              {/* Per member, not summed: liquidation happens per account and
                  DefiSim simulates one account at a time. */}
              {activeView === 'borrow' && <BorrowTab areas={borrowAreas} showOwner />}

              {activeView === 'activity' && <ScopedActivity scope={{ kind: 'list-tag', listId, tagId }} tab="activity" />}

              {activeView === 'extrinsics' && <ScopedActivity scope={{ kind: 'list-tag', listId, tagId }} tab="extrinsics" />}

              {activeView === 'events' && <ScopedActivity scope={{ kind: 'list-tag', listId, tagId }} tab="events" />}

              {activeView === 'votes' && <VotesTab scope={{ kind: 'list-tag', listId, tagId }} />}

              {activeView === 'revenue' && <RevenueBreakdownTab scope={{ kind: 'list-tag', listId, tagId }} />}
            </>
          )
        })()}
    </div>
  )
}
