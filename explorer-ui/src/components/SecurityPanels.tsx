import type { ReactNode } from 'react'
import { Link, paths } from '../router'
import { F } from './ui'
import { fmtPct, loadColor } from '../utils/security'
import type { SecurityFuse, SecurityFuseStatus } from '../types'

// Visual primitives for the Security page.
//
// The page's one bold element is the fuse grid: every asset that carries a
// deposit limit becomes a small vertical gauge, filled to the share of its 24h
// mint allowance already used. Sixty gauges read as a single instrument — a wall
// of cold fuses with the loaded ones glowing — where sixty table rows read as a
// wall of numbers. The table below carries the numbers.
//
// Everything else on the page stays deliberately quiet and reuses the explorer's
// existing panels, tables and stat cards.

const FUSE_STATUS_TEXT: Record<SecurityFuseStatus, string> = {
  locked: 'Locked — minting is held in reserve until the lockdown lifts',
  frozen: 'Frozen — the limit is zero, so any deposit at all is held in reserve',
  active: 'Armed — inside the 24h window',
  expired: 'Window elapsed — the next mint starts a fresh 24h allowance',
  unarmed: 'No window open yet — the next mint starts the first one',
}

// One asset's fuse. The gauge body fills from the bottom; the plate underneath
// always carries a readable symbol. The whole tile links to the asset.
function Fuse({ fuse }: { fuse: SecurityFuse }) {
  const locked = fuse.status === 'locked'
  const frozen = fuse.status === 'frozen'
  // Locked and frozen both mean no deposit gets through, so both read full.
  const shut = locked || frozen
  // A locked fuse is at its limit, not idle — only an elapsed or never-opened
  // window makes a gauge dormant.
  const dormant = fuse.status === 'expired' || fuse.status === 'unarmed'
  const pct = shut ? 100 : Math.min(100, fuse.usagePct)
  // Below ~2% a proportional fill is a sub-pixel sliver, so any real usage keeps
  // a visible floor — the number in the tooltip stays exact either way.
  const fillPct = pct > 0 ? Math.max(pct, 3) : 0
  const color = shut ? 'var(--red)' : loadColor(pct)
  const title = [
    `${fuse.asset.symbol} · asset ${fuse.asset.assetId}`,
    FUSE_STATUS_TEXT[fuse.status],
    frozen ? 'Limit 0 per 24h' : `Limit ${F.exact(fuse.limit, fuse.asset.decimals)} per 24h`,
    frozen ? '' : dormant ? 'Used 0 (window not running)' : `Minted ${F.exact(fuse.used, fuse.asset.decimals)} · ${fmtPct(fuse.usagePct)} of the allowance`,
    fuse.lockdownCount > 0 ? `Tripped ${fuse.lockdownCount}× historically` : '',
  ].filter(Boolean).join('\n')

  return (
    <Link
      to={paths.asset(fuse.asset.assetId)}
      className={`fuse${shut ? ' locked' : ''}${dormant ? ' dormant' : ''}`}
      title={title}
      ariaLabel={`${fuse.asset.symbol} deposit fuse, ${locked ? 'locked' : frozen ? 'frozen' : `${fmtPct(fuse.usagePct)} used`}`}
    >
      <span className="fuse-body" style={{ color }}>
        <span className="fuse-fill" style={{ height: `${fillPct}%` }} />
        {/* Past ~70% the fill reaches the label zone, so currentColor would put
            the number in its own hue — `on-fill` gives it a backdrop instead. */}
        {pct >= 4 && <span className={`fuse-pct${fillPct >= 70 ? ' on-fill' : ''}`}>{locked ? 'LOCK' : frozen ? 'FRZ' : Math.round(pct)}</span>}
      </span>
      <span className="fuse-plate">{fuse.asset.symbol}</span>
    </Link>
  )
}

export function FuseGrid({ fuses }: { fuses: SecurityFuse[] }) {
  if (!fuses.length) return <div className="hdx-note">No asset carries a deposit limit.</div>
  return (
    <div className="fuse-grid">
      {fuses.map(f => <Fuse key={f.asset.assetId} fuse={f} />)}
    </div>
  )
}

// A single wide load meter with quarter gridlines, used for the chain-wide
// withdraw budget. `mark` is drawn as a hairline (the limit's own scale is 0-100%).
export function LoadMeter({ pct, color, height = 14, label }: { pct: number | null; color?: string; height?: number; label?: ReactNode }) {
  const clamped = pct == null ? 0 : Math.max(0, Math.min(100, pct))
  return (
    <div className="load-meter" style={{ height }}>
      <div className="lm-fill" style={{ width: `${pct == null ? 0 : Math.max(clamped, clamped > 0 ? 0.4 : 0)}%`, background: color ?? loadColor(clamped) }} />
      {[25, 50, 75].map(t => <i key={t} className="lm-tick" style={{ left: `${t}%` }} />)}
      {label != null && <span className="lm-label">{label}</span>}
    </div>
  )
}

// Yearly trip counts. Four bars need an axis, not a chart library: the count sits
// above each bar and the year below it, so the shape and the numbers both read.
export function YearBars({ data, color = 'var(--red)' }: { data: { year: number; count: number }[]; color?: string }) {
  const max = Math.max(1, ...data.map(d => d.count))
  return (
    <div className="year-bars">
      {data.map(d => (
        <div key={d.year} className="yb">
          <span className="yb-v">{F.int(d.count)}</span>
          <span className="yb-track"><i style={{ height: `${(d.count / max) * 100}%`, background: color }} /></span>
          <span className="yb-k">{d.year}</span>
        </div>
      ))}
    </div>
  )
}

