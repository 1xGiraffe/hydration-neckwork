import { useTags } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths } from '../router'
import { Crumbs, EmptyRow, TableSkeleton, TagIcon, rowNav } from '../components/ui'

// Read-only directory of the predefined account tags. Tags are curated in the
// backend (account_tags) — there is intentionally no in-app create/edit/delete.
export function Tags() {
  useDocumentTitle('Tags')
  const { data, isLoading } = useTags()
  const tags = data ?? []

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Accounts', to: paths.accounts() }, { label: 'Tags' }]} />
        <div className="page-title">Account tags <span className="sub">{tags.length} tags</span></div>
      </div>

      <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 12, marginBottom: 16 }}>
        Tags pool several addresses under one identity (e.g. an exchange's wallets). They are combined into a single row across
        Accounts and Holders, while each member keeps its own account page.
      </div>

      <div className="panel">
        <table className="tbl">
          <thead><tr><th>Tag</th><th className="r">Accounts</th></tr></thead>
          <tbody>
            {isLoading && !data ? <TableSkeleton cols={2} rows={6} /> : !tags.length ? <EmptyRow cols={2}>No tags</EmptyRow> : tags.map(g => (
              <tr key={g.tagId} {...rowNav(paths.tag(g.tagId))}>
                <td data-label="Tag">
                  <Link to={paths.tag(g.tagId)} className="addr-pill" onClick={e => e.stopPropagation()}>
                    <TagIcon icon={g.icon} color={g.color} title={g.name} />
                    <span className="tag" style={{ color: g.color }}>{g.name}</span>
                  </Link>
                </td>
                <td data-label="Accounts" className="r mono">{g.members.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
