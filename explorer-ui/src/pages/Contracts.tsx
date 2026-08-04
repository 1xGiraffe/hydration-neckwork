import { useContracts } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useNow } from '../hooks/useNow'
import { Crumbs, F, AddrPill, Ago, Dash, EmptyRow, Sparkline, TableSkeleton, TokenIconRow, Pager, pendingRows, compactAmount, rowNav } from '../components/ui'
import { paths, usePageParam, useQueryValue, setPage, setQuery } from '../router'
import { offeredPages } from '../utils/activityPaging'
import type { ContractInfo, ContractSort } from '../types'

const PAGE = 50
const SORTS: ContractSort[] = ['created', 'active', 'txs', 'logs', 'value', 'volume', 'activity', 'name']
const COLS = 11
// ≤720px rows become cards; drop the lines this contract has nothing in.
const emptyIf = (empty: boolean) => empty ? ' cell-empty' : ''

// A contract IS an account, so the directory carries the same holdings columns
// /accounts does — from the same models, so the two can never disagree. Most
// contracts hold nothing and show dashes; the token contracts, vaults and pool
// proxies that do are exactly the rows worth finding this way.
function ContractRow({ c, now }: { c: ContractInfo; now: number }) {
  const creation = c.creation
  const exact = c.verified?.matchType === 'exact_match'
  return (
    <tr {...rowNav(paths.account(c.address))} className={`clickable${c.destroyed ? ' contract-destroyed' : ''}`}>
      {/* noTag, like every other member list: the page context already says these
          are contracts, so the row has to identify WHICH one. Without it the
          money-market reserve contracts — which hold the most value, so they lead
          the default value sort — all render as their shared "Lend & Borrow" tag
          pill and become indistinguishable. Their tag is one click away.
          The pill itself now carries the verified contract name (AccountRef
          .contractName, so it reads the same on every surface), which is why
          there is no separate name span here. Verification rides beside it as a
          single check with the match kind in its tooltip: a column of "✓ EXACT"
          chips cost 88px and told no more, and eleven columns are what fit a
          1440px window without the panel scrolling. */}
      <td data-label="Contract">
        <span className="cell-inline">
          <AddrPill account={c.account} noTag />
          {c.verified && <span className="ok-check" title={exact ? 'Source verified — metadata hash matched exactly' : 'Source verified — bytecode matched, metadata differs'} aria-label={exact ? 'Verified, exact match' : 'Verified, bytecode match'}>✓</span>}
          {c.destroyed && <span className="badge" style={{ color: 'var(--neutral)', background: 'color-mix(in srgb, var(--neutral) 14%, transparent)' }} title="No code at this address anymore (selfdestructed or removed); history stays addressable">destroyed</span>}
        </span>
      </td>
      <td data-label="Deployer" className={emptyIf(creation.method === 'unknown') ? 'cell-empty' : undefined}>
        <span className="cell-inline">
          {creation.method === 'create' && creation.deployer ? <AddrPill account={creation.deployer} noCopy />
            : creation.method === 'factory' && creation.factory ? <><AddrPill account={creation.factory} noTag noCopy /><span className="muted mono" style={{ fontSize: 11 }} title="Deployed internally by this contract (first-log attribution)">factory</span></>
              : <Dash />}
        </span>
      </td>
      <td data-label="Value" className={`r mono${emptyIf(!c.portfolioUsd)}`}>{c.portfolioUsd ? F.usd(c.portfolioUsd) : <Dash />}</td>
      <td data-label="Holdings" className={`holdings-cell${emptyIf(!c.topAssets?.length)}`}>{c.topAssets?.length ? <TokenIconRow assets={c.topAssets} /> : <Dash />}</td>
      <td data-label="1Y" className={`r${emptyIf(!(c.sparkline && c.sparkline.length > 1))}`}>{c.sparkline && c.sparkline.length > 1 ? <Sparkline data={c.sparkline} w={88} /> : <Dash />}</td>
      <td data-label="Trading $" className={`r mono${emptyIf(!c.tradingVolumeUsd)}`}>{c.tradingVolumeUsd ? F.usd(c.tradingVolumeUsd) : <Dash />}</td>
      {/* A partial total is a floor: the feed runs deeper than it could be
          counted, so it reads as "at least this" instead of as exact. */}
      <td data-label="Activity" className={`r mono${emptyIf(c.activityCount == null)}`}>
        {c.activityCount != null ? <><span className="muted">{compactAmount(c.activityCount)}</span>{c.activityCountComplete === false ? '+' : ''}</> : <Dash />}
      </td>
      <td data-label="Txs" className={`r mono${emptyIf(!c.txCount)}`}>{c.txCount ? <span className="muted">{compactAmount(c.txCount)}</span> : <Dash />}</td>
      <td data-label="Logs" className={`r mono${emptyIf(!c.logCount)}`}>{c.logCount ? <span className="muted">{compactAmount(c.logCount)}</span> : <Dash />}</td>
      <td data-label="Created" className={`r${emptyIf(creation.method === 'unknown')}`}>
        {creation.method === 'create' && creation.timestamp ? <Ago ts={creation.timestamp} now={now} />
          : creation.method === 'factory' && creation.timestamp
            ? <span title="Creation not directly observable for factory children — this is its first on-chain log"><span className="muted mono" style={{ fontSize: 11 }}>first seen </span><Ago ts={creation.timestamp} now={now} /></span>
            : <Dash />}
      </td>
      <td data-label="Last active" className={`r${emptyIf(!c.lastActivity)}`}>{c.lastActivity ? <Ago ts={c.lastActivity} now={now} /> : <Dash />}</td>
    </tr>
  )
}

export function Contracts() {
  useDocumentTitle('Contracts')
  const now = useNow()
  const page = usePageParam()
  const sortParam = useQueryValue('sort', 'created') as ContractSort
  const sort = SORTS.includes(sortParam) ? sortParam : 'created'
  const { data, isLoading, isPlaceholderData } = useContracts(page * PAGE, PAGE, sort)

  const rows = data?.contracts ?? []
  const total = data?.total ?? 0
  const pages = offeredPages({ page, rowsOnPage: rows.length, rowCount: data ? Math.max(total, 1) : undefined, pageSize: PAGE })
  const sTh = (key: ContractSort, label: string) => (
    <button type="button" className={`th-sort${sort === key ? ' on' : ''}`} onClick={() => setQuery({ sort: key === 'created' ? null : key, page: null })}>{label}{sort === key ? ' ▼' : ''}</button>
  )

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Contracts' }]} />
        <div className="detail-header">
          <div className="page-title">Contracts <span className="sub">{total ? `${total.toLocaleString()} contracts` : ''}</span></div>
        </div>
      </div>

      {/* Phones hide the sortable column headers (rows become stacked cards),
          so the same server-side sort is exposed as a native select there. */}
      <div className="mobile-sort">
        <label htmlFor="contracts-sort">Sort by</label>
        <select id="contracts-sort" value={sort} onChange={e => setQuery({ sort: e.target.value === 'created' ? null : e.target.value, page: null })}>
          <option value="created">Created</option>
          <option value="name">Contract</option>
          <option value="active">Last active</option>
          <option value="value">Value</option>
          <option value="volume">Trading $</option>
          <option value="activity">Activity</option>
          <option value="txs">Txs</option>
          <option value="logs">Logs</option>
        </select>
      </div>

      <div className="panel">
        <table className="tbl contracts-tbl">
          <thead><tr>
            <th>{sTh('name', 'Contract')}</th><th>Deployer</th>
            <th className="r">{sTh('value', 'Value')}</th>
            <th>Holdings</th><th className="r">1Y</th>
            <th className="r">{sTh('volume', 'Trading $')}</th>
            <th className="r">{sTh('activity', 'Activity')}</th>
            <th className="r">{sTh('txs', 'Txs')}</th>
            <th className="r">{sTh('logs', 'Logs')}</th>
            <th className="r">{sTh('created', 'Created')}</th>
            <th className="r">{sTh('active', 'Last active')}</th>
          </tr></thead>
          <tbody {...pendingRows(isPlaceholderData)}>
            {isLoading && !data ? <TableSkeleton cols={COLS} mobileCols={5} rows={PAGE} /> : !rows.length ? <EmptyRow cols={COLS}>No contracts</EmptyRow> : rows.map(c => <ContractRow key={c.address} c={c} now={now} />)}
          </tbody>
        </table>
        <Pager page={page} totalPages={pages.totalPages} hasNext={pages.hasNext} note={pages.note} onPage={setPage} />
      </div>
    </div>
  )
}
