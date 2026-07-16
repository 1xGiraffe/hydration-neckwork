import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { F, AssetIcon, assetBrandColor } from './ui'
import { Link, paths } from '../router'
import { squarify } from '../utils/squarify'
import { useIconColor } from '../utils/iconColor'
import type { AddressBalance } from '../types'

// Balances rendered as a value-weighted treemap: each holding is a tile sized by
// its USD value and tinted with its own brand color (sampled from the token's
// icon), so the wallet's composition reads at a glance. Tiles carry the asset
// icon, symbol, value and share; hovering or focusing one (and tapping on touch)
// previews its full breakdown — free, reserved, price — in the detail card below.
// A long tail of dust holdings collapses into one "Other" tile so it never clumps
// into unreadable slivers, and assets with no market price sit in a chip strip.
// Replaces the old balances table on the account and tag detail pages.

// Keep tiles that carry real weight; fold the dust tail into a single "Other"
// tile rather than a corner full of unreadable slivers.
const MIN_SHARE = 0.008
const MIN_VISIBLE = 3
const MAX_TILES = 20
// Cells smaller than this in either dimension aren't rendered — they'd be an
// invisible sliver. A safety net; aggregation keeps real holdings well above it.
const MIN_TILE_PX = 5

type Box = { left: number; top: number; w: number; h: number }
type Cell =
  | { kind: 'asset'; value: number; balance: AddressBalance }
  | { kind: 'other'; value: number; members: AddressBalance[] }

// Share as a compact percentage. Tiny holdings collapse to "<0.1%" rather than a
// misleading "0.0%"; larger ones drop the decimal to stay short on small tiles.
function pctStr(share: number): string {
  const p = share * 100
  if (p < 0.1) return '<0.1%'
  return p.toFixed(p < 10 ? 1 : 0) + '%'
}

function assetName(b: AddressBalance): string {
  return b.asset.name ?? `#${b.asset.assetId}`
}

// Progressive tile-face content, revealed only when it comfortably fits so text is
// never clipped mid-glyph. The full breakdown always lives in the detail card.
function TileFace({ balance, share, w, h }: { balance: AddressBalance; share: number; w: number; h: number }) {
  const a = balance.asset
  const big = w >= 132 && h >= 96
  const med = !big && w >= 96 && h >= 62
  const canIcon = w >= 40 && h >= 46
  const showSym = w >= 50
  const iconSize = big ? 30 : med ? 24 : 20
  if (!canIcon && !showSym) return null
  return (
    <span className="tm-face">
      {canIcon
        ? <span className="tm-top">
            <AssetIcon assetId={a.assetId} iconAssetId={a.iconAssetId} symbol={a.symbol} size={iconSize} parachainId={a.parachainId} origin={a.origin} />
            {showSym && <span className="tm-sym">{a.symbol}</span>}
          </span>
        : showSym && <span className="tm-sym">{a.symbol}</span>}
      {big && <span className="tm-name">{assetName(balance)}</span>}
      {(big || med) && <span className="tm-val">{F.usd(balance.valueUsd)}</span>}
      {(big || med) && <span className="tm-pct">{pctStr(share)}</span>}
    </span>
  )
}

function OtherFace({ count, value, share, w, h }: { count: number; value: number; share: number; w: number; h: number }) {
  const big = w >= 132 && h >= 96
  const med = !big && w >= 96 && h >= 62
  const showSym = w >= 46 && h >= 22
  if (!showSym) return null
  return (
    <span className="tm-face">
      <span className="tm-top"><span className="tm-sym">Other</span></span>
      {big && <span className="tm-name">{count} smaller assets</span>}
      {(big || med) && <span className="tm-val">{F.usd(value)}</span>}
      {(big || med) && <span className="tm-pct">{pctStr(share)}</span>}
    </span>
  )
}

type TileHandlers = { active: boolean; pinned: boolean; onHover: () => void; onLeave: () => void; onSelect: () => void }

// Shared presentational shell. Content is absolutely positioned (see `.tm-face`)
// so a tile can shrink to any width without its padding forcing a minimum size
// and spilling past the map edge; the color drives tint, border and share-bar
// through the `--tile` custom property.
function TileButton({ color, isOther, label, box, active, pinned, onHover, onLeave, onSelect, children }: {
  color: string; isOther?: boolean; label: string; box: Box; children: React.ReactNode
} & TileHandlers) {
  return (
    <button
      type="button"
      className={'tm-tile' + (isOther ? ' tm-other' : '') + (active ? ' active' : '')}
      style={{ left: box.left, top: box.top, width: box.w, height: box.h, ['--tile' as string]: color }}
      aria-label={label}
      aria-pressed={pinned}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onFocus={onHover}
      onBlur={onLeave}
      onClick={onSelect}
    >
      {children}
      <span className="tm-bar" aria-hidden="true" />
    </button>
  )
}

// Asset tile — its own component so it can resolve its icon-derived color via the
// hook (which must run unconditionally).
function AssetTile({ balance, share, box, ...handlers }: { balance: AddressBalance; share: number; box: Box } & TileHandlers) {
  const color = useIconColor(balance.asset, assetBrandColor(balance.asset.symbol))
  const label = `${balance.asset.symbol} — ${F.usd(balance.valueUsd)}, ${pctStr(share)} of valued holdings`
  return (
    <TileButton color={color} label={label} box={box} {...handlers}>
      <TileFace balance={balance} share={share} w={box.w} h={box.h} />
    </TileButton>
  )
}

// Aggregated dust tile — neutral, no icon to sample, so no color hook.
function OtherTile({ value, share, count, box, ...handlers }: { value: number; share: number; count: number; box: Box } & TileHandlers) {
  const label = `Other — ${F.usd(value)}, ${pctStr(share)} across ${count} smaller assets`
  return (
    <TileButton color="var(--text-lowest)" isOther label={label} box={box} {...handlers}>
      <OtherFace count={count} value={value} share={share} w={box.w} h={box.h} />
    </TileButton>
  )
}

function Metric({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="tm-metric">
      <span className="tm-metric-label">{label}</span>
      <span className={'tm-metric-value' + (strong ? ' strong' : '')}>{value}</span>
    </div>
  )
}

function AssetChip({ balance, value }: { balance: AddressBalance; value?: string }) {
  const a = balance.asset
  return (
    <Link to={paths.asset(a.assetId)} className="tm-chip">
      <AssetIcon assetId={a.assetId} iconAssetId={a.iconAssetId} symbol={a.symbol} size={18} parachainId={a.parachainId} origin={a.origin} />
      {a.symbol}
      {value && <span className="tm-chip-val">{value}</span>}
    </Link>
  )
}

// The docked inspector for the active tile — the treemap's tooltip, kept below the
// map (rather than floating) so it never clips at a container edge on mobile and
// reads the same on hover, keyboard focus, and tap.
function TileDetail({ balance, share }: { balance: AddressBalance; share: number }) {
  const a = balance.asset
  const tokens = F.num(balance.total, a.decimals)
  const price = balance.valueUsd != null && tokens > 0 ? balance.valueUsd / tokens : null
  return (
    <div className="tm-detail" aria-live="polite">
      <div className="tm-detail-head">
        <AssetIcon assetId={a.assetId} iconAssetId={a.iconAssetId} symbol={a.symbol} size={26} parachainId={a.parachainId} origin={a.origin} />
        <div className="tm-detail-id">
          <span className="tm-detail-sym">{a.symbol}</span>
          <span className="tm-detail-name">{assetName(balance)}</span>
        </div>
        <Link to={paths.asset(a.assetId)} className="tm-detail-link">View asset →</Link>
      </div>
      <div className="tm-detail-grid">
        <Metric label="Value" value={F.usd(balance.valueUsd)} strong />
        <Metric label="Share" value={pctStr(share)} />
        <Metric label="Free" value={F.amount(balance.free, a.decimals)} />
        <Metric label="Reserved" value={F.amount(balance.reserved, a.decimals)} />
        <Metric label="Price" value={F.priceUsd(price)} />
      </div>
    </div>
  )
}

// Detail for the aggregated "Other" tile: the smaller holdings listed as chips so
// none of them is hidden.
function OtherDetail({ members, value, share }: { members: AddressBalance[]; value: number; share: number }) {
  return (
    <div className="tm-detail" aria-live="polite">
      <div className="tm-detail-head">
        <div className="tm-detail-id">
          <span className="tm-detail-sym">Other holdings</span>
          <span className="tm-detail-name">{members.length} assets · {F.usd(value)} · {pctStr(share)}</span>
        </div>
      </div>
      <div className="tm-chips tm-chips-scroll">
        {members.map(b => <AssetChip key={b.asset.assetId} balance={b} value={F.usd(b.valueUsd)} />)}
      </div>
    </div>
  )
}

function UnpricedStrip({ balances }: { balances: AddressBalance[] }) {
  return (
    <div className="tm-unpriced">
      <span className="tm-unpriced-cap">{balances.length} asset{balances.length === 1 ? '' : 's'} without a market price</span>
      <div className="tm-chips">
        {balances.map(b => <AssetChip key={b.asset.assetId} balance={b} />)}
      </div>
    </div>
  )
}

export function BalancesTreemap({ balances }: { balances: AddressBalance[] }) {
  const priced = useMemo(
    () => balances.filter(b => b.valueUsd != null && b.valueUsd > 0).sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0)),
    [balances],
  )
  const unpriced = useMemo(() => balances.filter(b => !(b.valueUsd != null && b.valueUsd > 0)), [balances])
  const total = useMemo(() => priced.reduce((s, b) => s + (b.valueUsd ?? 0), 0), [priced])

  // Split into the significant head and a dust tail; the tail (any size) becomes
  // one "Other" cell so the map stays readable. Shares are always of the full
  // total, so the tiles + Other still sum to 100%.
  const cells = useMemo<Cell[]>(() => {
    if (!priced.length || total <= 0) return []
    let cut = priced.findIndex(b => (b.valueUsd as number) / total < MIN_SHARE)
    if (cut === -1) cut = priced.length
    cut = Math.min(Math.max(cut, Math.min(priced.length, MIN_VISIBLE)), MAX_TILES)
    const head = priced.slice(0, cut)
    const tail = priced.slice(cut)
    const out: Cell[] = head.map(b => ({ kind: 'asset', value: b.valueUsd as number, balance: b }))
    if (tail.length) out.push({ kind: 'other', value: tail.reduce((s, b) => s + (b.valueUsd as number), 0), members: tail })
    return out
  }, [priced, total])

  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Taller, near-square box on phones so tiles stay tap-sized; wider and capped on
  // desktop. Squarify runs on the real measured box, so aspect ratios stay sane.
  const height = width === 0 ? 0 : width < 560 ? Math.round(Math.max(width * 1.05, 420)) : Math.round(Math.min(Math.max(width * 0.5, 340), 560))
  const rects = useMemo(() => squarify(cells.map(c => c.value), width, height), [cells, width, height])

  const [hover, setHover] = useState<number | null>(null)
  const [pinned, setPinned] = useState<number | null>(null)
  const active = hover ?? pinned ?? (cells.length ? 0 : null)
  const activeCell = active != null ? cells[active] : null

  if (priced.length === 0 && unpriced.length === 0) {
    return (
      <>
        <div className="sec-title">Balances · 0 assets</div>
        <div className="panel tm-panel tm-empty">No balances observed</div>
      </>
    )
  }

  return (
    <>
      <div className="sec-title">Balances · {balances.length} assets</div>
      <div className="panel tm-panel">
        {cells.length > 0 && (
          <div className="tm" ref={ref} style={{ height: height || undefined, minHeight: 320 }} role="group" aria-label="Balances by value">
            {width > 0 && cells.map((cell, i) => {
              const r = rects[i]
              if (!r) return null
              // Tiles sit flush (separated only by their hairline borders) and are
              // clamped to the container so none can spill past the map's edge.
              const left = r.x
              const top = r.y
              const box: Box = { left, top, w: Math.max(0, Math.min(r.w, width - left)), h: Math.max(0, Math.min(r.h, height - top)) }
              if (box.w < MIN_TILE_PX || box.h < MIN_TILE_PX) return null
              const handlers = {
                active: active === i,
                pinned: pinned === i,
                onHover: () => setHover(i),
                onLeave: () => setHover(h => (h === i ? null : h)),
                onSelect: () => setPinned(p => (p === i ? null : i)),
              }
              return cell.kind === 'other'
                ? <OtherTile key="__other" value={cell.value} share={cell.value / total} count={cell.members.length} box={box} {...handlers} />
                : <AssetTile key={cell.balance.asset.assetId} balance={cell.balance} share={cell.value / total} box={box} {...handlers} />
            })}
          </div>
        )}
        {activeCell?.kind === 'asset' && <TileDetail balance={activeCell.balance} share={activeCell.value / total} />}
        {activeCell?.kind === 'other' && <OtherDetail members={activeCell.members} value={activeCell.value} share={activeCell.value / total} />}
        {unpriced.length > 0 && <UnpricedStrip balances={unpriced} />}
      </div>
    </>
  )
}
