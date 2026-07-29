import { userApi } from '../api/explorer'
import { useSession } from '../session'
import { useUserMutation } from '../hooks/useUser'
import { requestConnect } from '../connectDialog'
import { AddrPill, EmptyRow, TableSkeleton } from './ui'
import type { ListSummaryRef, MeResponse } from '../types'

// Public lists, browsable but — user-confirmed — not clickable: a list is
// provenance/management, not something to open from here. The only actions a
// row offers are the inline subscribe toggle and (via the nested owner pill)
// a link to the owner's account. Shared by the Tags discovery hub and the
// Lists management page (both let a viewer browse and subscribe to public
// lists) — kept as one component rather than two copies so the row shape and
// every action read identically wherever a viewer meets it.
export function PublicListsPanel({ lists, isLoading, me, session }: {
  lists: ListSummaryRef[]
  isLoading: boolean
  me: MeResponse | undefined
  session: ReturnType<typeof useSession>
}) {
  const subscribeMutation = useUserMutation(userApi.subscribe)
  const unsubscribeMutation = useUserMutation(userApi.unsubscribe)
  return (
    <>
      <div className="sec-title">Public lists · {lists.length}</div>
      <div className="panel"><table className="tbl">
        <thead><tr><th>List</th><th>Owner</th><th className="r">Tags</th><th className="r">Accounts</th><th className="r">Subscribers</th><th className="r"></th></tr></thead>
        <tbody>
          {isLoading && !lists.length ? <TableSkeleton cols={6} rows={4} /> : !lists.length ? <EmptyRow cols={6}>No public lists yet</EmptyRow> : lists.map(lib => {
            const owned = me?.lists.some(l => l.listId === lib.listId)
            const subscribed = me?.subscriptions.some(l => l.listId === lib.listId)
            return (
              <tr key={lib.listId}>
                <td data-label="List">
                  <span className="addr-pill" style={{ cursor: 'default' }}>
                    <span className="tag">{lib.name}</span>
                  </span>
                  {lib.note && <div className="muted list-row-note">{lib.note}</div>}
                </td>
                <td data-label="Owner"><AddrPill account={lib.owner} noCopy /></td>
                <td data-label="Tags" className="r mono">{lib.tagCount}</td>
                <td data-label="Accounts" className="r mono">{lib.accountCount}</td>
                <td data-label="Subscribers" className="r mono">{lib.subscriberCount}</td>
                <td data-label="Action" className="r">
                  {!session ? (
                    // Same appearance as the logged-in Subscribe button below —
                    // clicking opens the login dialog rather than subscribing
                    // directly; the mutation itself needs a session either way.
                    <button type="button" className="btn sm primary" onClick={requestConnect}>Subscribe</button>
                  ) : owned ? (
                    <span className="muted" style={{ fontSize: 11 }}>Yours</span>
                  ) : subscribed ? (
                    <button type="button" className="btn sm" disabled={unsubscribeMutation.isPending} onClick={() => unsubscribeMutation.mutate([lib.listId])}>Unsubscribe</button>
                  ) : (
                    <button type="button" className="btn sm primary" disabled={subscribeMutation.isPending} onClick={() => subscribeMutation.mutate([lib.listId])}>Subscribe</button>
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
