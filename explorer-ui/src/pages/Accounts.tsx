import { useAccounts, useAccountsDaily } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths, usePageParam, useQueryValue, setPage, setQuery } from '../router'
import { Crumbs, Pager } from '../components/ui'
import { AccountsChart } from '../components/AccountsChart'
import { AccountsSortSelect, AccountsTable, type AccountSortKey } from '../components/AccountsTable'
import { offeredPages } from '../utils/activityPaging'

const PAGE = 50
const SORTS: AccountSortKey[] = ['value', 'health', 'identity', 'supplied', 'borrowed', 'activity', 'volume', 'liquidation', 'revenue']

export function Accounts() {
  useDocumentTitle('Accounts')
  const page = usePageParam()
  const sortParam = useQueryValue('sort', 'value') as AccountSortKey
  const sort = SORTS.includes(sortParam) ? sortParam : 'value'
  // Rows answering the previous page or sort, held while the next loads. The
  // directory rebuild is seconds when cold, so this is the difference between
  // "sorting" and "the sort did nothing" (see pendingRows).
  const { data, isLoading, isPlaceholderData } = useAccounts(page * PAGE, PAGE, sort)
  const { data: daily } = useAccountsDaily()

  // Rows arrive already sorted + paginated server-side (the full set is ~100k
  // accounts, far too large to sort in the browser).
  const rows = data?.rows ?? []
  const total = data?.total ?? 0
  const pages = offeredPages({ page, rowsOnPage: rows.length, rowCount: data ? Math.max(total, 1) : undefined, pageSize: PAGE })
  // Sorting is server-side and lives in the URL, so it survives a reload and a
  // shared link; 'value' is the default and stays out of the query string.
  const onSort = (key: AccountSortKey) => setQuery({ sort: key === 'value' ? null : key, page: null })

  // A viewer's own tags fold server-side, exactly like system tags (see
  // useAccounts): every row here already arrives as one group row with group
  // values, so the shared table renders both the same way.

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
      <AccountsSortSelect id="accounts-sort" sort={sort} onSort={onSort} />

      <AccountsTable rows={rows} loading={isLoading && !data} pending={isPlaceholderData} sort={sort} onSort={onSort} skeletonRows={PAGE}
        footer={<Pager page={page} totalPages={pages.totalPages} hasNext={pages.hasNext} note={pages.note} onPage={setPage} />} />
    </div>
  )
}
