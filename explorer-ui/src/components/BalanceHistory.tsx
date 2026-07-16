import { F, AssetIcon, AreaChart } from './ui'
import { useQueryValue, setQuery } from '../router'
import type { AssetBalanceHistory } from '../types'

// Per-asset balance history: a button per asset and a line chart of the selected
// asset's balance over the indexed window, with a
// crosshair tooltip showing the balance + date at the hovered point. The
// selected asset deep-links via ?asset=<assetId> (default first asset = clean URL).
export function BalanceHistory({ history }: { history: AssetBalanceHistory[] }) {
  // Show every asset that has any history; the chart itself falls back to a
  // "not enough history" note for a lone point (e.g. a just-acquired asset).
  const usable = history.filter(h => h.points.length >= 1)
  // NB: Number('') is 0, not NaN - an absent param must not select asset id 0.
  const rawParam = useQueryValue('asset', '')
  const assetParam = rawParam === '' ? null : Number(rawParam)
  if (!usable.length) return null
  const sel = assetParam == null ? 0 : Math.max(0, usable.findIndex(h => h.asset.assetId === assetParam))
  const cur = usable[sel]
  // Shared x-axis across ALL assets (the longest history), so tabbing through
  // the chips compares the same window. Assets with shorter histories zero-fill
  // before their first observation — the same convention the API's aligned
  // histories use — and forward-fill between points.
  const fullAxisTs = usable.reduce((a, h) => (h.points.length > a.length ? h.points.map(p => p.ts) : a), [] as string[])
  // aToken history is authoritative only from its node-sourced anchor. Keep the
  // shared axis inside that exact coverage window instead of implying a zero
  // balance during the explicitly unavailable pre-anchor period.
  const axisTs = cur.availableFrom ? fullAxisTs.filter(ts => ts >= cur.availableFrom!) : fullAxisTs
  const balByTs = new Map(cur.points.map(p => [p.ts, p.balance]))
  const onAxis = cur.points.some(p => balByTs.has(p.ts) && axisTs.includes(p.ts))
  let last = 0
  const series = onAxis ? axisTs.map(ts => { const v = balByTs.get(ts); if (v != null) last = v; return last }) : cur.points.map(p => p.balance)
  const dates = onAxis ? axisTs : cur.points.map(p => p.ts)
  // Hover/x-axis value: token balance with the asset's symbol (e.g. "12.3456 HDX").
  const fmtBal = (v: number) => `${F.amount(String(Math.round(v * 10 ** cur.asset.decimals)), cur.asset.decimals)} ${cur.asset.symbol}`
  return (
    <>
      <div className="sec-title">Balance history · per asset</div>
      <div className="pf-card">
        <div className="bal-chips">
          {usable.map((h, i) => (
            <button key={h.asset.assetId} className={`bal-chip ${i === sel ? 'on' : ''}`} onClick={() => setQuery({ asset: i === 0 ? null : String(h.asset.assetId) })}>
              <AssetIcon assetId={h.asset.assetId} iconAssetId={h.asset.iconAssetId} symbol={h.asset.symbol} size={16} parachainId={h.asset.parachainId} origin={h.asset.origin} /> <span className="mono">{h.asset.symbol}</span>
            </button>
          ))}
        </div>
        <div className="pf-head" style={{ marginTop: 14 }}>
          <div className="pf-now">{fmtBal(cur.current)}</div>
          {cur.availableFrom && <div className="muted mono" style={{ fontSize: 11, marginLeft: 'auto' }}>Indexed from {cur.availableFrom.slice(0, 10)}</div>}
        </div>
        <AreaChart data={series} h={200} color="var(--sky)" floor={0} dates={dates} valueFmt={fmtBal} />
      </div>
    </>
  )
}
