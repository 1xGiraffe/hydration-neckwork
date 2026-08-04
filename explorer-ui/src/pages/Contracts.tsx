import { useContracts } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useNow } from '../hooks/useNow'
import { Crumbs, AddrPill, Ago, Dash, EmptyRow, TableSkeleton, Pager, pendingRows, compactAmount, rowNav } from '../components/ui'
import { paths, usePageParam, useQueryValue, setPage, setQuery } from '../router'
import { offeredPages } from '../utils/activityPaging'
import type { ContractInfo, ContractSort } from '../types'

const PAGE = 50
const SORTS: ContractSort[] = ['created', 'active', 'txs', 'logs']
const COLS = 7
// ≤720px rows become cards; drop the lines this contract has nothing in.
const emptyIf = (empty: boolean) => empty ? ' cell-empty' : ''

// Verification chip — null (Phase 1: everything unverified) renders the same
// neutral dash a column has to line up on. Both match kinds are successes;
// the wording just distinguishes metadata-exact from bytecode-only.
function VerifiedChip({ verified }: { verified: ContractInfo['verified'] }) {
  if (!verified) return <Dash />
  const exact = verified.matchType === 'exact_match'
  return <span className="badge ok" title={exact ? 'Source verified — metadata hash matched exactly' : 'Source verified — bytecode matched, metadata differs'}>✓ {exact ? 'exact' : 'match'}</span>
}

function ContractRow({ c, now }: { c: ContractInfo; now: number }) {
  const creation = c.creation
  return (
    <tr {...rowNav(paths.account(c.address))} className={`clickable${c.destroyed ? ' contract-destroyed' : ''}`}>
      <td data-label="Contract">
        <AddrPill account={c.account} />
        {c.verified?.name && <span className="muted" style={{ marginLeft: 6 }}>{c.verified.name}</span>}
        {c.destroyed && <span className="badge" style={{ color: 'var(--neutral)', background: 'color-mix(in srgb, var(--neutral) 14%, transparent)', marginLeft: 6 }} title="No code at this address anymore (selfdestructed or removed); history stays addressable">destroyed</span>}
      </td>
      <td data-label="Verified" className={c.verified ? undefined : 'cell-empty'}><VerifiedChip verified={c.verified} /></td>
      <td data-label="Deployer" className={emptyIf(creation.method === 'unknown') ? 'cell-empty' : undefined}>
        {creation.method === 'create' && creation.deployer ? <AddrPill account={creation.deployer} />
          : creation.method === 'factory' && creation.factory ? <><AddrPill account={creation.factory} /><span className="muted mono" style={{ fontSize: 11 }} title="Deployed internally by this contract (first-log attribution)">factory</span></>
            : <Dash />}
      </td>
      <td data-label="Created" className={`r${emptyIf(creation.method === 'unknown')}`}>
        {creation.method === 'create' && creation.timestamp ? <Ago ts={creation.timestamp} now={now} />
          : creation.method === 'factory' && creation.timestamp
            ? <span title="Creation not directly observable for factory children — this is its first on-chain log"><span className="muted mono" style={{ fontSize: 11 }}>first seen </span><Ago ts={creation.timestamp} now={now} /></span>
            : <Dash />}
      </td>
      <td data-label="Txs" className="r mono">{c.txCount ? <span className="muted">{compactAmount(c.txCount)}</span> : <Dash />}</td>
      <td data-label="Logs" className={`r mono${emptyIf(!c.logCount)}`}>{c.logCount ? <span className="muted">{compactAmount(c.logCount)}</span> : <Dash />}</td>
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

      <div className="mobile-sort">
        <label htmlFor="contracts-sort">Sort by</label>
        <select id="contracts-sort" value={sort} onChange={e => setQuery({ sort: e.target.value === 'created' ? null : e.target.value, page: null })}>
          <option value="created">Created</option>
          <option value="active">Last active</option>
          <option value="txs">Txs</option>
          <option value="logs">Logs</option>
        </select>
      </div>

      <div className="panel">
        <table className="tbl contracts-tbl">
          <thead><tr>
            <th>Contract</th><th>Verified</th><th>Deployer</th>
            <th className="r">{sTh('created', 'Created')}</th>
            <th className="r">{sTh('txs', 'Txs')}</th>
            <th className="r">{sTh('logs', 'Logs')}</th>
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
