import { lazy, Suspense, useState } from 'react'
import { userApi } from '../api/explorer'
import { useMe, useUserMutation } from '../hooks/useUser'
import { useTags } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, navigate, paths } from '../router'
import { Crumbs } from '../components/ui'
import type { ListSummaryRef, MeResponse } from '../types'

const ListFormDialog = lazy(() => import('../components/ListFormDialog').then(m => ({ default: m.ListFormDialog })))

// Always public/private — `isPersonal` (auto-created, not deletable) is a
// backend/ownership fact, not a visibility state; a "personal" chip read as
// if the list were neither public nor private even once a viewer made it
// public. (Duplicated in ListDetail.tsx rather than shared — see the
// comment there.)
function visibilityChip(lib: Pick<ListSummaryRef, 'visibility'>) {
  const [label, color] = lib.visibility === 'public' ? ['public', 'var(--sky)'] : ['private', 'var(--neutral)']
  return <span className="badge" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>{label}</span>
}

// One reorderable row in "Your lists": either a real list (owned or
// subscribed) or the fixed slot standing in for the built-in Hydration tag
// directory — it participates in the same priority order but is not a
// ListSummaryRef, so it gets its own case everywhere a row is drawn.
type Row = { id: 'system'; kind: 'system' } | { id: string; kind: 'list'; lib: ListSummaryRef; owned: boolean }

// `me.order` names every slot (every owned/subscribed list plus 'system')
// in priority order — walk it to build the rows, then append anything it
// missed (a fresh subscription the order hasn't caught up with yet) so a row
// is never silently dropped.
function orderedRows(me: MeResponse): Row[] {
  const byId = new Map<string, Row>()
  for (const lib of me.lists) byId.set(lib.listId, { id: lib.listId, kind: 'list', lib, owned: true })
  for (const lib of me.subscriptions) if (!byId.has(lib.listId)) byId.set(lib.listId, { id: lib.listId, kind: 'list', lib, owned: false })
  byId.set('system', { id: 'system', kind: 'system' })
  const rows: Row[] = []
  const seen = new Set<string>()
  for (const id of me.order) {
    const row = byId.get(id)
    if (row && !seen.has(id)) { rows.push(row); seen.add(id) }
  }
  for (const [id, row] of byId) if (!seen.has(id)) rows.push(row)
  return rows
}

function swapNeighbor(order: string[], id: string, dir: -1 | 1): string[] {
  const i = order.indexOf(id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= order.length) return order
  const next = [...order]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

function YourLists({ me }: { me: MeResponse }) {
  const orderMutation = useUserMutation(userApi.setOrder)
  // The fixed system row has no ListSummaryRef of its own — its counts come
  // from the same built-in tag list /tags/hydration itself renders. System
  // tags are one-tag-per-account, so summing memberCount is an exact account
  // count, not an approximation. Undefined (still loading) falls through to
  // the em-dash placeholder every other row's loading state would use too.
  const { data: systemTags } = useTags()
  const systemTagCount = systemTags?.length
  const systemAccountCount = systemTags?.reduce((sum, t) => sum + t.memberCount, 0)
  const rows = orderedRows(me)
  const move = (id: string, dir: -1 | 1) => orderMutation.mutate([swapNeighbor(me.order, id, dir)])

  return (
    <>
      <div className="sec-title">Your lists</div>
      <div className="panel"><table className="tbl">
        <thead><tr><th>List</th><th className="r">Tags</th><th className="r">Accounts</th><th className="r">Order</th></tr></thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id}>
              <td data-label="List">
                {row.kind === 'system' ? (
                  <Link to={paths.tagsHydration()} className="addr-pill">
                    <span className="tag">Hydration tags</span>
                  </Link>
                ) : (
                  <>
                    <Link to={paths.list(row.lib.listId)} className="addr-pill">
                      <span className="tag">{row.lib.name}</span>
                    </Link>{' '}
                    {visibilityChip(row.lib)}
                    {!row.owned && <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>subscribed</span>}
                  </>
                )}
              </td>
              <td data-label="Tags" className="r mono">{row.kind === 'list' ? row.lib.tagCount : systemTagCount ?? '—'}</td>
              <td data-label="Accounts" className="r mono">{row.kind === 'list' ? row.lib.accountCount : systemAccountCount ?? '—'}</td>
              <td data-label="Order" className="r">
                <button type="button" className="btn sm" aria-label="Move up" disabled={i === 0 || orderMutation.isPending} onClick={() => move(row.id, -1)}>▲</button>{' '}
                <button type="button" className="btn sm" aria-label="Move down" disabled={i === rows.length - 1 || orderMutation.isPending} onClick={() => move(row.id, 1)}>▼</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 11, marginBottom: 16 }}>Higher lists win when an account is tagged in several.</div>
    </>
  )
}

export function Lists() {
  useDocumentTitle('Lists')
  const me = useMe()
  const createMutation = useUserMutation(userApi.createList)

  const [newLibOpen, setNewLibOpen] = useState(false)
  const [newLibMounted, setNewLibMounted] = useState(false)
  const openNewLib = () => { setNewLibMounted(true); setNewLibOpen(true) }

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Lists' }]} />
        <div className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          Lists
          {me.data && <button type="button" className="btn primary" style={{ marginLeft: 'auto' }} onClick={openNewLib}>+ New list</button>}
        </div>
      </div>

      <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 12, marginBottom: 16 }}>
        Manage the tag lists you own or follow — reorder them, control who can see them, and create new ones. Discover and
        subscribe to public lists, and answer invites, from the <Link to={paths.tags()}>Tags</Link> hub instead.
      </div>

      {me.data ? <YourLists me={me.data} /> : !me.isLoading && (
        <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Log in to manage your lists.</div>
      )}

      {newLibMounted && (
        <Suspense fallback={null}>
          <ListFormDialog
            open={newLibOpen}
            onOpenChange={setNewLibOpen}
            title="New list"
            hint="A named collection of tags for organizing accounts you follow."
            submitLabel="Create"
            pending={createMutation.isPending}
            onSubmit={async values => {
              const lib = await createMutation.mutateAsync([{ name: values.name, note: values.note || undefined, visibility: values.visibility }])
              setNewLibOpen(false)
              navigate(paths.list(lib.listId))
            }}
          />
        </Suspense>
      )}
    </div>
  )
}
