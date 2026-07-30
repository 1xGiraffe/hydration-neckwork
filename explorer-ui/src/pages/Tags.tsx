import { userApi } from '../api/explorer'
import { useTags } from '../hooks/useExplorerData'
import { useSession } from '../session'
import { useMe, useLists, useUserMutation } from '../hooks/useUser'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths } from '../router'
import { Crumbs, AddrPill, EmptyRow, TableSkeleton, TagIcon, rowNav } from '../components/ui'
import { PublicListsPanel } from '../components/PublicListsPanel'
import type { ListSummaryRef } from '../types'

// The one clickable "list" row on the hub: the built-in Hydration
// directory, promoted above every user-made list so tags — not
// lists — read as the primary thing to browse. Its own table lives at
// /tags/hydration (TagsHydration below); everything else on this page is
// either unclickable (Discover) or a management action (Invites, the
// "Manage lists" button).
function HydrationTagsHero({ tagCount }: { tagCount: number }) {
  return (
    <Link to={paths.tagsHydration()} className="acct-head" style={{ textDecoration: 'none', color: 'inherit' }}>
      <div className="acct-meta">
        <div className="tag">Hydration Tags</div>
        <div className="full"><span className="muted">{tagCount} tag{tagCount === 1 ? '' : 's'} · the built-in directory</span></div>
      </div>
      <span className="muted" aria-hidden="true" style={{ marginLeft: 'auto', fontSize: 22 }}>→</span>
    </Link>
  )
}

// Two groups sharing one table: a pending invite the viewer hasn't answered
// (Accept/Decline) and a private list they already accepted into (only
// reachable through an invite — a public list's `visibility` would read
// 'public' here regardless of whether this particular subscription started as
// an invite or a direct Subscribe, so that case can't be distinguished from
// the data /user/me ships and stays out of this list; it appears as an
// ordinary Subscribed row in Public lists above instead).
function Invites({ invites, invitedSubscriptions }: { invites: ListSummaryRef[]; invitedSubscriptions: ListSummaryRef[] }) {
  const respondMutation = useUserMutation(userApi.respondInvite)
  const unsubscribeMutation = useUserMutation(userApi.unsubscribe)
  return (
    <>
      <div className="sec-title">Invites · {invites.length + invitedSubscriptions.length}</div>
      <div className="panel"><table className="tbl">
        <thead><tr><th>List</th><th>Owner</th><th className="r">Action</th></tr></thead>
        <tbody>
          {invites.map(inv => (
            <tr key={inv.listId}>
              <td data-label="List"><span className="tag">{inv.name}</span></td>
              <td data-label="Owner"><AddrPill account={inv.owner} noCopy /></td>
              <td data-label="Action" className="r">
                <button type="button" className="btn sm primary" disabled={respondMutation.isPending} onClick={() => respondMutation.mutate([inv.listId, true])}>Accept</button>{' '}
                <button type="button" className="btn sm" disabled={respondMutation.isPending} onClick={() => respondMutation.mutate([inv.listId, false])}>Decline</button>
              </td>
            </tr>
          ))}
          {invitedSubscriptions.map(lib => (
            <tr key={lib.listId}>
              <td data-label="List"><span className="tag">{lib.name}</span> <span className="muted" style={{ fontSize: 11 }}>· Invited · subscribed</span></td>
              <td data-label="Owner"><AddrPill account={lib.owner} noCopy /></td>
              <td data-label="Action" className="r">
                <button type="button" className="btn sm" disabled={unsubscribeMutation.isPending} onClick={() => unsubscribeMutation.mutate([lib.listId])}>Unsubscribe</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </>
  )
}

// The tag discovery hub: the built-in directory up top, then every OTHER way
// to find tags — public lists to subscribe to, and any pending/accepted
// invites — with list management itself pushed behind its own button.
// Tags are what a viewer clicks and shares; lists are provenance, which is
// why this page browses tags-by-list rather than editing lists.
export function Tags() {
  useDocumentTitle('Tags')
  const session = useSession()
  const me = useMe()
  const libs = useLists()
  const { data: systemTags } = useTags()

  const invites = me.data?.invites ?? []
  // See the Invites comment above: a private subscription can only exist
  // because an invite was accepted, so this is exact, not a heuristic — it
  // just doesn't catch the (rarer) invite-to-a-public-list case.
  const invitedSubscriptions = (me.data?.subscriptions ?? []).filter(l => l.visibility === 'private')

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Tags' }]} />
        <div className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          Tags
          <Link to={paths.lists()} className="btn" style={{ marginLeft: 'auto' }}>Manage lists</Link>
        </div>
      </div>

      <HydrationTagsHero tagCount={systemTags?.length ?? 0} />

      {(invites.length > 0 || invitedSubscriptions.length > 0) && <Invites invites={invites} invitedSubscriptions={invitedSubscriptions} />}

      <PublicListsPanel lists={libs.data ?? []} isLoading={libs.isLoading} me={me.data} session={session} />
    </div>
  )
}

// The built-in account-tag directory: curated in the backend (account_tags) —
// there is intentionally no in-app create/edit/delete. Moved here from /tags
// (now the discovery hub above) to its own route so a direct link to "the
// tag table" still works.
export function TagsHydration() {
  useDocumentTitle('Hydration Tags')
  const { data, isLoading } = useTags()
  const tags = data ?? []

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Tags', to: paths.tags() }, { label: 'Hydration' }]} />
        <div className="page-title">Hydration Tags <span className="sub">{tags.length} tags</span></div>
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
                    <TagIcon icon={g.icon} title={g.name} />
                    <span className="tag" style={{ color: g.color }}>{g.name}</span>
                  </Link>
                </td>
                <td data-label="Accounts" className="r mono">{g.memberCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
