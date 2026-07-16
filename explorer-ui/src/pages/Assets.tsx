import { useAssets } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { paths, setQuery, useQueryValue } from '../router'
import { Crumbs, F, AssetIcon, Sparkline, EmptyRow, TableSkeleton, rowNav, Dash } from '../components/ui'
import type { AssetListItem } from '../types'

type AssetSort = 'tvl' | 'holders' | '24h' | '7d'
type SortDir = 'asc' | 'desc'
const SORTS: AssetSort[] = ['tvl', 'holders', '24h', '7d']

function sortValue(a: AssetListItem, sort: AssetSort): number | null | undefined {
  if (sort === 'tvl') return a.amountUsd
  if (sort === 'holders') return a.holderCount
  if (sort === '24h') return a.change24h
  return a.change7d
}

export function Assets() {
  useDocumentTitle('Assets')
  const { data, isLoading } = useAssets()
  const sortParam = useQueryValue('sort', 'tvl') as AssetSort
  const dirParam = useQueryValue('dir', 'desc') as SortDir
  const sort = SORTS.includes(sortParam) ? sortParam : 'tvl'
  const dir = dirParam === 'asc' ? 'asc' : 'desc'
  const rows = [...(data ?? [])].sort((a, b) => {
    const av = sortValue(a, sort)
    const bv = sortValue(b, sort)
    if (av == null && bv == null) return a.symbol.localeCompare(b.symbol)
    if (av == null) return 1
    if (bv == null) return -1
    const d = dir === 'asc' ? av - bv : bv - av
    return d || a.symbol.localeCompare(b.symbol)
  })
  const chCol = (c: number | null | undefined) => c == null || Math.abs(c) < 0.0005 ? 'var(--text-low)' : c > 0 ? 'var(--green)' : 'var(--red)'
  const sTh = (key: AssetSort, label: string) => {
    const active = sort === key
    const nextDir: SortDir = active && dir === 'desc' ? 'asc' : 'desc'
    return (
      <button
        type="button"
        className={`th-sort${active ? ' on' : ''}`}
        onClick={() => setQuery({
          sort: key === 'tvl' && nextDir === 'desc' ? null : key,
          dir: nextDir === 'desc' ? null : nextDir,
        })}
      >
        {label}{active ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
      </button>
    )
  }

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Assets' }]} />
        <div className="page-title">Assets <span className="sub">{rows.length} tokens</span></div>
      </div>
      <div className="panel">
        <table className="tbl assets-tbl">
          <thead><tr><th>Asset</th><th className="r">Price</th><th className="r">{sTh('24h', '24H')}</th><th className="r">{sTh('7d', '7D')}</th><th className="r">{sTh('holders', 'Holders')}</th><th className="r">{sTh('tvl', 'TVL')}</th><th className="r">Last 7 days</th></tr></thead>
          <tbody>
            {isLoading ? <TableSkeleton cols={7} /> : !rows.length ? <EmptyRow cols={7}>No assets</EmptyRow> : rows.map(a => (
              <tr key={a.assetId} {...rowNav(paths.asset(a.assetId))}>
                <td data-label="Asset">
                  <div className="asset-row">
                    <AssetIcon assetId={a.assetId} iconAssetId={a.iconAssetId} symbol={a.symbol} size={30} parachainId={a.parachainId} origin={a.origin} />
                    <div className="ar-meta"><span className="ar-sym">{a.symbol}</span><span className="ar-name">{a.name ?? `#${a.assetId}`}</span></div>
                  </div>
                </td>
                <td data-label="Price" className="r mono ar-price">{a.price != null ? F.priceUsd(a.price) : <Dash />}</td>
                <td data-label="24H" className="r mono" style={{ color: chCol(a.change24h) }}>{a.change24h != null ? F.pct(a.change24h) : <Dash />}</td>
                <td data-label="7D" className="r mono" style={{ color: chCol(a.change7d) }}>{a.change7d != null ? F.pct(a.change7d) : <Dash />}</td>
                <td data-label="Holders" className="r mono">{a.holderCount != null ? F.int(a.holderCount) : <Dash />}</td>
                <td data-label="TVL" className="r mono">{a.amountUsd != null ? F.usd(a.amountUsd) : <Dash />}</td>
                <td data-label="Last 7 days" className="r spark-cell">{a.sparkline && a.sparkline.length > 1 ? <Sparkline data={a.sparkline} w={110} h={30} change7d={a.change7d ?? null} /> : <Dash />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
