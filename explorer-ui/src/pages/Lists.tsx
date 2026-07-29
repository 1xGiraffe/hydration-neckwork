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

// The handle's own accessible name — same row label a screen reader would
// already be reading from the List cell, so "Reorder <name>" identifies
// WHICH row's handle this is without repeating the whole cell's markup.
function rowLabel(row: Row): string {
  return row.kind === 'system' ? 'Hydration tags' : row.lib.name
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

  // `orderedRows` already resolves EVERY slot — every owned/subscribed list
  // plus 'system' — into a full, gapless sequence (see its own comment), so
  // that resolved sequence, not the raw `me.order` the server happened to
  // send, is the honest "current order" to drag/button-reorder against: it's
  // the same one the table is actually rendering, system row included.
  const rows = orderedRows(me)
  const rowById = new Map(rows.map(r => [r.id, r]))
  const serverOrder = rows.map(r => r.id)

  // Local, optimistic display order for drag/button reorder — same shape as
  // ListDetail's tag-member order: reset whenever the server-resolved order
  // changes SHAPE (a list created/deleted/subscribed elsewhere), not on every
  // unrelated re-render, so a reorder that hasn't round-tripped yet (mid-drag,
  // mid-mutation) survives a refetch of unrelated `me` fields. Comparing the
  // joined id list rather than array identity is what makes that possible.
  const [order, setOrder] = useState(serverOrder)
  const [knownServerOrder, setKnownServerOrder] = useState(serverOrder)
  if (serverOrder.join('\n') !== knownServerOrder.join('\n')) {
    setKnownServerOrder(serverOrder)
    setOrder(serverOrder)
  }
  const displayRows = order.map(id => rowById.get(id)).filter((r): r is Row => !!r)
  const locked = orderMutation.isPending
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [orderError, setOrderError] = useState<string | null>(null)

  async function commitOrder(next: string[]) {
    const prev = order
    setOrder(next)
    setOrderError(null)
    try {
      await orderMutation.mutateAsync([next])
    } catch (e) {
      setOrder(prev)
      setOrderError(e instanceof Error ? e.message : 'Could not save the new order')
    }
  }
  function move(id: string, dir: -1 | 1) {
    // swapNeighbor hands back the SAME array reference when `id` is already
    // at that edge (see its own early return) — that reference equality is
    // the no-op signal, so ArrowUp on the top row / ArrowDown on the bottom
    // one never fires a pointless PUT.
    const next = swapNeighbor(order, id, dir)
    if (next !== order) void commitOrder(next)
  }
  function dropOn(targetId: string) {
    setDraggingId(null); setDragOverId(null)
    if (!draggingId || draggingId === targetId) return
    const from = order.indexOf(draggingId)
    const to = order.indexOf(targetId)
    if (from < 0 || to < 0) return
    const next = order.slice()
    next.splice(from, 1)
    next.splice(to, 0, draggingId)
    void commitOrder(next)
  }

  return (
    <>
      <div className="sec-title">Your lists</div>
      <div className="panel"><table className="tbl">
        {/* No visible label: a bare handle column reads fine on its own, and
            every handle names its OWN row via aria-label below — an
            "Reorder" header would only repeat that. The aria-label here is
            purely for a screen reader moving header-by-header across the
            row (table navigation), not a visual caption. */}
        <thead><tr><th>List</th><th className="r">Tags</th><th className="r">Accounts</th><th className="r">Subscribers</th><th className="r" aria-label="Reorder"></th></tr></thead>
        <tbody>
          {displayRows.map(row => {
            const dragging = draggingId === row.id
            const dragOver = dragOverId === row.id && draggingId !== row.id
            return (
              <tr
                key={row.id}
                className={dragging ? 'row-dragging' : dragOver ? 'row-drag-over' : undefined}
                onDragOver={e => { if (draggingId && draggingId !== row.id && !locked) { e.preventDefault(); setDragOverId(row.id) } }}
                onDragLeave={() => setDragOverId(prev => (prev === row.id ? null : prev))}
                onDrop={e => { e.preventDefault(); if (!locked) dropOn(row.id) }}
              >
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
                <td data-label="Subscribers" className="r mono">{row.kind === 'list' ? row.lib.subscriberCount : '—'}</td>
                <td data-label="Reorder" className="r">
                  {/* The handle — not the row — is the drag origin: dragging
                      starts only from this glyph, so the List cell's own
                      link (natively draggable, like any <a>) never competes
                      with it for the gesture. Native <button> semantics keep
                      it in the normal tab order and give ArrowUp/ArrowDown a
                      focused element to act on, mirroring the tag-member
                      chip's Alt+Arrow keyboard fallback (ListDetail.tsx) —
                      unmodified arrows here, since this control has no other
                      use for them. */}
                  <button
                    type="button"
                    className="row-handle"
                    draggable={!locked}
                    disabled={locked}
                    aria-label={`Reorder ${rowLabel(row)} — press ArrowUp or ArrowDown to move it`}
                    aria-keyshortcuts="ArrowUp ArrowDown"
                    onDragStart={() => setDraggingId(row.id)}
                    onDragEnd={() => { setDraggingId(null); setDragOverId(null) }}
                    onKeyDown={e => {
                      if (locked) return
                      if (e.key === 'ArrowUp') { e.preventDefault(); move(row.id, -1) }
                      else if (e.key === 'ArrowDown') { e.preventDefault(); move(row.id, 1) }
                    }}
                  >⋮⋮</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table></div>
      {orderError && <div className="dialog-error" style={{ marginBottom: 16 }}>{orderError}</div>}
      <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 11, marginBottom: 16 }}>Higher lists win when an account is tagged in several. Drag a row's handle, or focus it and press ArrowUp/ArrowDown, to reorder.</div>
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
