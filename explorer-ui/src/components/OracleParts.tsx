import type { ReactNode } from 'react'
import { Link, paths } from '../router'
import { AssetIcon, CopyValue, F } from './ui'
import { fmtDuration } from '../utils/dca'
import type { AssetRef } from '../types'
import type { OracleConsumer, OracleSourceRef, SourceKind, SourceStatus } from '../api/oracles'
import { fmtRatio, KIND_LABEL, sourceHref, STATUS_LABEL } from './oracleFormat'

// The oracle pages' shared pieces: how a source's kind, status, age and value
// read, everywhere they appear (/oracles and /oracle/:feed).

const KIND_COLOR: Record<SourceKind, string> = {
  dia: 'var(--sky)', push: 'var(--lavender)', ema: 'var(--green)', composite: 'var(--cat-liquidity)', computed: 'var(--amber)', fixed: 'var(--text-low)', unknown: 'var(--text-low)',
}

export function KindBadge({ kind }: { kind: SourceKind }) {
  const color = KIND_COLOR[kind]
  return <span className="badge orc-kind" style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color }}>{KIND_LABEL[kind]}</span>
}

const STATUS_COLOR: Record<SourceStatus, string> = {
  live: 'var(--green)', stale: 'var(--amber)', retired: 'var(--text-low)', static: 'var(--text-low)', fixed: 'var(--text-low)', unknown: 'var(--text-low)',
}
export function StatusDot({ status, title }: { status: SourceStatus; title?: string }) {
  return <span className="orc-dot" style={{ background: STATUS_COLOR[status] }} title={title ?? STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]} role="img" />
}

export function Age({ sec, at }: { sec: number | null; at?: string | null }) {
  if (sec == null) return <span className="mono muted">—</span>
  return <span title={at ? F.datetime(at) : undefined}>{fmtDuration(sec)} ago</span>
}

/** A duration ("17m", "24h"), or a dash. */
export function Dur({ sec }: { sec: number | null | undefined }) {
  return sec == null ? <span className="mono muted">—</span> : <>{fmtDuration(sec)}</>
}

/** A feed or oracle value from its exact decimal string; hover/click reveals and copies the exact figure. */
export function FeedValue({ value, usd, digits }: { value: string | null | undefined; usd: boolean; digits?: number }) {
  if (value == null) return <span className="mono muted">—</span>
  const n = Number(value)
  const shown = usd ? (n > 0 && n < 100 ? '$' + fmtRatio(n, digits) : F.priceUsd(n)) : fmtRatio(n, digits)
  return <CopyValue full={(usd ? '$' : '') + value} plain={value}>{shown}</CopyValue>
}

export function DeviationCell({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="mono muted">—</span>
  const a = Math.abs(pct)
  const color = a > 3 ? 'var(--red)' : a > 1 ? 'var(--amber)' : undefined
  return <span style={color ? { color } : undefined} title="Oracle price over the market price, minus one">{(pct >= 0 ? '+' : '') + pct.toFixed(2)}%</span>
}

export function AssetMini({ asset, size = 18 }: { asset: AssetRef; size?: number }) {
  return (
    <span className="orc-asset">
      <AssetIcon assetId={asset.assetId} iconAssetId={asset.iconAssetId} iconAssetIds={asset.iconAssetIds} symbol={asset.symbol} size={size} parachainId={asset.parachainId} origin={asset.origin} />
      <span>{asset.symbol}</span>
    </span>
  )
}

function SourceLabel({ s }: { s: OracleSourceRef }) {
  const to = sourceHref(s)
  return to ? <Link to={to} className="hash orc-src-label">{s.label}</Link> : <span className="orc-src-label">{s.label}</span>
}

/** A source: its kind, what it is, and for a composite the inputs it is the product of. */
export function SourceCell({ s }: { s: OracleSourceRef }) {
  const comps = s.components ?? []
  return (
    <span className="orc-src">
      <span className="orc-src-head"><KindBadge kind={s.kind} />{comps.length ? null : <SourceLabel s={s} />}</span>
      {comps.length > 0 && (
        <span className="orc-src-comps" title={s.note ?? undefined}>
          {s.kind === 'composite' && /^0x[0-9a-f]{40}$/.test(s.address) && <Link to={paths.oracle(s.address)} className="hash muted">adapter</Link>}
          {comps.map((c, i) => (
            <span key={`${c.address}:${i}`} className="orc-src-comp">
              {i > 0 && <span className="muted">×</span>}
              <StatusDot status={c.status} title={`${c.label}: ${STATUS_LABEL[c.status]}`} />
              <SourceLabel s={c} />
            </span>
          ))}
        </span>
      )}
    </span>
  )
}

export function ConsumerList({ consumers, empty = 'unused' }: { consumers: OracleConsumer[]; empty?: ReactNode }) {
  if (!consumers.length) return <span className="mono muted">{empty}</span>
  return (
    <span className="orc-consumers">
      {consumers.map((c, i) => (
        <Link key={`${c.kind}:${c.kind === 'reserve' ? c.market : c.poolId}:${c.asset.assetId}:${i}`}
          to={c.kind === 'reserve' ? paths.asset(c.asset.assetId) : paths.pool(c.poolId)}
          className="orc-consumer"
          title={c.kind === 'reserve' ? `${c.marketLabel} reserve${c.via ? ', through an adapter' : ''}` : `${c.pool.symbol} peg for ${c.asset.symbol}${c.via ? ', through an adapter' : ''}`}>
          <AssetMini asset={c.kind === 'reserve' ? c.asset : c.pool} size={14} />
          <span className="muted">{c.kind === 'reserve' ? (c.market === 'core' ? 'MM' : c.marketLabel) : 'peg'}</span>
        </Link>
      ))}
    </span>
  )
}

/** Neutral daily bars at row scale: no axes, the day and count on hover. */
export function MiniBars({ data, h = 26 }: { data: { date: string; count: number }[]; h?: number }) {
  const max = Math.max(1, ...data.map(d => d.count))
  const w = 120
  const bw = data.length ? w / data.length : 0
  return (
    <svg className="orc-bars" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`Daily updates, ${data.length} days`}>
      {data.map((d, i) => {
        const bh = Math.max(d.count > 0 ? 1 : 0, (d.count / max) * (h - 2))
        return <rect key={d.date} x={(i * bw + 0.5).toFixed(2)} y={(h - bh).toFixed(2)} width={Math.max(0.5, bw - 1).toFixed(2)} height={bh.toFixed(2)} rx="1"><title>{`${d.date} · ${F.int(d.count)} updates`}</title></rect>
      })}
    </svg>
  )
}
