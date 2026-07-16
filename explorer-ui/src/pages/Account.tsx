import { useEffect } from 'react'
import { useAddress, useAddressHistory, useAccountActivityCounts, useStats } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths, redirect, useQueryValue, setQuery } from '../router'
import { Crumbs, F, Copy, ShortAddr, ProfilePageSkeleton, DetailTabs, moduleName, emojiName, TagIcon, showIconFallback as avatarImgFallback } from '../components/ui'
import { PortfolioChart, ProfileStats, MoneyMarketPositions, moneyMarketDebtUsd, profileTabs, ActiveDcaTable, LiquidityPositionsTable, BalanceHistorySection, ProxyMultisigSection } from '../components/AccountSections'
import { BalancesTreemap } from '../components/BalancesTreemap'
import { CloseAccountsSection } from '../components/CloseAccountsSection'
import { ScopedActivity } from '../components/ScopedActivity'

export function Account({ address }: { address: string }) {
  const { data, isLoading, isError } = useAddress(address)
  const now = useNow()
  const { data: stats } = useStats(!!data?.activeDcas?.length)
  const canonicalAddress = data ? (data.evmAddress ?? data.ss58Polkadot) : null
  const history = useAddressHistory(canonicalAddress)
  const counts = useAccountActivityCounts(canonicalAddress)
  const headBlock = stats?.headBlock ?? 0
  const view = useQueryValue('view', 'overview')

  // Document title mirrors the header's display-name logic: best-known name
  // (tag > identity > module > emoji name) plus the short canonical address.
  const shortAddr = data ? F.shortAddr(data.evmAddress ?? data.ss58Polkadot) : null
  const acctName = data ? (data.tag?.name ?? data.identity?.display ?? moduleName(data.accountId) ?? data.emojiName ?? emojiName(data.emoji)) : null
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
          const mmList = data.moneyMarket
          const explicitEvmBinding = data.aliases.find(alias => alias.relationship === 'explicit_binding' && alias.evmAddress)?.evmAddress
          // Debt counts from every market and is netted out of the portfolio Value.
          const debtUsd = moneyMarketDebtUsd(mmList)
          const tabs = profileTabs(data.balances.length, mmList, data.activeDcas?.length ?? 0, data.liquidityPositions?.length ?? 0, counts.data?.activity)
          const activeView = tabs.some(t => t.key === view) ? view : 'overview'
          return (
            <>
              <div className="acct-head">
                <div className="acct-avatar">{data.tag ? <TagIcon icon={data.tag.icon} color={data.tag.color} size={28} title={data.tag.name} /> : mod ? '⚙️' : data.emojiUrl
                  ? <><img className="acct-avatar-img" src={data.emojiUrl} alt={data.emojiName ?? data.emoji} title={data.emojiName} onError={avatarImgFallback} /><span className="icon-fallback" style={{ display: 'none' }}>{data.emoji}</span></>
                  : data.emoji}</div>
                <div className="acct-meta">
                  <div className="tag">{data.tag
                    ? <span>{data.tag.name} <span className="em" style={{ color: data.tag.color }}>· tag</span></span>
                    : data.identity?.display
                      ? <span style={{ fontSize: 18 }}>{data.identity.display}{data.identity.verified && <span className="id-verified" title="Verified identity" style={{ marginLeft: 5 }}>✓</span>}</span>
                      : <span style={{ fontSize: 18 }}>{mod ? mod : (emojiName(data.emoji) ?? 'Account')}</span>}
                    {data.proxy?.isPure && <span className="badge" title="Keyless pure-proxy account — controlled only through its proxies" style={{ color: 'var(--sky)', background: 'color-mix(in srgb, var(--sky) 14%, transparent)' }}>pure proxy</span>}
                    {data.multisig && <span className="badge" title={`Multisig account — any ${data.multisig.threshold} of ${data.multisig.signatories.length} signatories can act`} style={{ color: 'var(--sky)', background: 'color-mix(in srgb, var(--sky) 14%, transparent)' }}>{data.multisig.threshold}/{data.multisig.signatories.length} multisig</span>}</div>
                  {/* No EVM badge here: the 0x prefix already says it (and the
                      identities card shows "EVM (H160)") — the badge forced the
                      address to wrap mid-token on phones. */}
                  <div className="full">
                    <span className="mono"><ShortAddr addr={data.evmAddress ?? data.ss58Polkadot} full /></span> <Copy text={data.evmAddress ?? data.ss58Polkadot} />
                  </div>
                  {data.tag && (
                    <div className="row gap6" style={{ marginTop: 2 }}>
                      <Link to={paths.tag(data.tag.id)} style={{ fontFamily: 'GeistMono', fontSize: 11, color: data.tag.color }}>Part of tag “{data.tag.name}” · this page shows this account only</Link>
                    </div>
                  )}
                </div>
                <ProfileStats tradingVolumeUsd={data.tradingVolumeUsd} liquidationVolumeUsd={data.liquidationVolumeUsd} valueUsd={data.portfolioUsd - debtUsd} />
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

              <ProxyMultisigSection proxy={data.proxy} multisig={data.multisig} memberships={data.multisigMemberships} />

              <CloseAccountsSection address={canonicalAddress ?? address} />

              <PortfolioChart title="Value" netUsd={data.portfolioUsd - debtUsd} series={history.data?.portfolioSeries ?? data.portfolioSeries ?? []} dates={history.data?.portfolioDates ?? data.portfolioDates} balanceHistory={history.data?.balanceHistory ?? data.balanceHistory} loading={history.isLoading || (history.isFetching && !history.data)} />
              </>)}

              {activeView === 'balances' && (<>
              <BalancesTreemap balances={data.balances} />
              <BalanceHistorySection history={history.data?.balanceHistory ?? data.balanceHistory} />
              </>)}

              {activeView === 'positions' && (<>
              <MoneyMarketPositions markets={mmList} defisimAddress={data.evmAddress ?? explicitEvmBinding ?? data.accountId} />
              {data.activeDcas && <ActiveDcaTable dcas={data.activeDcas} headBlock={headBlock} headTime={stats?.headTime} now={now} />}
              {data.liquidityPositions && <LiquidityPositionsTable positions={data.liquidityPositions} />}
              </>)}

              {activeView === 'activity' && <ScopedActivity scope={{ kind: 'account', address }} />}
            </>
          )
        })()}
    </div>
  )
}
