/* eslint-disable react-refresh/only-export-components -- shared atoms + formatters module */
import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { Link, paths, navigate } from '../router'
import type { AccountRef, AssetOrigin, AssetRef } from '../types'
import { parseUtcTimestamp } from '../utils/time'
import { useMediaQuery } from '../hooks/useMediaQuery'

/* ============ shared formatters ============ */
const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉'
const subscript = (n: number) => String(n).split('').map(d => SUBSCRIPT[+d]).join('')

// Subscript-zero notation for very small prices (CoinGecko / DexTools style):
//   0.0000007191 → "0.0₅7191"  (1 shown zero + 5 collapsed zeros)
function tinyPrice(price: number): string {
  const leadingZeros = -Math.floor(Math.log10(price)) - 1
  const factor = 10 ** (leadingZeros + 4)
  let sig = String(Math.round(price * factor))
  // Rounding can bump us up a power of 10 (9.9999e-7 → "10000"); fall back to plain.
  if (sig.length !== 4) return price.toFixed(leadingZeros + 4).replace(/\.?0+$/, '')
  sig = sig.replace(/0+$/, '') || '0'
  return '0.0' + subscript(leadingZeros - 1) + sig
}

// Graduated price precision, mirroring preis-ui's formatPrice (without the $ prefix).
function priceStr(price: number): string {
  if (price <= 0) return '0'
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (price >= 100) return price.toFixed(1)
  if (price >= 1) return price.toFixed(2)
  if (price >= 0.01) return price.toFixed(4)
  if (price >= 0.001) return price.toPrecision(4).replace(/\.?0+$/, '')
  return tinyPrice(price)
}

// Collapse large magnitudes (≥ 1e6) into M/B/T/Q suffixes: 44.07B, 1.2T.
// Beyond quadrillion, fall back to scientific notation (e.g. 1.05e+18).
const BIG_UNITS = ['M', 'B', 'T', 'Q']
function compact(v: number): string {
  let n = v / 1e6
  let u = 0
  while (n >= 1000 && u < BIG_UNITS.length - 1) { n /= 1000; u++ }
  if (n >= 1000) return v.toExponential(2)
  return n.toFixed(2).replace(/\.?0+$/, '') + BIG_UNITS[u]
}
function compactCount(v: number): string {
  if (!Number.isFinite(v)) return '0'
  const abs = Math.abs(v)
  if (abs >= 1e6) return compact(v)
  if (abs >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'
  return Math.round(v).toLocaleString('en-US')
}
export const F = {
  int: (n: number) => (Number.isFinite(n) ? n : 0).toLocaleString('en-US'),
  count: compactCount,
  shortHash: (h?: string | null) => !h ? '—' : h.length > 18 ? h.slice(0, 8) + '…' + h.slice(-6) : h,
  shortAddr: (a?: string | null) => !a ? '—' : a.length > 14 ? a.slice(0, 6) + '…' + a.slice(-5) : a,
  amount: (raw: string | null | undefined, dec: number) => {
    if (raw == null || raw === '') return '—'
    const v = Number(raw) / 10 ** dec
    if (!Number.isFinite(v)) return '—'
    if (v >= 1e6) return compact(v)
    if (v >= 1e3) return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
    if (v === 0) return '0'
    if (v >= 1) return v.toFixed(4)
    return v.toFixed(6)
  },
  num: (raw: string | null | undefined, dec: number): number => {
    if (raw == null || raw === '') return 0
    const v = Number(raw) / 10 ** dec
    return Number.isFinite(v) ? v : 0
  },
  usd: (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return '—'
    if (v >= 1e6) return '$' + compact(v)
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'k'
    return '$' + v.toFixed(2)
  },
  priceUsd: (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return '—'
    return '$' + priceStr(v)
  },
  pct: (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return '—'
    const p = v * 100
    return (p >= 0 ? '+' : '') + p.toFixed(2) + '%'
  },
  hdxFee: (raw: string | null | undefined) => {
    if (raw == null || raw === '') return '—'
    const v = Number(raw) / 1e12
    if (!Number.isFinite(v) || v === 0) return '0 HDX'
    return (v < 0.001 ? '<0.001' : v.toFixed(v < 1 ? 4 : 3)) + ' HDX'
  },
  ago: (ts: string, now = Date.now()) => {
    const t = parseUtcTimestamp(ts); if (!Number.isFinite(t)) return '—'
    const s = Math.max(0, Math.floor((now - t) / 1000))
    if (s < 60) return s + 's ago'
    const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + (s % 60) + 's ago'
    const h = Math.floor(m / 60); if (h < 24) return h + 'h ' + (m % 60) + 'm ago'
    const d = Math.floor(h / 24); return d + 'd ' + (h % 24) + 'h ago'
  },
  datetime: (ts: string) => {
    const t = parseUtcTimestamp(ts); if (!Number.isFinite(t)) return ts
    const d = new Date(t)
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const p = (n: number) => String(n).padStart(2, '0')
    return `${days[d.getUTCDay()]} ${p(d.getUTCDate())} ${mon[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`
  },
}

// Short ISO date (YYYY-MM-DD) from an indexer UTC timestamp, '' when unparseable.
// Shared by the chart tooltips (AreaChart, BalanceHistory).
function tsDate(ts: string): string {
  const t = parseUtcTimestamp(ts)
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ''
}

// Per-point x fraction (0..1) for a chart. Proportional to time when every point
// has a parseable, non-decreasing date with a positive overall span; otherwise
// evenly spaced by index.
function timeFractions(n: number, dates?: string[]): number[] {
  const byIndex = Array.from({ length: n }, (_, i) => i / (n - 1))
  if (!dates || dates.length !== n) return byIndex
  const ts = dates.map(parseUtcTimestamp)
  const span = ts[n - 1] - ts[0]
  if (!(span > 0)) return byIndex
  for (let i = 0; i < n; i++) if (!Number.isFinite(ts[i]) || (i > 0 && ts[i] < ts[i - 1])) return byIndex
  return ts.map(t => (t - ts[0]) / span)
}

// Relative time ("3m ago") that reveals the absolute UTC timestamp on hover.
// Used anywhere a time is shown relative (activity, tables, activity rows).
export function Ago({ ts, now }: { ts: string; now: number }) {
  return <span title={F.datetime(ts)}>{F.ago(ts, now)}</span>
}

// Uniform null/empty placeholder for table cells. Always monospace: a bare
// `.muted` dash inherits the cell's font, and the sans-serif em dash glyph is
// visibly wider than the mono one — same character, looks like two symbols.
export function Dash() {
  return <span className="mono muted">—</span>
}

// Explorer-wide amount convention: leading asset icon, then symbol, then the
// amount — the activity-flow "trade leg" reading order. `formatted` overrides
// the default raw-amount formatting for pre-formatted values.
export function AssetAmount({ asset, raw, formatted }: { asset: AssetRef; raw?: string | null; formatted?: string }) {
  return <span className="trade-leg"><AssetChip asset={asset} /> <span className="mono">{formatted ?? (raw != null ? F.amount(raw, asset.decimals) : '—')}</span></span>
}

// Short address with the final three characters highlighted.
export function ShortAddr({ addr, full }: { addr: string; full?: boolean }) {
  const head = addr.startsWith('0x') ? addr.slice(0, 6) : addr.slice(0, 4)
  const tail = addr.slice(-5)
  const short = <>{head}…{tail.slice(0, 2)}<span className="last3">{tail.slice(-3)}</span></>
  if (!full) return short
  // `full` renders both forms; ≤720px CSS swaps in the middle-ellipsis one so a
  // 42/48-char EVM/SS58 address never wraps the header (Copy keeps the full value).
  return <>
    <span className="addr-full">{addr.slice(0, -3)}<span className="last3">{addr.slice(-3)}</span></span>
    <span className="addr-short">{short}</span>
  </>
}

/* ============ asset logo gradient ============ */
const ASSET_COLORS: Record<string, [string, string]> = {
  HDX: ['#e53e76', '#b454da'], DOT: ['#2C89E9', '#95caff'], USDT: ['#74C742', '#45AC1F'],
  USDC: ['#2C89E9', '#1f5cab'], HOLLAR: ['#b3cf92', '#74C742'], DAI: ['#F7BF06', '#e3ae00'],
  WBTC: ['#F7BF06', '#e3ae00'], iBTC: ['#F7BF06', '#e3ae00'], tBTC: ['#F7BF06', '#e3ae00'], WETH: ['#6e7588', '#a8afc0'],
  vDOT: ['#cc6ef4', '#dfb1f3'], GDOT: ['#2C89E9', '#95caff'], aDOT: ['#cc6ef4', '#dfb1f3'], GLMR: ['#74C742', '#45AC1F'],
  ASTR: ['#ff6868', '#d83b3b'], CFG: ['#dfb1f3', '#cc6ef4'],
}
const PALETTE: [string, string][] = [['#e53e76', '#b454da'], ['#2C89E9', '#95caff'], ['#74C742', '#45AC1F'], ['#cc6ef4', '#dfb1f3'], ['#F7BF06', '#e3ae00'], ['#ff6868', '#d83b3b'], ['#6e7588', '#a8afc0'], ['#b3cf92', '#74C742']]
// Aave aTokens (aUSDC, aUSDT, aEURC…) wrap an underlying token — color them as the
// underlying (aUSDC reads like USDC) rather than hashing the wrapped symbol to a
// distinct color. A curated entry for the aToken itself (e.g. aDOT) still wins.
function underlyingColorSymbol(symbol: string): string {
  return /^a[A-Z]/.test(symbol) ? symbol.slice(1) : symbol
}
function assetGradient(symbol: string): [string, string] {
  if (ASSET_COLORS[symbol]) return ASSET_COLORS[symbol]
  const base = underlyingColorSymbol(symbol)
  if (ASSET_COLORS[base]) return ASSET_COLORS[base]
  let h = 0; for (let i = 0; i < base.length; i++) h = (h + base.charCodeAt(i)) % PALETTE.length
  return PALETTE[h]
}

// A single brand-ish color per asset — the curated color for known tokens, else a
// deterministic palette pick by symbol. Used as the treemap tile fallback when a
// logo's dominant color can't be sampled (see utils/iconColor).
export function assetBrandColor(symbol: string): string {
  return assetGradient(symbol)[0]
}
function AssetLogo({ symbol, size = 20 }: { symbol: string; size?: number }) {
  const [c1, c2] = assetGradient(symbol)
  return <span className="asset-logo" style={{ width: size, height: size, fontSize: size * 0.4, background: `linear-gradient(135deg,${c1},${c2})` }}>{symbol.slice(0, 3)}</span>
}

// Real token icon from the Galactic Council asset-metadata CDN (same source as
// preis-ui), with a gradient-letter fallback on load error.
const ICON_CDN = 'https://cdn.jsdelivr.net/gh/galacticcouncil/intergalactic-asset-metadata@master/v2/polkadot/2034/assets'
function iconUrl(id: number, ext: 'svg' | 'png'): string { return `${ICON_CDN}/${id}/icon.${ext}` }
const METADATA_CDN = 'https://cdn.jsdelivr.net/gh/galacticcouncil/intergalactic-asset-metadata@master/v2'
function originAssetIconUrl(origin: AssetOrigin, ext: 'svg' | 'png'): string | null {
  if (!origin.assetId) return null
  const assetKey = origin.ecosystem === 'ethereum' ? origin.assetId.toLowerCase() : origin.assetId
  return `${METADATA_CDN}/${origin.ecosystem}/${origin.chainId}/assets/${assetKey}/icon.${ext}`
}
export function originChainIconUrl(origin: AssetOrigin): string {
  return `${METADATA_CDN}/${origin.ecosystem}/${origin.chainId}/icon.svg`
}

// Hollar-wrapped stablecoins (HUSDC, HUSDT, …) have no icon of their own. preis-ui
// renders them as a composite half-icon: left = HOLLAR (222), right = the wrapped
// underlying (HUSDC → USDC). [leftId, rightId] — mirrors preis-ui COMPOSITE_ICONS.
const COMPOSITE_ICONS: Record<number, [number, number]> = {
  1110: [222, 22],      // HUSDC = HOLLAR + USDC
  1111: [222, 10],      // HUSDT = HOLLAR + USDT
  1112: [222, 1112],    // HUSDS = HOLLAR + USDS (no icon yet → letter half)
  1113: [222, 1000625], // HUSDe = HOLLAR + sUSDe
  4444: [222, 44],      // HEURC = HOLLAR + EURC
}
// Avoid noisy browser-level blocked requests for assets whose CDN icon format is
// known from the current Hydration registry. Missing icons go straight to the
// local gradient fallback; PNG-only icons skip the missing SVG request.
const PNG_ICON_IDS = new Set([
  4, 20, 35, 36, 38, 39, 43, 1000085, 1000189, 1000794, 1000796, 1000809,
  1000286, 1000324, 1000365, 1000397, 1000479, 1000512, 1000524, 1000779,
])
const NO_CDN_ICON_IDS = new Set([
  29, 37, 45, 100, 101, 102, 110, 670, 1112, 1000198, 1000444, 1000746, 1000766, 1000767, 1001034, 1001168,
])
function initialIconMode(srcId: number): 'svg' | 'png' | 'fail' {
  if (NO_CDN_ICON_IDS.has(srcId)) return 'fail'
  if (PNG_ICON_IDS.has(srcId)) return 'png'
  return 'svg'
}

// Composite (Hollar-wrapped) and locally-known-missing assets have no single CDN
// icon to sample a color from — callers should skip them and use a fallback color
// rather than firing a request that only 404s.
export function iconIsSampleable(assetId: number): boolean {
  return !(assetId in COMPOSITE_ICONS) && !NO_CDN_ICON_IDS.has(assetId)
}

// A single CDN <img> with the svg→png→letter fallback chain. The load state is
// reset whenever the resolved icon id changes (a row's AssetIcon is reused across
// re-renders while the underlying asset changes after a data fetch — without the
// reset its `mode` stays stale at 'fail'/'png' and the new asset never re-attempts
// svg, so the icon only appears after a manual refresh).
export function assetIconCandidates(srcId: number, origin?: AssetOrigin | null): string[] {
  const out: string[] = []
  // Like Hydration UI, globally-consensused assets use their canonical origin
  // contract icon. Keep the local Hydration icon as a fallback for incomplete
  // external metadata. Polkadot-origin assets continue using the curated local
  // icon and get only an origin-chain badge.
  if (origin?.ecosystem === 'ethereum') {
    for (const ext of ['svg', 'png'] as const) {
      const url = originAssetIconUrl(origin, ext)
      if (url) out.push(url)
    }
  }
  const initial = initialIconMode(srcId)
  if (initial === 'svg') out.push(iconUrl(srcId, 'svg'), iconUrl(srcId, 'png'))
  else if (initial === 'png') out.push(iconUrl(srcId, 'png'))
  return out
}

function CdnIcon({ srcId, symbol, size, clip, origin }: { srcId: number; symbol: string; size: number; clip?: 'left' | 'right'; origin?: AssetOrigin | null }) {
  const candidates = assetIconCandidates(srcId, origin)
  const sourceKey = `${srcId}:${origin?.ecosystem ?? ''}:${origin?.chainId ?? ''}:${origin?.assetId ?? ''}`
  const [fallback, setFallback] = useState<{ key: string; index: number }>({ key: sourceKey, index: 0 })
  const index = fallback.key === sourceKey ? fallback.index : 0
  const src = candidates[index]
  if (!src) {
    return clip ? null : <AssetLogo symbol={symbol} size={size} />
  }
  const style: React.CSSProperties = clip
    ? { position: 'absolute', top: 0, left: 0, width: size, height: size, borderRadius: '50%', objectFit: 'cover', clipPath: clip === 'left' ? 'inset(0 50% 0 0)' : 'inset(0 0 0 50%)' }
    : { width: size, height: size, borderRadius: '50%', objectFit: 'cover' }
  return <img
    className="asset-logo"
    style={style}
    src={src}
    alt=""
    loading="lazy"
    onError={() => setFallback(current => ({ key: sourceKey, index: (current.key === sourceKey ? current.index : 0) + 1 }))}
  />
}

export function AssetIcon({ assetId, iconAssetId, symbol, size = 20, parachainId, origin }: { assetId: number; iconAssetId?: number; symbol: string; size?: number; parachainId?: number | null; origin?: AssetOrigin | null }) {
  // Some assets ship only .svg, others only .png — try svg, then png, then the
  // gradient-letter fallback (same chain as preis-ui). Hollar-wrapped tokens render
  // as a composite half/half icon; aTokens use the icon ID resolved by the API.
  const composite = COMPOSITE_ICONS[assetId]
  const chainOrigin = origin ?? (parachainId != null ? { ecosystem: 'polkadot', chainId: String(parachainId), assetId: null } : null)
  const badgeKey = chainOrigin ? `${chainOrigin.ecosystem}:${chainOrigin.chainId}` : ''
  const [badgeFailure, setBadgeFailure] = useState<{ key: string; failed: boolean }>({ key: badgeKey, failed: false })
  const badgeFailed = badgeFailure.key === badgeKey && badgeFailure.failed
  const body = composite ? (
      <span className="asset-logo" style={{ position: 'relative', width: size, height: size, borderRadius: '50%', overflow: 'hidden', display: 'inline-block', background: assetGradient(symbol)[0] }}>
        <CdnIcon srcId={composite[0]} symbol={symbol} size={size} clip="left" />
        <CdnIcon srcId={composite[1]} symbol={symbol} size={size} clip="right" />
      </span>
    ) : <CdnIcon srcId={iconAssetId ?? assetId} symbol={symbol} size={size} origin={origin} />
  return <span style={{ position: 'relative', width: size, height: size, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', verticalAlign: 'middle', lineHeight: 0 }}>
    {body}
    {chainOrigin && !badgeFailed && <img
      src={originChainIconUrl(chainOrigin)} alt="" aria-hidden="true"
      onError={() => setBadgeFailure({ key: badgeKey, failed: true })}
      style={{ position: 'absolute', right: -2, bottom: -2, width: Math.max(10, Math.round(size * 0.42)), height: Math.max(10, Math.round(size * 0.42)), borderRadius: '50%', border: '1px solid var(--bg)', background: 'var(--bg)', objectFit: 'cover' }}
    />}
  </span>
}

export function AssetChip({ asset, link = true }: { asset: AssetRef; link?: boolean }) {
  const body = <><AssetIcon assetId={asset.assetId} iconAssetId={asset.iconAssetId} symbol={asset.symbol} parachainId={asset.parachainId} origin={asset.origin} /> {asset.symbol}</>
  return link
    ? <Link to={paths.asset(asset.assetId)} className="asset-chip">{body}</Link>
    : <span className="asset-chip">{body}</span>
}

// A compact cluster of top-holding token icons shown after an account/tag value.
// Display-only: each icon carries a value tooltip and the cluster opts out of the
// global hover card so sweeping across a dense row never fires a stray preview.
export function TokenIconRow({ assets, size = 16 }: { assets: { asset: AssetRef; valueUsd?: number | null }[]; size?: number }) {
  if (!assets.length) return null
  return (
    <span className="token-icons" data-no-hover>
      {assets.map(({ asset, valueUsd }) => (
        <span key={asset.assetId} className="token-icons-item" title={valueUsd != null ? `${asset.symbol} — ${F.usd(valueUsd)}` : asset.symbol}>
          <AssetIcon assetId={asset.assetId} iconAssetId={asset.iconAssetId} symbol={asset.symbol} size={size} parachainId={asset.parachainId} origin={asset.origin} />
        </span>
      ))}
    </span>
  )
}

/* ============ account / module / label pill ============ */
const EMOJI_POOL = ['🦊', '🦉', '🦝', '🦌', '🦢', '🐺', '🦅', '🦜', '🐢', '🐝', '🦋', '🐞', '🦂', '🦓', '🦒', '🦔', '🦇', '🐡', '🦈', '🦭', '🦦', '🐌', '🦗', '🦚', '🦩', '🐿️', '🦫', '🐬', '🦏', '🦛', '🐊', '🦣', '🦤', '🦃', '🦙', '🦥']
function emojiFor(seed: string): string {
  let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return EMOJI_POOL[h % EMOJI_POOL.length]
}

// Spell out the snakewatch identity emoji (e.g. 🦈 → "Shark") for account titles.
const EMOJI_NAMES: Record<string, string> = {
  '🐵': 'Monkey', '🐒': 'Monkey', '🦍': 'Gorilla', '🦧': 'Orangutan', '🐶': 'Dog', '🐕': 'Dog', '🦮': 'Guide Dog', '🐕‍🦺': 'Service Dog', '🐩': 'Poodle', '🐺': 'Wolf', '🦊': 'Fox', '🦝': 'Raccoon',
  '🐱': 'Cat', '🐈': 'Cat', '🐈‍⬛': 'Black Cat', '🦁': 'Lion', '🐯': 'Tiger', '🐅': 'Tiger', '🐆': 'Leopard', '🐴': 'Horse', '🐎': 'Horse', '🦄': 'Unicorn', '🦓': 'Zebra', '🦌': 'Deer',
  '🐮': 'Cow', '🐂': 'Ox', '🐃': 'Buffalo', '🐄': 'Cow', '🐷': 'Pig', '🐖': 'Pig', '🐗': 'Boar', '🐽': 'Pig', '🐏': 'Ram', '🐑': 'Sheep', '🐐': 'Goat', '🐪': 'Camel',
  '🐫': 'Camel', '🦙': 'Llama', '🦒': 'Giraffe', '🐘': 'Elephant', '🦏': 'Rhino', '🦛': 'Hippo', '🐭': 'Mouse', '🐁': 'Mouse', '🐀': 'Rat', '🐹': 'Hamster', '🐰': 'Rabbit', '🐇': 'Rabbit',
  '🐿': 'Chipmunk', '🦔': 'Hedgehog', '🦇': 'Bat', '🐻': 'Bear', '🐻‍❄️': 'Polar Bear', '🐨': 'Koala', '🐼': 'Panda', '🦥': 'Sloth', '🦦': 'Otter', '🦨': 'Skunk', '🦘': 'Kangaroo', '🦡': 'Badger',
  '🐾': 'Paws', '🦃': 'Turkey', '🐔': 'Chicken', '🐓': 'Rooster', '🐣': 'Chick', '🐤': 'Chick', '🐥': 'Chick', '🐦': 'Bird', '🐧': 'Penguin', '🕊': 'Dove', '🦅': 'Eagle', '🦆': 'Duck',
  '🦢': 'Swan', '🦉': 'Owl', '🦩': 'Flamingo', '🦚': 'Peacock', '🦜': 'Parrot', '🐸': 'Frog', '🐊': 'Crocodile', '🐢': 'Turtle', '🦎': 'Lizard', '🐍': 'Snake', '🐲': 'Dragon', '🐉': 'Dragon',
  '🦕': 'Sauropod', '🦖': 'T-Rex', '🐬': 'Dolphin', '🐟': 'Fish', '🐠': 'Fish', '🐡': 'Pufferfish', '🦈': 'Shark', '🐙': 'Octopus', '🐚': 'Shell', '🐌': 'Snail', '🦋': 'Butterfly', '🐛': 'Bug',
  '🐜': 'Ant', '🐝': 'Bee', '🐞': 'Ladybug', '🦗': 'Cricket', '🕷': 'Spider', '🦂': 'Scorpion', '🦟': 'Mosquito', '🦠': 'Microbe', '💐': 'Bouquet', '🌸': 'Blossom', '💮': 'Flower', '🏵': 'Rosette',
  '🌹': 'Rose', '🥀': 'Wilted Rose', '🌺': 'Hibiscus', '🌻': 'Sunflower', '🌼': 'Daisy', '🌷': 'Tulip', '🌱': 'Seedling', '🌲': 'Evergreen', '🌳': 'Tree', '🌴': 'Palm Tree', '🌵': 'Cactus', '🌾': 'Rice',
  '🌿': 'Herb', '☘': 'Shamrock', '🍀': 'Clover', '🍁': 'Maple Leaf', '🍂': 'Fallen Leaf', '🍃': 'Leaf', '🍄': 'Mushroom', '🦔️': 'Hedgehog',
}
export function emojiName(emoji?: string | null): string | null {
  if (!emoji) return null
  return EMOJI_NAMES[emoji] ?? EMOJI_NAMES[emoji.replace(/️/g, '')] ?? null
}

// On <img> error, hide the image and reveal its emoji-glyph fallback sibling
// (mirrors preis-ui's showIconFallback so a dead avatar URL degrades gracefully).
export function showIconFallback(e: React.SyntheticEvent<HTMLImageElement>) {
  e.currentTarget.style.display = 'none'
  const fb = e.currentTarget.nextElementSibling
  if (fb instanceof HTMLElement) fb.style.display = ''
}

// The account's omniwatch/snakewatch identity icon. Same fallback chain as
// preis-ui's OmniwatchIcon: custom image (e.g. a Discord avatar) → emoji glyph →
// deterministic gradient-letter emoji. `className` styles the emoji <span>;
// `imgClass` styles the rounded image when an emojiUrl is present.
export function AccountEmoji({ account, className = 'emoji id', imgClass = 'emoji-img', title }: {
  account: { emoji?: string; emojiName?: string; emojiUrl?: string; accountId: string }
  className?: string
  imgClass?: string
  title?: string
}) {
  const glyph = account.emoji || emojiFor(account.accountId)
  const name = account.emojiName ?? emojiName(glyph) ?? undefined
  if (account.emojiUrl) {
    return (
      <span className={className} style={{ padding: 0, overflow: 'hidden' }} title={title ?? name}>
        <img className={imgClass} src={account.emojiUrl} alt={name ?? glyph} title={name} onError={showIconFallback} />
        <span className="icon-fallback" style={{ display: 'none' }}>{glyph}</span>
      </span>
    )
  }
  return <span className={className} title={title ?? name}>{glyph}</span>
}
export function healthFactorDisplay(hf: string): { label: string; cls: string } {
  if (hf === 'unknown') return { label: '—', cls: '' }
  if (hf === 'inf') return { label: 'No debt', cls: '' }
  const v = Number(hf) / 1e18
  if (!Number.isFinite(v)) return { label: '—', cls: '' }
  return { label: v.toFixed(2), cls: v < 1.1 ? 'hf-bad' : v < 1.6 ? 'hf-warn' : 'hf-ok' }
}
export function moduleName(accountId: string): string | null {
  if (!accountId.startsWith('0x6d6f646c')) return null
  const hex = accountId.slice(10)
  let s = ''
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16)
    if (code >= 32 && code <= 126) s += String.fromCharCode(code); else break
  }
  return s.replace(/[^\x20-\x7e]+$/, '').trim() || null
}

// EVM accounts deep-link by their H160 (clean 0x…40 hex), others by accountId.
export function accountHref(account: AccountRef): string {
  // Always link to the human address — EVM 0x for EVM accounts, Polkadot SS58 for
  // substrate — never the raw public-key hex. getAddress resolves both forms.
  return paths.account(account.address)
}

// A tag's icon: an <img> when the icon is a URL/path (starts with / or http),
// otherwise the value is treated as an emoji glyph.
export function TagIcon({ icon, color, size = 20, title }: { icon: string; color?: string; size?: number; title?: string }) {
  const isImg = icon.startsWith('/') || icon.startsWith('http')
  if (isImg) {
    return <span className="emoji id" style={{ borderColor: color, padding: 0, overflow: 'hidden' }} title={title}>
      <img src={icon} alt="" width={size} height={size} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', display: 'block' }} loading="lazy" />
    </span>
  }
  return <span className="emoji id" style={color ? { borderColor: color } : undefined} title={title}>{icon || '🏷️'}</span>
}

export function TagGroupPill({ tag }: { tag: { tagId: string; name: string; color: string; icon: string; memberCount: number } }) {
  return (
    <Link to={paths.tag(tag.tagId)} className="addr-pill" title="Tagged group — open combined view">
      <TagIcon icon={tag.icon} color={tag.color} title={tag.name} />
      <span className="tag" style={{ color: tag.color }}>{tag.name}{tag.memberCount > 1 ? <span className="muted"> ·{tag.memberCount}</span> : null}</span>
    </Link>
  )
}

export function AddrPill({ account, full, noCopy, noTag }: { account: AccountRef; full?: boolean; noCopy?: boolean; noTag?: boolean }) {
  const tag = account.tag
  // Tagged accounts use the group identity as the primary label, matching the
  // Accounts list. `noTag` skips this on tag member lists, where the page context
  // already supplies the group and each row should show the member itself.
  if (tag && !noTag) {
    return (
      <span className="addr-wrap">
        <Link to={paths.tag(tag.id)} className="addr-pill" title="Tagged group — open combined view">
          <TagIcon icon={tag.icon} color={tag.color} title={tag.name} />
          <span className="tag" style={{ color: tag.color }}>{tag.name}</span>
        </Link>
        {!noCopy && <Copy text={account.address} />}
      </span>
    )
  }
  const mod = moduleName(account.accountId)
  if (mod) {
    return (
      <span className="addr-wrap">
        <Link to={accountHref(account)} className="addr-pill" title={account.address}>
          <span className="emoji">⚙️</span><span className="a">{mod}</span>
        </Link>
      </span>
    )
  }
  // On-chain identity (Identity.IdentityOf): show the display name (with a small
  // ✓ when judged Reasonable/KnownGood) instead of the shortened address.
  const identity = account.identity
  if (identity?.display) {
    return (
      <span className="addr-wrap">
        <Link to={accountHref(account)} className="addr-pill" title={account.address}>
          <AccountEmoji account={account} title="identity" />
          <span className="tag">{identity.display}</span>
          {identity.verified && <span className="id-verified" title="Verified identity">✓</span>}
        </Link>
        {!noCopy && <Copy text={account.address} />}
      </span>
    )
  }
  return (
    <span className="addr-wrap">
      <Link to={accountHref(account)} className="addr-pill" title={account.address}>
        <AccountEmoji account={account} title="identity" />
        <span className="a mono"><ShortAddr addr={account.address} full={full} /></span>
      </Link>
      {!noCopy && <Copy text={account.address} />}
    </span>
  )
}

/* ============ call / badges / copy ============ */
export function CallPill({ name }: { name: string }) {
  const [pallet, method = ''] = name.split('.')
  return (
    <span className={`call ${pallet.toLowerCase()}`}>
      <span className="pallet">{pallet}</span><span className="dot">.</span><span className="method">{method}</span>
    </span>
  )
}
export function StatusBadge({ ok }: { ok: boolean }) {
  return ok
    ? <span className="badge ok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>Success</span>
    : <span className="badge fail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>Failed</span>
}
export function VoteSideBadge({ side }: { side: string | null | undefined }) {
  const normalized = (side ?? 'Vote').toLowerCase()
  const col = normalized === 'aye' ? 'var(--green)' : normalized === 'nay' ? 'var(--red)' : 'var(--sky)'
  const label = normalized === 'aye' ? 'AYE' : normalized === 'nay' ? 'NAY' : (side || 'Vote')
  return <span className="pill-badge" style={{ color: col, background: `color-mix(in srgb, ${col} 15%, transparent)` }}>{label}</span>
}
export function FinalizedBadge({ finalized }: { finalized: boolean }) {
  return finalized
    ? <span className="badge finalized"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="9" /></svg>Finalized</span>
    : <span className="badge pending"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>Pending</span>
}
export function Copy({ text }: { text: string }) {
  return (
    <button className="copy" title="Copy" onClick={(e) => { e.stopPropagation(); e.preventDefault(); navigator.clipboard?.writeText(text) }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
    </button>
  )
}

/* ============ charts ============ */
export function Sparkline({ data, w = 110, h = 30, change7d }: { data: number[]; w?: number; h?: number; change7d?: number | null }) {
  const id = useId()
  if (!data || data.length < 2) return <Dash />
  const min = Math.min(...data), max = Math.max(...data)
  const sx = w / (data.length - 1), sy = (v: number) => h - 3 - ((v - min) / ((max - min) || 1)) * (h - 6)
  const line = data.map((v, i) => `${i ? 'L' : 'M'} ${(i * sx).toFixed(1)} ${sy(v).toFixed(1)}`).join(' ')
  // Fill the area down to the baseline so it matches the preis-ui sparkline: a
  // gradient that fades from the line colour to transparent at the bottom.
  const area = `${line} L ${((data.length - 1) * sx).toFixed(1)} ${h} L 0 ${h} Z`
  // Up/down semantics mirror preis-ui: prefer the 7D change when supplied
  // (green ≥0 / red <0 / neutral gray when null), else derive from first→last.
  const dir = change7d === undefined ? (data[data.length - 1] >= data[0] ? 1 : -1) : change7d === null ? 0 : change7d >= 0 ? 1 : -1
  const col = dir === 0 ? 'var(--text-low)' : dir > 0 ? 'var(--green)' : 'var(--red)'
  const fillOpacity = dir === 0 ? 0.3 : dir > 0 ? 0.45 : 0.4
  const gid = `spark-${id}`
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity={fillOpacity} />
          <stop offset="100%" stopColor={col} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} stroke="none" />
      <path d={line} fill="none" stroke={col} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Crosshair tooltip clamped inside its chart wrap: `left` is re-measured after
// every render so an edge hover can't stick out of the card, which made the
// whole page horizontally scrollable on phones. Shared by AreaChart/PriceChart.
export function ChartTip({ xPct, children }: { xPct: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current, wrap = el?.parentElement
    if (!el || !wrap) return
    const half = el.offsetWidth / 2, w = wrap.clientWidth
    const x = w <= half * 2 ? w / 2 : Math.min(Math.max(xPct / 100 * w, half), w - half)
    el.style.left = `${x}px`
  })
  return <div className="apx-tip" ref={ref}>{children}</div>
}

// Area/line chart with an optional target line and a crosshair tooltip on hover.
// `dates` (parallel to `data`) makes the tooltip show the point's date; `valueFmt`
// formats the displayed value (default F.usd, used by the portfolio charts).
export function AreaChart({ data, h = 190, target, color, floor, dates, valueFmt = F.usd }: {
  data: number[]; h?: number; target?: number; color?: string; floor?: number
  dates?: string[]; valueFmt?: (v: number) => string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ xPct: number; yPct: number; val: string; date: string } | null>(null)
  if (!data || data.length < 2) return <div className="muted" style={{ padding: '24px 0', fontFamily: 'GeistMono', fontSize: 12 }}>Not enough history.</div>
  const W = 820, padT = 14, padB = 14
  // `floor` pins the baseline (e.g. 0) so small values don't glue to the bottom.
  const min = floor != null ? floor : Math.min(...data, target ?? Infinity), max = Math.max(...data, target ?? -Infinity)
  // X positions are proportional to TIME when a parseable date accompanies every
  // point (portfolio/balance history buckets cover unequal time spans, so index
  // spacing would distort the shape); index spacing is the fallback.
  const xFrac = timeFractions(data.length, dates)
  // Span the full width edge-to-edge so the line matches the hover crosshair, which
  // maps 0..100% across the container. A horizontal inset would leave the first/last
  // points hoverable (value shown) but with no line drawn at that x.
  const sx = (i: number) => xFrac[i] * W
  const sy = (v: number) => padT + (1 - (v - min) / ((max - min) || 1)) * (h - padT - padB)
  const line = data.map((v, i) => `${i ? 'L' : 'M'} ${sx(i).toFixed(1)} ${sy(v).toFixed(1)}`).join(' ')
  const area = `${line} L ${sx(data.length - 1).toFixed(1)} ${h - padB} L ${sx(0).toFixed(1)} ${h - padB} Z`
  const up = data[data.length - 1] >= data[0]
  const col = color ?? (up ? 'var(--green)' : 'var(--red)')
  const gid = 'ag' + Math.round(min * 1000 + max)

  function onMove(e: ReactPointerEvent) {
    const wrap = wrapRef.current; if (!wrap) return
    const r = wrap.getBoundingClientRect(); if (!r.width) return
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    // Snap to the point nearest the cursor in x-space (time-aware when dates drive x).
    let i = 0
    for (let k = 1; k < xFrac.length; k++) if (Math.abs(xFrac[k] - frac) < Math.abs(xFrac[i] - frac)) i = k
    const ts = dates?.[i]
    setHover({ xPct: xFrac[i] * 100, yPct: sy(data[i]) / h * 100, val: valueFmt(data[i]), date: ts ? tsDate(ts) : '' })
  }

  return (
    // Pointer events cover mouse + touch: pointerdown makes the point appear the
    // moment a finger lands, touch-action: pan-y (.apx-wrap) keeps horizontal drags
    // scrubbing instead of scrolling, and only a mouse leaving clears the hover —
    // a lifted finger fires pointerleave too, but the tapped point should stick.
    <div className="apx-wrap" ref={wrapRef} onPointerDown={onMove} onPointerMove={onMove}
      onPointerLeave={e => { if (e.pointerType === 'mouse') setHover(null) }}>
      <svg className="apx-chart" viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none">
        <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={col} stopOpacity="0.26" /><stop offset="100%" stopColor={col} stopOpacity="0" /></linearGradient></defs>
        <path className="chart-area" d={area} fill={`url(#${gid})`} />
        {target != null && <line x1={0} x2={W} y1={sy(target).toFixed(1)} y2={sy(target).toFixed(1)} stroke="var(--text-low)" strokeDasharray="3 4" strokeOpacity="0.6" vectorEffect="non-scaling-stroke" />}
        <path className="chart-line" d={line} fill="none" stroke={col} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      {hover && <div className="apx-cross"><div className="apx-vline" style={{ left: `${hover.xPct}%` }} /><div className="apx-dot" style={{ left: `${hover.xPct}%`, top: `${hover.yPct}%` }} /></div>}
      {hover && (
        <ChartTip xPct={hover.xPct}>
          {hover.date && <span className="t-d">{hover.date}</span>}
          <span className="t-p">{hover.val}</span>
        </ChartTip>
      )}
    </div>
  )
}

// Daily activity bar chart with click-to-filter-by-day.
// Skeleton bar heights (percent) for the loading placeholder — deterministic so
// the shimmer doesn't reshuffle across renders.
const DAY_SK_BARS = Array.from({ length: 44 }, (_, i) => 24 + Math.round(38 * Math.abs(Math.sin(i * 0.7)) + 22 * Math.abs(Math.sin(i * 0.23))))
// Loading placeholder for the responsive (.day-chart) charts, whose svg height is
// derived from its viewBox and scales with container width. `ratio` is the svg's
// viewBox width/height, so the placeholder occupies the exact same height the chart
// will — a fixed-px skeleton would leave a gap that jumps when data resolves.
export function DayChartSkeleton({ ratio }: { ratio: number }) {
  return (
    <div className="day-chart day-chart-sk" aria-hidden="true" style={{ aspectRatio: String(ratio) }}>
      {DAY_SK_BARS.map((v, i) => <span key={i} className="day-sk-bar" style={{ height: `${v}%`, animationDelay: `${(i % 6) * 80}ms` }} />)}
    </div>
  )
}
export function DayBarChart({ data, color = 'var(--sky)', fmt = (v: number) => String(Math.round(v)), label, selected, onSelect, loading }: {
  data: { date: string; value: number }[]; color?: string; fmt?: (v: number) => string; label?: string; selected?: string | null; onSelect?: (d: string | null) => void; loading?: boolean
}) {
  const W = 860, H = 120, padX = 2, padB = 2, padT = 8
  // On phones only the most recent 30 days render — the full window makes each
  // bar a ~3px sliver that can't be tapped to filter. Same breakpoint as the
  // stylesheet's table→card switch.
  const narrow = useMediaQuery('(max-width: 720px)')
  const days = narrow && data && data.length > 30 ? data.slice(-30) : data
  const has = !!(days && days.length)
  const max = has ? Math.max(...days.map(d => d.value), 1) : 1
  const bw = has ? (W - 2 * padX) / days.length : 0
  const avg = has ? days.reduce((a, b) => a + b.value, 0) / days.length : 0
  // Always render the .pf-card frame, including while data loads, so the chart
  // updates in place without remounting its container.
  // The loading placeholder shares the .day-chart box and mirrors the svg's viewBox
  // aspect ratio, so the card height is identical loading vs loaded at every width —
  // no height jump when the daily query refetches (e.g. on a tab switch).
  return (
    <>
      {label && <div className="sec-title">{label} <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}>· click a day to filter{selected ? <> · <span style={{ color: 'var(--accent)' }}>{selected}</span></> : ''}</span></div>}
      <div className="pf-card">
        {loading && !has ? (
          <DayChartSkeleton ratio={W / H} />
        ) : (
          <svg className="day-chart" viewBox={`0 0 ${W} ${H}`}>
            {has && days.map((d, i) => {
              const bh = (d.value / max) * (H - padT - padB), x = padX + i * bw, y = H - padB - bh, on = selected === d.date
              return <rect key={d.date} className={`day-bar${on ? ' on' : ''}`} style={{ fill: color }} x={x.toFixed(1)} y={y.toFixed(1)} width={(bw - 2).toFixed(1)} height={Math.max(1, bh).toFixed(1)} rx="2" onClick={() => onSelect?.(on ? null : d.date)}><title>{`${d.date} · ${fmt(d.value)}`}</title></rect>
            })}
          </svg>
        )}
        <div className="bal-xaxis" style={{ justifyContent: 'center' }}><span>{has ? `avg ${F.count(avg)}/day` : '…'}</span></div>
      </div>
    </>
  )
}

/* ============ params table (typed key/value with address resolution) ============ */
function looksHash(v: string): boolean { return /^0x[0-9a-f]{8,}$/i.test(v) }
function looksAddr(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v) || /^0x[0-9a-fA-F]{64}$/.test(v) || /^[1-9A-HJ-NP-Za-km-z]{46,50}$/.test(v)
}
export function ParamsTable({ args }: { args: Record<string, unknown> }) {
  const entries = Object.entries(args).filter(([k]) => !k.startsWith('_'))
  if (!entries.length) return <div className="json muted">No call parameters</div>
  return (
    <div className="kv-params">
      {entries.map(([k, v]) => {
        let type: string, body: ReactNode
        if (v !== null && typeof v === 'object') { type = Array.isArray(v) ? 'array' : 'object'; body = <span style={{ color: 'var(--text-medium)' }}>{JSON.stringify(v)}</span> }
        else if (typeof v === 'number') { type = 'u32'; body = F.int(v) }
        else if (typeof v === 'boolean') { type = 'bool'; body = String(v) }
        else {
          const s = String(v)
          if (looksAddr(s)) { type = 'address'; body = <Link className="hash" to={paths.account(s)}>{F.shortAddr(s)}</Link> }
          else if (looksHash(s)) { type = 'hash'; body = <span className="wrap-anywhere">{s}</span> }
          else { type = 'string'; body = s }
        }
        return <div className="kv-row" key={k}><div className="kk">{k}<span className="ty">{type}</span></div><div className="vv">{body}</div></div>
      })}
    </div>
  )
}

/* ============ JSON viewer ============ */
export function JsonView({ value }: { value: unknown }) {
  let json: string
  try { json = JSON.stringify(value, null, 2) } catch { json = String(value) }
  const html = (json ?? 'null')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"([^"]+)":/g, '<span class="key">"$1"</span><span class="punc">:</span>')
    .replace(/: "([^"]*)"/g, ': <span class="str">"$1"</span>')
    .replace(/: (\d[\d.]*)/g, ': <span class="numb">$1</span>')
    .replace(/[{}[\]]/g, m => `<span class="punc">${m}</span>`)
  return <div className="json" dangerouslySetInnerHTML={{ __html: html }} />
}

/* ============ layout helpers ============ */
export function Crumbs({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <div className="crumbs">
      {items.map((it, i) => (
        <span key={i} style={{ display: 'contents' }}>
          {i > 0 && <span className="sep">/</span>}
          {it.to ? <Link to={it.to}>{it.label}</Link> : <span>{it.label}</span>}
        </span>
      ))}
    </div>
  )
}
// Top-level tab bar for detail pages (Account/Tag). Reuses the shared .tabs
// styling; `count` renders the small muted counter used elsewhere.
export function DetailTabs({ tabs, active, onChange }: { tabs: { key: string; label: string; count?: number }[]; active: string; onChange: (key: string) => void }) {
  return (
    <div className="tabs detail-tabs">
      {tabs.map(t => (
        <button key={t.key} className={active === t.key ? 'active' : ''} onClick={() => onChange(t.key)}>
          {t.label}{t.count != null ? <span className="cnt">{F.int(t.count)}</span> : null}
        </button>
      ))}
    </div>
  )
}
export function SkeletonRows({ rows = 8 }: { rows?: number }) {
  const labels = ['42%', '34%', '48%', '40%', '55%', '36%', '46%', '32%']
  const values = ['28%', '46%', '72%', '38%', '56%', '64%', '34%', '52%']
  return (
    <div className="dl dl-skeleton" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <span key={i} style={{ display: 'contents' }}>
          <div className="dt"><span className="sk-bar" style={{ width: labels[i % labels.length] }} /></div>
          <div className="dd">
            <span className="sk-bar" style={{ width: values[i % values.length], animationDelay: `${(i % 5) * 90}ms` }} />
            {i % 3 === 0 && <span className="sk-pill" style={{ animationDelay: `${((i + 2) % 5) * 90}ms` }} />}
          </div>
        </span>
      ))}
    </div>
  )
}
// Skeleton <tr> rows for a table body — keeps the header and column grid in place
// while data loads (instead of a lone centered "Loading…"). Bar widths vary per
// cell for a natural shimmer; collapses to one bar per row on mobile cards.
export function TableSkeleton({ cols, rows = 8 }: { cols: number; rows?: number }) {
  const widths = ['58%', '42%', '70%', '36%', '52%', '48%', '64%', '40%']
  return <>{Array.from({ length: rows }).map((_, r) => (
    <tr className="sk-tr" key={r}>
      {Array.from({ length: cols }).map((_, c) => (
        <td key={c}><span className="sk-bar" style={{ width: widths[(r * cols + c) % widths.length], animationDelay: `${((r + c) % 6) * 80}ms` }} /></td>
      ))}
    </tr>
  ))}</>
}
// Shimmer placeholder for a chart card body while its series loads — avoids the
// degenerate flat-line / 1-1-0-axis render of an empty chart during the fetch.
export function ChartSkeleton({ h = 120 }: { h?: number }) {
  const bars = [36, 54, 44, 68, 58, 76, 48, 64, 42, 72, 56, 46]
  return (
    <div className="chart-skeleton" style={{ height: h }} aria-hidden="true">
      <div className="chart-sk-head">
        <span className="sk-bar chart-sk-now" />
        <span className="chart-sk-metrics">
          <span className="sk-bar" />
          <span className="sk-bar" />
          <span className="sk-bar" />
        </span>
      </div>
      <div className="chart-sk-plot">
        {bars.map((v, i) => <span key={i} className="chart-sk-bar" style={{ height: `${v}%`, animationDelay: `${(i % 6) * 80}ms` }} />)}
      </div>
    </div>
  )
}
function TabsSkeleton({ tabs = 4 }: { tabs?: number }) {
  const widths = ['72px', '86px', '68px', '92px']
  return (
    <div className="tabs tabs-skeleton" aria-hidden="true">
      {Array.from({ length: tabs }).map((_, i) => <span key={i} className="sk-bar" style={{ width: widths[i % widths.length], animationDelay: `${(i % 4) * 80}ms` }} />)}
    </div>
  )
}
export function ProfilePageSkeleton() {
  return (
    <>
      <div className="acct-head acct-head-skeleton" aria-hidden="true">
        <span className="sk-avatar" />
        <div className="acct-meta">
          <span className="sk-bar sk-name" />
          <span className="sk-bar sk-address" />
          <span className="sk-bar sk-hint" />
        </div>
        <div className="acct-bal">
          <span className="sk-bar sk-bal-label" />
          <span className="sk-bar sk-bal-value" />
        </div>
      </div>
      <TabsSkeleton tabs={4} />
      <div className="sec-title sec-title-skeleton" aria-hidden="true"><span className="sk-bar" /></div>
      <ChartSkeleton h={260} />
    </>
  )
}
function ActivityPanelSkeleton({ rows = 6, noActor = false }: { rows?: number; noActor?: boolean }) {
  const cols = noActor ? 4 : 5
  return (
    <div className="panel">
      <table className="tbl">
        <thead><tr><th>Type</th>{!noActor && <th>Account</th>}<th>Activity</th><th className="r">Value</th><th className="r">Time</th></tr></thead>
        <tbody><TableSkeleton cols={cols} rows={rows} /></tbody>
      </table>
    </div>
  )
}
export function AssetDetailSkeleton() {
  return (
    <>
      <div className="detail-card"><SkeletonRows rows={6} /></div>
      <div className="sec-title sec-title-skeleton" aria-hidden="true"><span className="sk-bar" /></div>
      {/* Match the loaded price card: apx-chart (220) + card chrome (~38) + the
          price/metrics header (~78) the skeleton doesn't draw — so the tabs and
          table below don't jump down when the chart resolves. */}
      <ChartSkeleton h={336} />
      <TabsSkeleton tabs={2} />
      <div className="activity-chips activity-chips-skeleton" aria-hidden="true">
        {Array.from({ length: 6 }).map((_, i) => <span key={i} className="sk-bar" style={{ width: i === 0 ? 48 : 86, animationDelay: `${(i % 5) * 80}ms` }} />)}
      </div>
      <ActivityPanelSkeleton rows={5} />
    </>
  )
}
export function ExpandedRowSkeleton() {
  const kv = ['42%', '70%', '36%', '58%']
  return (
    <div className="exp exp-skeleton" aria-hidden="true">
      <div className="exp-cols">
        <div>
          <div className="exp-h"><span className="sk-bar" /></div>
          <div className="exp-kv exp-kv-skeleton">
            {kv.map((w, i) => <span key={i} className="sk-bar" style={{ width: w, animationDelay: `${(i % 4) * 90}ms` }} />)}
          </div>
        </div>
        <div>
          <div className="exp-h"><span className="sk-bar" /></div>
          <div className="exp-evs exp-evs-skeleton">
            {Array.from({ length: 5 }).map((_, i) => <span key={i} className="sk-pill" style={{ width: 92 + (i % 2) * 28, animationDelay: `${(i % 5) * 90}ms` }} />)}
          </div>
        </div>
      </div>
      <span className="sk-bar exp-link-skeleton" />
    </div>
  )
}
export function EmptyRow({ cols, children }: { cols: number; children: ReactNode }) {
  return <tr><td colSpan={cols} style={{ textAlign: 'center', padding: 32, color: 'var(--text-low)' }}>{children}</td></tr>
}
// Deep-linkable pager. `hasNext` disables forward nav at the end; a sliding
// window of page numbers plus a jump box reach arbitrary depth (totalPages,
// when known, enables a Last button). Lists are newest-first, so higher pages
// go further back toward the very first block.
export function Pager({ page, hasNext, totalPages, onPage }: { page: number; hasNext?: boolean; totalPages?: number; onPage: (p: number) => void }) {
  const [jump, setJump] = useState('')
  const last = totalPages != null ? totalPages - 1 : undefined
  const canNext = hasNext ?? (last != null ? page < last : true)
  const maxButtons = 5
  const windowStart = last != null ? Math.max(0, Math.min(page - 2, Math.max(0, last - maxButtons + 1))) : Math.max(0, page - 2)
  // Without a known page count we only number pages up to the current one — a full
  // page means "there may be more" (the › arrow, driven by hasNext), not "there
  // are two more pages". Speculative page+N buttons produced phantom trailing
  // pages that render empty when the data ends on a page boundary.
  const windowEnd = last != null ? Math.min(last, windowStart + maxButtons - 1) : page
  const window: number[] = []
  for (let n = windowStart; n <= windowEnd; n++) window.push(n)
  // hasNext stays authoritative past a known last page: totals derived from
  // approximate counts (e.g. activity tab badges) may undershoot, and › must not
  // dead-end there.
  const go = (n: number) => { if (n >= 0 && (last == null || n <= last || (n === page + 1 && canNext))) onPage(n) }
  return (
    <div className="pager">
      <div className="info">Page {(page + 1).toLocaleString('en-US')}{last != null ? ` of ${(last + 1).toLocaleString('en-US')}` : ''}</div>
      <div className="btns">
        <button onClick={() => go(0)} disabled={page === 0} title="First" aria-label="First page">«</button>
        <button onClick={() => go(page - 1)} disabled={page === 0} title="Previous" aria-label="Previous page">‹</button>
        {window.map(n => <button key={n} className={n === page ? 'on' : ''} onClick={() => go(n)} aria-label={`Page ${n + 1}`} aria-current={n === page ? 'page' : undefined}>{n + 1}</button>)}
        <button onClick={() => go(page + 1)} disabled={!canNext} title="Next" aria-label="Next page">›</button>
        {last != null && <button onClick={() => go(last)} disabled={page >= last} title="Last" aria-label="Last page">»</button>}
        <form onSubmit={e => { e.preventDefault(); const n = parseInt(jump, 10); if (Number.isFinite(n) && n >= 1) go(n - 1); setJump('') }}>
          <input className="pager-jump" placeholder="Go to…" value={jump} onChange={e => setJump(e.target.value)} inputMode="numeric" aria-label="Go to page" />
        </form>
      </div>
    </div>
  )
}
export function rowNav(to: string) {
  return {
    className: 'clickable',
    tabIndex: 0,
    onClick: (e: MouseEvent<HTMLElement>) => {
      // Let nested interactive elements (account/asset links, the copy button) own
      // their click — navigate to the row's target only when the click lands on
      // blank row space. So clicking an AddrPill in a activity row goes to that
      // account, not the row's extrinsic.
      if ((e.target as HTMLElement).closest('a, button')) return
      navigate(to)
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'Enter' || e.target !== e.currentTarget) return
      e.preventDefault()
      navigate(to)
    },
  }
}

// Shared activity type-filter chips (Activity page, account & asset detail). The chip
// value maps to the backend activity `type` filter; 'all' is the unfiltered feed.
const ACTIVITY_CHIPS: { v: string; label: string }[] = [
  { v: 'all', label: 'All' }, { v: 'trade', label: 'Trade' }, { v: 'mm', label: 'Borrow' }, { v: 'liquidity', label: 'Liquidity' },
  { v: 'transfer', label: 'Transfer' }, { v: 'xcm', label: 'Cross-chain' }, { v: 'staking', label: 'Stake' }, { v: 'vote', label: 'Vote' },
]
const ACTIVITY_CHIP_VALUES = new Set(ACTIVITY_CHIPS.map(c => c.v))
export function normalizeActivityType(value: string): string {
  if (value === 'dca') return 'trade'   // dca is surfaced under the Trade feed (server does the same)
  if (value === 'otc') return 'trade'   // otc is surfaced under the Trade feed (server does the same)
  return ACTIVITY_CHIP_VALUES.has(value) ? value : 'all'
}

// Per-category action filters (server matches these against row fields).
export const ACTIVITY_ACTIONS: Record<string, { v: string; label: string }[]> = {
  // Labels mirror the badges the activity table renders for each row, so the
  // filter names exactly what it filters. OTC (place/pull/fill) is folded in
  // here alongside swap/dca — otc rows keep their own badges/slugs/detail
  // pages, only the Trade categorization changes.
  trade: [
    { v: 'swap', label: 'Swap' }, { v: 'dca', label: 'DCA' }, { v: 'dca-failed', label: 'Failed DCA' },
    { v: 'otc-place', label: 'OTC place' }, { v: 'otc-pull', label: 'OTC pull' }, { v: 'otc-fill', label: 'OTC fill' },
  ],
  xcm: [{ v: 'out', label: 'Outgoing' }, { v: 'in', label: 'Incoming' }],
  liquidity: [{ v: 'Add', label: 'Add liquidity' }, { v: 'Remove', label: 'Remove liquidity' }, { v: 'Create', label: 'Create pool' }, { v: 'Claim', label: 'Claim rewards' }],
  mm: [{ v: 'Supply', label: 'Supply' }, { v: 'Withdraw', label: 'Withdraw' }, { v: 'Borrow', label: 'Borrow' }, { v: 'Repay', label: 'Repay' }, { v: 'LiquidationCall', label: 'Liquidate' }, { v: 'ClaimRewards', label: 'Claim rewards' }],
  staking: [{ v: 'Stake', label: 'Stake' }, { v: 'Add stake', label: 'Add stake' }, { v: 'Unstake', label: 'Unstake' }, { v: 'Force unstake', label: 'Force unstake' }, { v: 'Staking reward', label: 'Staking reward' }, { v: 'Giga stake', label: 'Giga stake' }, { v: 'Giga unstake', label: 'Giga unstake' }, { v: 'Unstake cancelled', label: 'Unstake cancelled' }, { v: 'Giga migration', label: 'Giga migration' }, { v: 'Giga reward', label: 'Giga reward' }, { v: 'Collator payout', label: 'Collator payout' }],
  vote: [{ v: 'Aye', label: 'Aye' }, { v: 'Nay', label: 'Nay' }],
}
// Clamp a deep-linked action to the active type's known actions ('' = all).
export function normalizeActivityAction(type: string, action: string): string {
  return ACTIVITY_ACTIONS[type]?.some(a => a.v === action) ? action : ''
}
export function ActivityChips({ value, onChange, action, onAction }: {
  value: string; onChange: (v: string) => void; action?: string; onAction?: (v: string) => void
}) {
  const active = normalizeActivityType(value)
  const actions = ACTIVITY_ACTIONS[active]
  return (
    <div className="activity-chips">
      {ACTIVITY_CHIPS.map(c => <button key={c.v} className={`activity-chip${active === c.v ? ' on' : ''}`} onClick={() => onChange(c.v)}>{c.label}</button>)}
      {actions && onAction && (
        <select className="activity-action" value={normalizeActivityAction(active, action ?? '')} onChange={e => onAction(e.target.value)} aria-label="Action filter">
          <option value="">All actions</option>
          {actions.map(a => <option key={a.v} value={a.v}>{a.label}</option>)}
        </select>
      )}
    </div>
  )
}
