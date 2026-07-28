import { useLibraryTag, useLibraryTagListCount, useLibraryTagValueEvents, useMe } from '../hooks/useUser'
import { useSession } from '../session'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { paths, useQueryValue, setQuery, Link } from '../router'
import { Crumbs, F, AddrPill, AccountEmoji, ShortAddr, Copy, ProfilePageSkeleton, DetailTabs, TagIcon, accountHref, rowNav } from '../components/ui'
import { ScopedActivity } from '../components/ScopedActivity'
import { activityListCount, voteListCount } from '../utils/activityPaging'
import { VotesTab } from '../components/VotesTab'
import { moneyMarketDebtUsd, profileTabs, ProfileStats, PortfolioChart, MoneyMarketPositions, ActiveDcaTable, LiquidityPositionsTable } from '../components/AccountSections'
import { BalancesTreemap } from '../components/BalancesTreemap'
import { useTagMapVersion } from '../userTags'
import { useStats } from '../hooks/useExplorerData'
import type { AccountRef } from '../types'

// Provenance affordance: [owner avatar] OwnerName · LibraryName, one pill
// linking to the library's management page (e.g. "🦒 Giraffe · Personal").
// The tag-detail response itself carries no owner field — only a library's
// OWN summary does — so this reads it off the viewer's /user/me data instead,
// which always has an entry for this tag's library: seeing the tag at all
// means the viewer owns or subscribes to it.
function LibraryProvenancePill({ libraryId, libraryName, owner }: { libraryId: string; libraryName: string; owner: AccountRef }) {
  const ownerName = owner.profile?.name || owner.identity?.display || null
  return (
    <Link to={paths.library(libraryId)} className="addr-pill" title={`${ownerName ?? owner.address} · ${libraryName}`}>
      <AccountEmoji account={owner} />
      {ownerName
        ? <span className={`tag${owner.profile?.name ? ' profile-name' : ''}`}>{ownerName}</span>
        : <span className="a mono"><ShortAddr addr={owner.address} /></span>}
      <span className="muted"> · {libraryName}</span>
    </Link>
  )
}

// A library tag's own aggregate view — same structure as the system TagDetail
// page, over a viewer's own (or subscribed) library tag. Unlike a system tag,
// this page has no anonymous form at all: the endpoint is authed and gated by
// ownership/subscription, so a logged-out or unauthorized viewer sees a distinct
// hint rather than the plain "not found" a missing tag id gets.
export function LibraryTagDetail({ libraryId, tagId }: { libraryId: string; tagId: string }) {
  const session = useSession()
  useTagMapVersion()   // re-render if the viewer's own tag map changes (e.g. this tag gets renamed elsewhere)
  const me = useMe()
  const librarySummary = [...(me.data?.libraries ?? []), ...(me.data?.subscriptions ?? [])].find(l => l.libraryId === libraryId)
  const { data, isLoading, isError } = useLibraryTag(libraryId, tagId)
  const activityTotal = useLibraryTagListCount(libraryId, tagId, activityListCount('all', '', {}))
  const votesTotal = useLibraryTagListCount(libraryId, tagId, voteListCount())
  const valueEvents = useLibraryTagValueEvents(libraryId, tagId)
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
          const supplementalDebtUsd = mmList.filter(p => p !== primaryMarket).reduce((s, p) => s + Number(p.totalDebtBase) / 1e8, 0)
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
                    {librarySummary && <> · <LibraryProvenancePill libraryId={libraryId} libraryName={librarySummary.name} owner={librarySummary.owner} /></>}
                  </div>
                </div>
                <ProfileStats tradingVolumeUsd={data.tradingVolumeUsd} liquidationVolumeUsd={data.liquidationVolumeUsd} valueUsd={data.portfolioUsd - debtUsd} valueHint={
                  (primaryDebtUsd > 0 || supplementalDebtUsd > 0) && <div className="hint">
                      {primaryDebtUsd > 0 && <>primary {F.usd(primarySupplyUsd)} lent · −{F.usd(primaryDebtUsd)} borrowed</>}
                      {primaryDebtUsd > 0 && supplementalDebtUsd > 0 && <span aria-hidden="true"> · </span>}
                      {supplementalDebtUsd > 0 && <span className="mm-secondary-debt">GIGAHDX debt −{F.usd(supplementalDebtUsd)}</span>}
                    </div>
                } />
              </div>

              <DetailTabs tabs={tabs} active={activeView} onChange={k => setQuery({ view: k === 'overview' ? null : k })} />

              {activeView === 'overview' && (<>
              <div className="sec-title">Accounts · {members.length}</div>
              <div className="panel"><table className="tbl">
                <thead><tr><th>Account</th></tr></thead>
                <tbody>
                  {members.map(m => (
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
              </table></div>

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

              {activeView === 'activity' && <ScopedActivity scope={{ kind: 'library-tag', libraryId, tagId }} />}

              {activeView === 'votes' && <VotesTab scope={{ kind: 'library-tag', libraryId, tagId }} />}
            </>
          )
        })()}
    </div>
  )
}
