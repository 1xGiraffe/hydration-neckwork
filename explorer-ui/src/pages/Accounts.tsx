import { useAccounts, useAccountsDaily } from '../hooks/useExplorerData'
import { useListTagSummary } from '../hooks/useUser'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths, usePageParam, useQueryValue, setPage, setQuery } from '../router'
import { Crumbs, F, AddrPill, Sparkline, EmptyRow, TableSkeleton, Pager, healthFactorDisplay, TagGroupPill, TokenIconRow, Dash, pendingRows, compactAmount } from '../components/ui'
import { moneyMarketDebtUsd } from '../components/AccountSections'
import { AccountsChart } from '../components/AccountsChart'
import { defisimAccountTarget } from '../utils/defisim'
import { offeredPages } from '../utils/activityPaging'
import { resolveTag, tagMapStatus, useTagMapVersion } from '../userTags'
import type { TopAccountRow } from '../types'

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
// Below 720px every row becomes a card, where a line reading "BORROWED —" carries
// nothing: cells with no value are marked so the card can drop them. The desktop
// table keeps its dash — a column still has to line up.
const emptyIf = (empty: boolean) => empty ? ' cell-empty' : ''
// A stable identity per rendered row: a system tag's own id, an account's id,
// or (a bare simAccount-only row) its position — the same fallback the row
// loop always used before folding existed.
function rowKey(r: TopAccountRow, i: number): string {
  return r.tag ? `tag:${r.tag.tagId}` : r.account ? `account:${r.account.accountId}` : `row:${r.simAccount ?? i}`
}

// One plain directory row: a system-tag group (already folded server-side)
// or an ordinary account with no viewer tag of its own — extracted so
// Accounts() can render it from more than one branch below.
function AccountRow({ r }: { r: TopAccountRow }) {
  // Badge only for actual borrowers — pure suppliers ('inf') show nothing.
  // Tag rows link DefiSim to the member holding the worst position.
  const hf = r.healthFactor && r.healthFactor !== 'inf' ? healthFactorDisplay(r.healthFactor) : null
  const addr = defisimAccountTarget(r.account, r.simAccount)
  // Module accounts touch balances on every trade, so the column shows the
  // explorer-wide rough scale (2.25M · 505k · 4.87k) rather than a full count.
  const count = (n?: number) => n != null ? <span className="mono muted">{compactAmount(n)}</span> : <Dash />
  return (
    <tr>
      <td data-label="Account">{r.tag ? <TagGroupPill tag={r.tag} /> : r.account ? <AddrPill account={r.account} /> : <Dash />}</td>
      <td data-label="Value" className="r mono">{F.usd(r.portfolioUsd)}</td>
      <td data-label="Holdings" className={`holdings-cell${emptyIf(!r.topAssets?.length)}`}>{r.topAssets?.length ? <TokenIconRow assets={r.topAssets} /> : <Dash />}</td>
      <td data-label="1Y" className={`r${emptyIf(!(r.sparkline && r.sparkline.length > 1))}`}>{r.sparkline && r.sparkline.length > 1 ? <Sparkline data={r.sparkline} /> : <Dash />}</td>
      <td data-label="Lent" className={`r mono${emptyIf(!r.suppliedUsd)}`}>{r.suppliedUsd ? F.usd(r.suppliedUsd) : <Dash />}</td>
      <td data-label="Borrowed" className={`r mono${emptyIf(!r.borrowedUsd)}`}>{r.borrowedUsd ? F.usd(r.borrowedUsd) : <Dash />}</td>
      <td data-label="Health" className={`r${emptyIf(!hf)}`}>{hf && addr
        ? <HealthSimBadge hf={hf} addr={addr} />
        : hf ? <span className={`hf ${hf.cls}`}>{hf.label}</span> : <Dash />}</td>
      <td data-label="Liquidation $" className={`r mono${emptyIf(!r.liquidationVolumeUsd)}`}>{r.liquidationVolumeUsd ? F.usd(r.liquidationVolumeUsd) : <Dash />}</td>
      <td data-label="Trading $" className={`r mono${emptyIf(!r.tradingVolumeUsd)}`}>{r.tradingVolumeUsd ? F.usd(r.tradingVolumeUsd) : <Dash />}</td>
      {/* A partial total is a floor: the feed runs deeper than it could be
          counted, so it reads as "at least this" instead of as exact. */}
      <td data-label="Activity" className={`r${emptyIf(r.activityCount == null)}`}>{count(r.activityCount)}{r.activityCount != null && r.activityCountComplete === false ? '+' : ''}</td>
    </tr>
  )
}

// A viewer's own tag folds its matching on-page rows into one aggregated row —
// the client-side mirror of how a system tag already folds server-side (see
// Accounts() below). There is no server-side group row to read this one's
// numbers off, so it fetches the tag's own aggregate (the same summary
// HoverCard uses) instead; cells that summary can't back up (holdings,
// sparkline, lent/borrowed, health, liquidation, activity) show the page's
// usual dash rather than a number the fetch never supplied. Value nets out
// money-market debt, matching the system rows' own net Value column.
function FoldedTagRow({ listId, tagId, name, color, icon, memberCount }: { listId: string; tagId: string; name: string; color: string; icon: string; memberCount: number }) {
  const { data, isLoading } = useListTagSummary(listId, tagId)
  const netUsd = data ? data.portfolioUsd - moneyMarketDebtUsd(data.moneyMarket) : null
  const skeleton = (w: string) => isLoading ? <span className="sk-bar" style={{ width: w }} /> : <Dash />
  return (
    <tr>
      <td data-label="Account"><TagGroupPill tag={{ tagId, name, color, icon, memberCount }} /></td>
      <td data-label="Value" className="r mono">{netUsd != null ? F.usd(netUsd) : skeleton('60%')}</td>
      <td data-label="Holdings" className="holdings-cell cell-empty"><Dash /></td>
      <td data-label="1Y" className="r cell-empty"><Dash /></td>
      <td data-label="Lent" className="r mono cell-empty"><Dash /></td>
      <td data-label="Borrowed" className="r mono cell-empty"><Dash /></td>
      <td data-label="Health" className="r cell-empty"><Dash /></td>
      <td data-label="Liquidation $" className="r mono cell-empty"><Dash /></td>
      <td data-label="Trading $" className="r mono">{data?.tradingVolumeUsd ? F.usd(data.tradingVolumeUsd) : skeleton('50%')}</td>
      <td data-label="Activity" className="r cell-empty"><Dash /></td>
    </tr>
  )
}

export function Accounts() {
  useDocumentTitle('Accounts')
  const page = usePageParam()
  const sortParam = useQueryValue('sort', 'value') as Sort
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
  const sTh = (key: Sort, label: string) => (
    <button type="button" className={`th-sort${sort === key ? ' on' : ''}`} onClick={() => setQuery({ sort: key === 'value' ? null : key, page: null })}>{label}{sort === key ? ' ▼' : ''}</button>
  )

  // Re-render when the viewer's own tag map changes (login/logout, a tag
  // renamed or re-membered elsewhere) — resolveTag()/tagMapStatus() below read
  // module state a plain render otherwise wouldn't know to react to.
  useTagMapVersion()
  // System tags already fold server-side (one SQL-computed group row per tag —
  // see TopAccountRow.tag) — even a LONE member renders as the group row with
  // group values, never a member row wearing the group's label. A viewer's OWN
  // tags need the identical guarantee: showing a member's own row under the
  // tag's pill (its values belonging to that one account, not the tag) is
  // exactly the confusing mismatch this feature exists to fix, so every row
  // whose account resolves to one of the viewer's tags is replaced by that
  // tag's aggregated row — regardless of how many of its members land on this
  // page. The directory itself is a shared, cached, server-side aggregate with
  // no notion of "the current viewer", so this can only happen here,
  // client-side, from the viewer's own tag map (see userTags.ts) once it's
  // actually loaded — gating on 'ready' (not just "logged in") avoids folding
  // on a stale/absent map and avoids a flash of unfolded rows while it loads.
  // A bare loop over at most PAGE rows is cheap enough to redo on every
  // render — not worth memoizing.
  const foldReady = tagMapStatus() === 'ready'
  const { displayRows, hasFold } = (() => {
    if (!foldReady) return { displayRows: rows.map((r, i) => <AccountRow key={rowKey(r, i)} r={r} />), hasFold: false }
    interface Group { isGroup: true; listId: string; tagId: string; name: string; color: string; icon: string; memberCount?: number; count: number }
    const groups = new Map<string, Group>()
    const order: (Group | { isGroup: false; r: TopAccountRow; i: number })[] = []
    rows.forEach((r, i) => {
      // System-tag rows arrive already folded from the server (r.tag) — only
      // a plain account row can still resolve to one of the viewer's OWN tags.
      const resolved = r.account ? resolveTag(r.account) : null
      if (resolved && resolved.kind === 'user' && resolved.listId) {
        const fk = `${resolved.listId}:${resolved.id}`
        const existing = groups.get(fk)
        if (existing) { existing.count += 1; return }   // a later, lower-ranked member row: dropped
        const group: Group = {
          isGroup: true, listId: resolved.listId, tagId: resolved.id, name: resolved.name, color: resolved.color, icon: resolved.icon,
          memberCount: resolved.memberCount, count: 1,
        }
        groups.set(fk, group)
        order.push(group)
        return
      }
      order.push({ isGroup: false, r, i })
    })
    let folded = false
    const nodes = order.map(entry => {
      if (!entry.isGroup) return <AccountRow key={rowKey(entry.r, entry.i)} r={entry.r} />
      folded = true
      // The full tag's own member count (its value below covers every member,
      // not just the ones on this page — see the hint) — falling back to the
      // on-page count only if the tag map ever omits it.
      return <FoldedTagRow key={`fold:${entry.listId}:${entry.tagId}`} listId={entry.listId} tagId={entry.tagId} name={entry.name} color={entry.color} icon={entry.icon} memberCount={entry.memberCount ?? entry.count} />
    })
    return { displayRows: nodes, hasFold: folded }
  })()

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
          <option value="supplied">Lent</option>
          <option value="borrowed">Borrowed</option>
          <option value="health">Health</option>
          <option value="liquidation">Liquidation $</option>
          <option value="volume">Trading $</option>
          <option value="activity">Activity</option>
        </select>
      </div>

      {/* Only ever true once at least one row actually resolved to a viewer
          tag — a page with no matches says nothing. */}
      {hasFold && <div className="muted" style={{ fontSize: 12, margin: '4px 2px 8px' }}>Folded rows combine all of the tag's accounts, including any beyond this page.</div>}

      <div className="panel">
        <table className="tbl accounts-tbl">
          <thead><tr>
            <th>{sTh('identity', 'Account')}</th>
            <th className="r">{sTh('value', 'Value')}</th><th>Holdings</th><th className="r">1Y</th>
            <th className="r">{sTh('supplied', 'Lent')}</th><th className="r">{sTh('borrowed', 'Borrowed')}</th>
            <th className="r">{sTh('health', 'Health')}</th>
            <th className="r">{sTh('liquidation', 'Liquidation $')}</th>
            <th className="r">{sTh('volume', 'Trading $')}</th>
            <th className="r">{sTh('activity', 'Activity')}</th>
          </tr></thead>
          <tbody {...pendingRows(isPlaceholderData)}>
            {/* A phone card here drops the columns this account has nothing in and
                gives the 1Y chart a whole line of its own, so its height is not the
                column count: the directory's rows measure 172px (identity, value,
                holdings, chart) to 324px, averaging seven lines' worth. */}
            {isLoading && !data ? <TableSkeleton cols={10} mobileCols={7} rows={PAGE} /> : !rows.length ? <EmptyRow cols={10}>No accounts</EmptyRow> : displayRows}
          </tbody>
        </table>
        <Pager page={page} totalPages={pages.totalPages} hasNext={pages.hasNext} note={pages.note} onPage={setPage} />
      </div>
    </div>
  )
}
