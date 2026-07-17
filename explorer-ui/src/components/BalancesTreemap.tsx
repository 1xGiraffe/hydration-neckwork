import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { F, AssetIcon } from './ui'
import { AssetBalanceChart } from './BalanceHistory'
import { useQueryValue, setQuery } from '../router'
import { squarify } from '../utils/squarify'
import { useAssetColor } from '../utils/iconColor'
import type { AddressBalance, AssetBalanceHistory, AssetRef } from '../types'

// Balances rendered as a value-weighted treemap that doubles as the selector for
// the per-asset balance history: each holding is a tile sized by its USD value
// and tinted with its own brand color (sampled from the token's icon), so the
// wallet's composition reads at a glance. Focusing a tile (or a row below the
// map) shows that asset — its value, amount and reserved lock, then its
// balance-history graph. Hovering a tile previews it; clicking locks the focus so
// hovering elsewhere no longer changes it (click the locked tile again to unlock).
// A long tail of dust holdings collapses into one "Other" tile; assets with no
// market price and assets held only in the past sit in the selectable rows
// beneath. The locked asset deep-links via ?asset=<assetId>.
// Replaces the old balances table + separate balance-history section.

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
// The focused selection: a concrete asset, or the aggregated "Other" dust tile.
type Sel = { kind: 'asset'; id: number } | { kind: 'other' }
function selEq(a: Sel | null, b: Sel | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  return a.kind === 'asset' ? a.id === (b as { id: number }).id : true
}

// Share as a compact percentage. Tiny holdings collapse to "<0.1%" rather than a
// misleading "0.0%"; larger ones drop the decimal to stay short on small tiles.
function pctStr(share: number): string {
  const p = share * 100
  if (p < 0.1) return '<0.1%'
  return p.toFixed(p < 10 ? 1 : 0) + '%'
}

function assetName(a: AssetRef): string {
  return a.name ?? `#${a.assetId}`
}

// A raw integer amount string is non-zero (has a reserved/held portion) when it
// carries any non-zero digit — avoids Number() precision loss on 128-bit values.
function isPositiveRaw(raw: string | null | undefined): boolean {
  return raw != null && /[1-9]/.test(raw)
}

// Small padlock — hover reveals the reserved amount. Only shown when the asset
// actually has a reserved balance.
function LockIcon({ title }: { title: string }) {
  return (
    <span className="tm-lock" title={title} role="img" aria-label={title}>
      <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5Zm3 8H9V6a3 3 0 0 1 6 0v3Z" />
      </svg>
    </span>
  )
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
            {showSym && (
              <span className="tm-id">
                <span className="tm-sym">{a.symbol}</span>
                {big && <span className="tm-name">{assetName(a)}</span>}
              </span>
            )}
          </span>
        : showSym && <span className="tm-sym">{a.symbol}</span>}
      {(big || med) && <span className="tm-pct">{pctStr(share)}</span>}
      {(big || med) && <span className="tm-val">{F.usd(balance.valueUsd)}</span>}
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
      <span className="tm-top">
        <span className="tm-id">
          <span className="tm-sym">Other</span>
          {big && <span className="tm-name">{count} smaller assets</span>}
        </span>
      </span>
      {(big || med) && <span className="tm-pct">{pctStr(share)}</span>}
      {(big || med) && <span className="tm-val">{F.usd(value)}</span>}
    </span>
  )
}

type TileHandlers = { active: boolean; locked: boolean; onSelect: () => void; onHover: () => void; onLeave: () => void }

// Shared presentational shell. Content is absolutely positioned (see `.tm-face`)
// so a tile can shrink to any width without its padding forcing a minimum size
// and spilling past the map edge; the color drives tint, border and share-bar
// through the `--tile` custom property. Hovering (or keyboard-focusing) previews;
// clicking locks — `aria-pressed` tracks the lock, `active` the visible focus.
function TileButton({ color, isOther, label, box, active, locked, onSelect, onHover, onLeave, children }: {
  color: string; isOther?: boolean; label: string; box: Box; children: React.ReactNode
} & TileHandlers) {
  return (
    <button
      type="button"
      className={'tm-tile' + (isOther ? ' tm-other' : '') + (active ? ' active' : '')}
      style={{ left: box.left, top: box.top, width: box.w, height: box.h, ['--tile' as string]: color }}
      aria-label={label}
      aria-pressed={locked}
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
  const color = useAssetColor(balance.asset)
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

function Metric({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="tm-metric">
      <span className="tm-metric-label">{label}</span>
      <span className={'tm-metric-value' + (strong ? ' strong' : '')}>{value}</span>
    </div>
  )
}

// A selectable asset chip (rows below the map, and the "Other" breakdown). Clicking
// focuses the asset above rather than navigating away.
function SelectChip({ asset, value, active, onSelect }: { asset: AssetRef; value?: string; active: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={'tm-chip' + (active ? ' on' : '')} aria-pressed={active} onClick={onSelect}>
      <AssetIcon assetId={asset.assetId} iconAssetId={asset.iconAssetId} symbol={asset.symbol} size={18} parachainId={asset.parachainId} origin={asset.origin} />
      {asset.symbol}
      {value && <span className="tm-chip-val">{value}</span>}
    </button>
  )
}

// Latest timestamp at which the asset still had a non-zero balance (points are
// time-ordered), used to label a historically-held asset in the detail.
function lastHeldDate(hist: AssetBalanceHistory | null): string | null {
  if (!hist) return null
  let ts: string | null = null
  for (const p of hist.points) if (p.balance > 0) ts = p.ts
  return ts
}

// The docked inspector for the focused asset — value, the free+reserved amount
// (with a reserved lock), then that asset's balance-history graph. Kept below the
// map so it never clips at a container edge and reads the same on click and tap.
// Adapts when value/amount don't apply: unpriced holdings omit value, and assets
// held only in the past show a "last held" note in place of a live amount.
function FocusedDetail({ balance, hist, allHistory }: {
  balance: AddressBalance | null; hist: AssetBalanceHistory | null; allHistory: AssetBalanceHistory[]
}) {
  const asset = balance?.asset ?? hist?.asset
  if (!asset) return null
  const priced = balance != null && balance.valueUsd != null && balance.valueUsd > 0
  const hasReserved = isPositiveRaw(balance?.reserved)
  const lastHeld = balance == null ? lastHeldDate(hist) : null
  return (
    <div className="tm-detail" aria-live="polite">
      <div className="tm-detail-head">
        <AssetIcon assetId={asset.assetId} iconAssetId={asset.iconAssetId} symbol={asset.symbol} size={26} parachainId={asset.parachainId} origin={asset.origin} />
        <div className="tm-detail-id">
          <span className="tm-detail-sym">{asset.symbol}</span>
          <span className="tm-detail-name">{assetName(asset)}</span>
        </div>
      </div>
      {balance != null ? (
        <div className="tm-detail-grid">
          {priced && <Metric label="Value" value={F.usd(balance.valueUsd)} strong />}
          <Metric
            label="Amount"
            strong={!priced}
            value={<span className="tm-amt">
              {F.amount(balance.total, asset.decimals)}<span className="tm-amt-sym">{asset.symbol}</span>
              {hasReserved && <LockIcon title={`Reserved ${F.amount(balance.reserved, asset.decimals)} ${asset.symbol}`} />}
            </span>}
          />
        </div>
      ) : (
        <div className="tm-detail-note">Not currently held{lastHeld ? ` · last held ${lastHeld.slice(0, 10)}` : ''}</div>
      )}
      {hist
        ? <AssetBalanceChart selected={hist} all={allHistory} />
        : <div className="tm-hist">
            <div className="tm-hist-head"><span className="tm-metric-label">Balance history</span></div>
            <div className="muted" style={{ padding: '16px 0', fontFamily: 'GeistMono', fontSize: 12 }}>No balance history indexed.</div>
          </div>}
    </div>
  )
}

// Detail for the aggregated "Other" tile: the smaller holdings as selectable chips
// so none is hidden and any can be focused (it has no single history of its own).
function OtherDetail({ members, value, share, selectedId, onSelect }: {
  members: AddressBalance[]; value: number; share: number; selectedId: number | null; onSelect: (id: number) => void
}) {
  return (
    <div className="tm-detail" aria-live="polite">
      <div className="tm-detail-head">
        <div className="tm-detail-id">
          <span className="tm-detail-sym">Other holdings</span>
          <span className="tm-detail-name">{members.length} assets · {F.usd(value)} · {pctStr(share)}</span>
        </div>
      </div>
      <div className="tm-chips tm-chips-scroll">
        {members.map(b => (
          <SelectChip key={b.asset.assetId} asset={b.asset} value={F.usd(b.valueUsd)} active={selectedId === b.asset.assetId} onSelect={() => onSelect(b.asset.assetId)} />
        ))}
      </div>
    </div>
  )
}

// Selectable rows beneath the map + graph: current holdings that have no market
// price (can't be sized by value), and assets held only in the past (have a
// balance history but no current holding). Selecting one focuses it above.
function BalanceRows({ unpriced, historical, selectedId, onSelect }: {
  unpriced: AddressBalance[]; historical: AssetBalanceHistory[]; selectedId: number | null; onSelect: (id: number) => void
}) {
  return (
    <div className="tm-unpriced">
      {unpriced.length > 0 && (
        <div className="tm-rowgroup">
          <span className="tm-unpriced-cap">{unpriced.length} asset{unpriced.length === 1 ? '' : 's'} without a market price</span>
          <div className="tm-chips">
            {unpriced.map(b => (
              <SelectChip key={b.asset.assetId} asset={b.asset} active={selectedId === b.asset.assetId} onSelect={() => onSelect(b.asset.assetId)} />
            ))}
          </div>
        </div>
      )}
      {historical.length > 0 && (
        <div className="tm-rowgroup">
          <span className="tm-unpriced-cap">{historical.length} historically held asset{historical.length === 1 ? '' : 's'}</span>
          <div className="tm-chips">
            {historical.map(h => (
              <SelectChip key={h.asset.assetId} asset={h.asset} active={selectedId === h.asset.assetId} onSelect={() => onSelect(h.asset.assetId)} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function BalancesTreemap({ balances, balanceHistory = [] }: { balances: AddressBalance[]; balanceHistory?: AssetBalanceHistory[] }) {
  const priced = useMemo(
    () => balances.filter(b => b.valueUsd != null && b.valueUsd > 0).sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0)),
    [balances],
  )
  const unpriced = useMemo(() => balances.filter(b => !(b.valueUsd != null && b.valueUsd > 0)), [balances])
  const total = useMemo(() => priced.reduce((s, b) => s + (b.valueUsd ?? 0), 0), [priced])

  // Historically held: an asset with a balance history but no current holding —
  // it dropped out of the treemap, so it only reachable through its own row.
  const currentIds = useMemo(() => new Set(balances.map(b => b.asset.assetId)), [balances])
  const historical = useMemo(
    () => balanceHistory.filter(h => !currentIds.has(h.asset.assetId) && h.points.length >= 1),
    [balanceHistory, currentIds],
  )
  const historyById = useMemo(() => new Map(balanceHistory.map(h => [h.asset.assetId, h])), [balanceHistory])
  const balanceById = useMemo(() => new Map(balances.map(b => [b.asset.assetId, b])), [balances])

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
  const otherCell = cells.find(c => c.kind === 'other') as Extract<Cell, { kind: 'other' }> | undefined

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

  // The LOCKED asset is deep-linked via ?asset= (clicking a tile locks it, so it
  // survives a hover elsewhere and is shareable). Hover is a transient preview
  // that only applies while nothing is locked. The visible focus is the lock, else
  // the hover, else the default (largest priced holding, else the first asset in
  // any group).
  const rawParam = useQueryValue('asset', '')
  const defaultId = priced[0]?.asset.assetId ?? unpriced[0]?.asset.assetId ?? historical[0]?.asset.assetId ?? null
  const selectableIds = useMemo(
    () => new Set<number>([...balances.map(b => b.asset.assetId), ...historical.map(h => h.asset.assetId)]),
    [balances, historical],
  )
  const locked: Sel | null = useMemo(() => {
    if (rawParam === 'other' && otherCell) return { kind: 'other' }
    const id = Number(rawParam)
    if (rawParam !== '' && Number.isFinite(id) && selectableIds.has(id)) return { kind: 'asset', id }
    return null
  }, [rawParam, otherCell, selectableIds])
  const [hover, setHover] = useState<Sel | null>(null)
  const active: Sel | null = locked ?? hover ?? (defaultId != null ? { kind: 'asset', id: defaultId } : null)
  const lockedVal: number | 'other' | null = locked?.kind === 'other' ? 'other' : locked?.kind === 'asset' ? locked.id : null

  // Click toggles the lock: clicking the locked cell unlocks it (and keeps it
  // previewed under the pointer); clicking any other cell locks that one.
  const select = (v: number | 'other', cell: Sel) => {
    if (v === lockedVal) setHover(cell)
    setQuery({ asset: v === lockedVal ? null : String(v) })
  }
  // While something is locked, hovering must not change the focus. "Other" is an
  // aggregate with no single graph, so it isn't hover-previewed — that would swap
  // the (fixed-height) graph for a short chip list and make the section jump as
  // the pointer crosses the small dust tile. It stays inspectable on click.
  const preview = (cell: Sel) => { if (locked == null && cell.kind !== 'other') setHover(cell) }
  const unpreview = (cell: Sel) => { if (locked == null) setHover(h => (selEq(h, cell) ? null : h)) }

  if (priced.length === 0 && unpriced.length === 0 && historical.length === 0) {
    // No section heading — the Balances tab already labels this view and its count.
    return <div className="panel tm-panel tm-empty">No balances observed</div>
  }

  const activeId = active?.kind === 'asset' ? active.id : null
  // Rows/chips lock on click (no hover preview), so their toggle passes their own
  // cell for the unlock-keeps-preview path.
  const selectAsset = (id: number) => select(id, { kind: 'asset', id })

  return (
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
              const cellSel: Sel = cell.kind === 'other' ? { kind: 'other' } : { kind: 'asset', id: cell.balance.asset.assetId }
              const cellVal: number | 'other' = cell.kind === 'other' ? 'other' : cell.balance.asset.assetId
              const handlers = {
                active: selEq(active, cellSel),
                locked: selEq(locked, cellSel),
                onSelect: () => select(cellVal, cellSel),
                onHover: () => preview(cellSel),
                onLeave: () => unpreview(cellSel),
              }
              return cell.kind === 'other'
                ? <OtherTile key="__other" value={cell.value} share={cell.value / total} count={cell.members.length} box={box} {...handlers} />
                : <AssetTile key={cell.balance.asset.assetId} balance={cell.balance} share={cell.value / total} box={box} {...handlers} />
            })}
          </div>
        )}
        {active?.kind === 'other' && otherCell
          ? <OtherDetail members={otherCell.members} value={otherCell.value} share={otherCell.value / total} selectedId={activeId} onSelect={selectAsset} />
          : active?.kind === 'asset' && (
            <FocusedDetail balance={balanceById.get(active.id) ?? null} hist={historyById.get(active.id) ?? null} allHistory={balanceHistory} />
          )}
        {(unpriced.length > 0 || historical.length > 0) && (
          <BalanceRows unpriced={unpriced} historical={historical} selectedId={activeId} onSelect={selectAsset} />
        )}
    </div>
  )
}
