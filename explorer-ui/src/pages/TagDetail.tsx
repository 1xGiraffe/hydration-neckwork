import { useTag, useTagListCount, useTagValueEvents, useStats } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { paths, useQueryValue, setQuery } from '../router'
import { Crumbs, F, AddrPill, Copy, ProfilePageSkeleton, DetailTabs, TagIcon, accountHref, rowNav } from '../components/ui'
import { CloseAccountsSection } from '../components/CloseAccountsSection'
import { ScopedActivity } from '../components/ScopedActivity'
import { activityListCount, voteListCount } from '../utils/activityPaging'
import { VotesTab } from '../components/VotesTab'
import { moneyMarketDebtUsd, profileTabs, ProfileStats, PortfolioChart, MoneyMarketPositions, ActiveDcaTable, LiquidityPositionsTable } from '../components/AccountSections'
import { BalancesTreemap } from '../components/BalancesTreemap'
import { libraryForTag, useTagMapVersion } from '../userTags'
import { LibraryTagDetail } from './LibraryTagDetail'

// A user tag's aggregate view shares this same /tag/:id URL as a system tag —
// this wrapper decides which one a given id means. System tag slugs are short,
// code-defined words ('kraken', 'treasury', …); user-tag ids are UUIDs minted
// by userLibraryService, so the two id spaces never collide — checking the
// viewer's own tag-map first (instant, client-side, no request) can only ever
// match a real user tag, never accidentally shadow a system one. Logged out,
// or for a tag outside the viewer's own libraries/subscriptions, the map has
// no entry and this falls through to the system view, which 404s on a
// user-tag id exactly like it always did on any other unknown id.
export function TagDetail({ tagId }: { tagId: string }) {
  useTagMapVersion()   // re-render once the viewer's tag map loads/changes
  const lib = libraryForTag(tagId)
  if (lib) return <LibraryTagDetail libraryId={lib.libraryId} tagId={tagId} />
  return <SystemTagDetail tagId={tagId} />
}

function SystemTagDetail({ tagId }: { tagId: string }) {
  const { data, isLoading, isError } = useTag(tagId)
  // Exact list lengths for the tab badges, shared with the lists' own totals.
  const activityTotal = useTagListCount(tagId, activityListCount('all', '', {}))
  const votesTotal = useTagListCount(tagId, voteListCount())
  const valueEvents = useTagValueEvents(tagId)
  useDocumentTitle(data?.name)
  const now = useNow()
  const { data: stats } = useStats(!!data?.activeDcas?.length)
  const headBlock = stats?.headBlock ?? 0
  const view = useQueryValue('view', 'overview')

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
                  <div className="full"><span className="muted">{members.length} accounts</span></div>
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

              <CloseAccountsSection tagId={tagId} />

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

              {activeView === 'activity' && <ScopedActivity scope={{ kind: 'tag', tagId }} />}

              {activeView === 'votes' && <VotesTab scope={{ kind: 'tag', tagId }} />}
            </>
          )
        })()}
    </div>
  )
}
