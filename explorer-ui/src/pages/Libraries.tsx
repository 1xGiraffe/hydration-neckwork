import { lazy, Suspense, useState } from 'react'
import { userApi } from '../api/explorer'
import { useSession } from '../session'
import { useMe, useLibraries, useUserMutation } from '../hooks/useUser'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, navigate, paths } from '../router'
import { Crumbs, AddrPill, TagIcon, EmptyRow, TableSkeleton, rowNav } from '../components/ui'
import type { LibrarySummaryRef, MeResponse } from '../types'

const ConnectDialog = lazy(() => import('../components/ConnectDialog').then(m => ({ default: m.ConnectDialog })))
const LibraryFormDialog = lazy(() => import('../components/LibraryFormDialog').then(m => ({ default: m.LibraryFormDialog })))

// A viewer's private "personal" library reads as `personal`, ahead of the
// public/private split every other library carries. (Duplicated in
// LibraryDetail.tsx rather than shared — see the comment there.)
function visibilityChip(lib: Pick<LibrarySummaryRef, 'isPersonal' | 'visibility'>) {
  const [label, color] = lib.isPersonal ? ['personal', 'var(--amber)'] : lib.visibility === 'public' ? ['public', 'var(--sky)'] : ['private', 'var(--neutral)']
  return <span className="badge" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>{label}</span>
}

// One reorderable row in "Your libraries": either a real library (owned or
// subscribed) or the fixed slot standing in for the built-in Hydration tag
// directory — it participates in the same priority order but is not a
// LibrarySummaryRef, so it gets its own case everywhere a row is drawn.
type Row = { id: 'system'; kind: 'system' } | { id: string; kind: 'library'; lib: LibrarySummaryRef; owned: boolean }

// `me.order` names every slot (every owned/subscribed library plus 'system')
// in priority order — walk it to build the rows, then append anything it
// missed (a fresh subscription the order hasn't caught up with yet) so a row
// is never silently dropped.
function orderedRows(me: MeResponse): Row[] {
  const byId = new Map<string, Row>()
  for (const lib of me.libraries) byId.set(lib.libraryId, { id: lib.libraryId, kind: 'library', lib, owned: true })
  for (const lib of me.subscriptions) if (!byId.has(lib.libraryId)) byId.set(lib.libraryId, { id: lib.libraryId, kind: 'library', lib, owned: false })
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

function YourLibraries({ me }: { me: MeResponse }) {
  const orderMutation = useUserMutation(userApi.setOrder)
  const rows = orderedRows(me)
  const move = (id: string, dir: -1 | 1) => orderMutation.mutate([swapNeighbor(me.order, id, dir)])

  return (
    <>
      <div className="sec-title">Your libraries</div>
      <div className="panel"><table className="tbl">
        <thead><tr><th>Library</th><th className="r">Tags</th><th className="r">Accounts</th><th className="r">Order</th></tr></thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id}>
              <td data-label="Library">
                {row.kind === 'system' ? (
                  <Link to={paths.tags()} className="addr-pill">
                    <TagIcon icon="🏷️" title="Hydration tags" />
                    <span className="tag">Hydration tags</span>
                  </Link>
                ) : (
                  <>
                    <Link to={paths.library(row.lib.libraryId)} className="addr-pill">
                      <TagIcon icon="📚" title={row.lib.name} />
                      <span className="tag">{row.lib.name}</span>
                    </Link>{' '}
                    {visibilityChip(row.lib)}
                    {!row.owned && <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>subscribed</span>}
                  </>
                )}
              </td>
              <td data-label="Tags" className="r mono">{row.kind === 'library' ? row.lib.tagCount : '—'}</td>
              <td data-label="Accounts" className="r mono">{row.kind === 'library' ? row.lib.accountCount : '—'}</td>
              <td data-label="Order" className="r">
                <button type="button" className="btn sm" aria-label="Move up" disabled={i === 0 || orderMutation.isPending} onClick={() => move(row.id, -1)}>▲</button>{' '}
                <button type="button" className="btn sm" aria-label="Move down" disabled={i === rows.length - 1 || orderMutation.isPending} onClick={() => move(row.id, 1)}>▼</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 11, marginBottom: 16 }}>Higher libraries win when an account is tagged in several.</div>
    </>
  )
}

function Invites({ invites }: { invites: LibrarySummaryRef[] }) {
  const respondMutation = useUserMutation(userApi.respondInvite)
  return (
    <>
      <div className="sec-title">Invites · {invites.length}</div>
      <div className="panel"><table className="tbl">
        <thead><tr><th>Library</th><th>Owner</th><th className="r">Action</th></tr></thead>
        <tbody>
          {invites.map(inv => (
            <tr key={inv.libraryId}>
              <td data-label="Library"><span className="tag">{inv.name}</span></td>
              <td data-label="Owner"><AddrPill account={inv.owner} noCopy /></td>
              <td data-label="Action" className="r">
                <button type="button" className="btn sm primary" disabled={respondMutation.isPending} onClick={() => respondMutation.mutate([inv.libraryId, true])}>Accept</button>{' '}
                <button type="button" className="btn sm" disabled={respondMutation.isPending} onClick={() => respondMutation.mutate([inv.libraryId, false])}>Decline</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </>
  )
}

function Discover({ libraries, isLoading, me, session, onConnect }: {
  libraries: LibrarySummaryRef[]
  isLoading: boolean
  me: MeResponse | undefined
  session: ReturnType<typeof useSession>
  onConnect: () => void
}) {
  const subscribeMutation = useUserMutation(userApi.subscribe)
  const unsubscribeMutation = useUserMutation(userApi.unsubscribe)
  return (
    <>
      <div className="sec-title">Discover · {libraries.length}</div>
      <div className="panel"><table className="tbl">
        <thead><tr><th>Library</th><th>Owner</th><th className="r">Tags</th><th className="r">Accounts</th><th className="r">Subscribers</th><th className="r"></th></tr></thead>
        <tbody>
          {isLoading && !libraries.length ? <TableSkeleton cols={6} rows={4} /> : !libraries.length ? <EmptyRow cols={6}>No public libraries yet</EmptyRow> : libraries.map(lib => {
            const owned = me?.libraries.some(l => l.libraryId === lib.libraryId)
            const subscribed = me?.subscriptions.some(l => l.libraryId === lib.libraryId)
            return (
              <tr key={lib.libraryId} {...rowNav(paths.library(lib.libraryId))}>
                <td data-label="Library">
                  <Link to={paths.library(lib.libraryId)} className="addr-pill" onClick={e => e.stopPropagation()}>
                    <TagIcon icon="📚" title={lib.name} />
                    <span className="tag">{lib.name}</span>
                  </Link>
                </td>
                <td data-label="Owner"><AddrPill account={lib.owner} noCopy /></td>
                <td data-label="Tags" className="r mono">{lib.tagCount}</td>
                <td data-label="Accounts" className="r mono">{lib.accountCount}</td>
                <td data-label="Subscribers" className="r mono">{lib.subscriberCount}</td>
                <td data-label="Action" className="r">
                  {!session ? (
                    <button type="button" className="btn sm" onClick={onConnect}>Log in to subscribe</button>
                  ) : owned ? (
                    <span className="muted" style={{ fontSize: 11 }}>Yours</span>
                  ) : subscribed ? (
                    <button type="button" className="btn sm" disabled={unsubscribeMutation.isPending} onClick={() => unsubscribeMutation.mutate([lib.libraryId])}>Unsubscribe</button>
                  ) : (
                    <button type="button" className="btn sm primary" disabled={subscribeMutation.isPending} onClick={() => subscribeMutation.mutate([lib.libraryId])}>Subscribe</button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table></div>
    </>
  )
}

export function Libraries() {
  useDocumentTitle('Libraries')
  const session = useSession()
  const me = useMe()
  const libs = useLibraries()
  const createMutation = useUserMutation(userApi.createLibrary)

  const [connectOpen, setConnectOpen] = useState(false)
  const [connectMounted, setConnectMounted] = useState(false)
  const openConnect = () => { setConnectMounted(true); setConnectOpen(true) }

  const [newLibOpen, setNewLibOpen] = useState(false)
  const [newLibMounted, setNewLibMounted] = useState(false)
  const openNewLib = () => { setNewLibMounted(true); setNewLibOpen(true) }

  const invites = me.data?.invites ?? []

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Libraries' }]} />
        <div className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          Libraries
          {session && <button type="button" className="btn primary" style={{ marginLeft: 'auto' }} onClick={openNewLib}>+ New library</button>}
        </div>
      </div>

      <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 12, marginBottom: 16 }}>
        A library is a named collection of tags for organizing accounts you follow — your own, alongside the built-in Hydration
        directory. Public libraries can be discovered and subscribed to by anyone; private ones are only visible to you and
        anyone you invite.
      </div>

      {session && me.data && <YourLibraries me={me.data} />}
      {invites.length > 0 && <Invites invites={invites} />}
      <Discover libraries={libs.data ?? []} isLoading={libs.isLoading} me={me.data} session={session} onConnect={openConnect} />

      {connectMounted && (
        <Suspense fallback={null}>
          <ConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
        </Suspense>
      )}
      {newLibMounted && (
        <Suspense fallback={null}>
          <LibraryFormDialog
            open={newLibOpen}
            onOpenChange={setNewLibOpen}
            title="New library"
            hint="A named collection of tags for organizing accounts you follow."
            submitLabel="Create"
            pending={createMutation.isPending}
            onSubmit={async values => {
              const lib = await createMutation.mutateAsync([{ name: values.name, note: values.note || undefined, visibility: values.visibility }])
              setNewLibOpen(false)
              navigate(paths.library(lib.libraryId))
            }}
          />
        </Suspense>
      )}
    </div>
  )
}
