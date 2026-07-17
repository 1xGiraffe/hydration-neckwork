import { useAccounts, useAccountsDaily } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths, usePageParam, useQueryValue, setPage, setQuery } from '../router'
import { Crumbs, F, AddrPill, Sparkline, EmptyRow, TableSkeleton, Pager, healthFactorDisplay, TagGroupPill, TokenIconRow, Dash } from '../components/ui'
import { AccountsChart } from '../components/AccountsChart'
import { defisimAccountTarget } from '../utils/defisim'

type Sort = 'value' | 'health' | 'identity' | 'supplied' | 'borrowed' | 'activity' | 'volume' | 'liquidation'

// Two-sided health badge: color-coded health factor | DefiSim, one link.
export function HealthSimBadge({ hf, addr }: { hf: { label: string; cls: string }; addr: string }) {
  return (
    <a
      className="hf-badge" href={`https://defisim.neckwork.net/?address=${encodeURIComponent(addr)}`} target="_blank" rel="noopener"
      title="Money-market health factor · opens DefiSim" onClick={e => e.stopPropagation()}
    >
      <span className={`hfv ${hf.cls}`}>{hf.label}</span>
      <span className="sim" title="Open in DefiSim">DS ↗</span>
    </a>
  )
}

const PAGE = 50
const SORTS: Sort[] = ['value', 'health', 'identity', 'supplied', 'borrowed', 'activity', 'volume', 'liquidation']
export function Accounts() {
  useDocumentTitle('Accounts')
  const page = usePageParam()
  const sortParam = useQueryValue('sort', 'value') as Sort
  const sort = SORTS.includes(sortParam) ? sortParam : 'value'
  const { data, isLoading } = useAccounts(page * PAGE, PAGE, sort)
  const { data: daily } = useAccountsDaily()

  // Rows arrive already sorted + paginated server-side (the full set is ~100k
  // accounts, far too large to sort in the browser).
  const rows = data?.rows ?? []
  const total = data?.total ?? 0
  const totalPages = data ? Math.max(1, Math.ceil(total / PAGE)) : undefined
  const sTh = (key: Sort, label: string) => (
    <button type="button" className={`th-sort${sort === key ? ' on' : ''}`} onClick={() => setQuery({ sort: key === 'value' ? null : key, page: null })}>{label}{sort === key ? ' ▼' : ''}</button>
  )

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Accounts' }]} />
        <div className="detail-header">
          <div className="page-title">Accounts <span className="sub">{total ? `${total.toLocaleString()} accounts` : ''}</span></div>
          <Link to={paths.tags()} className="ext-link" style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0 }}>🏷️ Tags →</Link>
        </div>
      </div>

      <AccountsChart data={daily ?? []} loading={!daily} />

      {/* Phones hide the sortable column headers (rows become stacked cards),
          so the same server-side sort is exposed as a native select there. */}
      <div className="mobile-sort">
        <label htmlFor="accounts-sort">Sort by</label>
        <select id="accounts-sort" value={sort} onChange={e => setQuery({ sort: e.target.value === 'value' ? null : e.target.value, page: null })}>
          <option value="value">Value</option>
          <option value="identity">Account</option>
          <option value="supplied">Supplied</option>
          <option value="borrowed">Borrowed</option>
          <option value="health">Health</option>
          <option value="liquidation">Liquidation $</option>
          <option value="volume">Trading $</option>
          <option value="activity">Activity</option>
        </select>
      </div>

      <div className="panel">
        <table className="tbl accounts-tbl">
          <thead><tr>
            <th>{sTh('identity', 'Account')}</th>
            <th className="r">{sTh('value', 'Value')}</th><th>Holdings</th><th className="r">1Y</th>
            <th className="r">{sTh('supplied', 'Supplied')}</th><th className="r">{sTh('borrowed', 'Borrowed')}</th>
            <th className="r">{sTh('health', 'Health')}</th>
            <th className="r">{sTh('liquidation', 'Liquidation $')}</th>
            <th className="r">{sTh('volume', 'Trading $')}</th>
            <th className="r">{sTh('activity', 'Activity')}</th>
          </tr></thead>
          <tbody>
            {isLoading && !data ? <TableSkeleton cols={10} /> : !rows.length ? <EmptyRow cols={10}>No accounts</EmptyRow> : rows.map((r, i) => {
              // Badge only for actual borrowers — pure suppliers ('inf') show nothing.
              // Tag rows link DefiSim to the member holding the worst position.
              const hf = r.healthFactor && r.healthFactor !== 'inf' ? healthFactorDisplay(r.healthFactor) : null
              const addr = defisimAccountTarget(r.account, r.simAccount)
              // Module accounts touch balances on every trade — compact the millions.
              const fmtCount = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : F.int(n)
              const count = (n?: number) => n != null ? <span className="mono muted">{fmtCount(n)}</span> : <Dash />
              return (
                <tr key={r.tag ? `tag:${r.tag.tagId}` : r.account ? `account:${r.account.accountId}` : `row:${r.simAccount ?? i}`}>
                  <td data-label="Account">{r.tag ? <TagGroupPill tag={r.tag} /> : r.account ? <AddrPill account={r.account} /> : <Dash />}</td>
                  <td data-label="Value" className="r mono">{F.usd(r.portfolioUsd)}</td>
                  <td data-label="Holdings" className="holdings-cell">{r.topAssets?.length ? <TokenIconRow assets={r.topAssets} /> : <Dash />}</td>
                  <td data-label="1Y" className="r">{r.sparkline && r.sparkline.length > 1 ? <Sparkline data={r.sparkline} /> : <Dash />}</td>
                  <td data-label="Supplied" className="r mono">{r.suppliedUsd ? F.usd(r.suppliedUsd) : <Dash />}</td>
                  <td data-label="Borrowed" className="r mono">{r.borrowedUsd ? F.usd(r.borrowedUsd) : <Dash />}</td>
                  <td data-label="Health" className="r">{hf && addr
                    ? <HealthSimBadge hf={hf} addr={addr} />
                    : hf ? <span className={`hf ${hf.cls}`}>{hf.label}</span> : <Dash />}</td>
                  <td data-label="Liquidation $" className="r mono">{r.liquidationVolumeUsd ? F.usd(r.liquidationVolumeUsd) : <Dash />}</td>
                  <td data-label="Trading $" className="r mono">{r.tradingVolumeUsd ? F.usd(r.tradingVolumeUsd) : <Dash />}</td>
                  <td data-label="Activity" className="r">{count(r.activityCount)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <Pager page={page} totalPages={totalPages} hasNext={data ? page + 1 < (totalPages ?? 1) : true} onPage={setPage} />
      </div>
    </div>
  )
}
