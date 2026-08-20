import { useEffect, useSyncExternalStore } from 'react'
import { assetIconCandidates, iconIsSampleable, assetBrandColor } from '../components/ui'
import { resolveAssetChartColors } from './seriesColors'
import type { AssetRef } from '../types'

// Derive a representative brand color from a token's icon. The dominant-color
// pick is a pure function over an RGBA buffer (unit-tested); the DOM glue loads
// the CDN icon with CORS, rasterises it to a small canvas, and samples it. Colors
// are cached per icon so each asset is only sampled once, and any failure (load
// error, tainted canvas, no vibrant pixels) falls back to the app's per-asset
// color so a tile always has one.
//
// On top of the per-icon sample sits ONE app-wide resolution: every asset a
// color is requested for registers in a session registry, and collisions
// (vDOT/aDOT are both Polkadot pink) are resolved centrally in canonical order
// (resolveAssetChartColors) rather than per chart. That is what makes the same
// asset wear the same color on every surface — the Omnipool bar and its
// history, a pool row and the pool page, a treemap tile and a legend — while
// two lookalikes still separate into shades of their own colour where they meet.

// Pick the dominant *saturated* color from an RGBA buffer. Transparent, near-white,
// near-black and low-chroma (grey) pixels are treated as background and skipped, so
// a logo's actual brand hue wins over its padding and outline. Returns null when
// nothing vibrant is present (caller then uses its fallback).
export function vibrantColor(rgba: Uint8ClampedArray): string | null {
  // Coarse RGB buckets (5 bits/channel) accumulate the vivid pixels; the bucket
  // with the highest chroma-weighted mass wins.
  const buckets = new Map<number, { r: number; g: number; b: number; n: number; score: number }>()
  // Opaque low-chroma "ink" (a monochrome logo's body). Used only when no vibrant
  // color exists, so a greyscale icon (e.g. sUSDe) resolves to its own grey rather
  // than an arbitrary hashed color.
  let neutral = { r: 0, g: 0, b: 0, n: 0 }
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]
    if (a < 128) continue
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    if (max < 30 || min > 232) continue // near-black outline / near-white fill — background
    const chroma = max - min
    if (chroma < 40) { neutral = { r: neutral.r + r, g: neutral.g + g, b: neutral.b + b, n: neutral.n + 1 }; continue } // grey ink
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    const bkt = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0, score: 0 }
    bkt.r += r; bkt.g += g; bkt.b += b; bkt.n += 1; bkt.score += 0.4 + chroma / 255
    buckets.set(key, bkt)
  }
  const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('')
  let best: { r: number; g: number; b: number; n: number; score: number } | null = null
  for (const bkt of buckets.values()) if (!best || bkt.score > best.score) best = bkt
  if (best) return hex(best.r / best.n, best.g / best.n, best.b / best.n)
  // No vibrant hue: fall back to the monochrome ink's grey, if the icon had any.
  if (neutral.n) return hex(neutral.r / neutral.n, neutral.g / neutral.n, neutral.b / neutral.n)
  return null
}

const cache = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()

function iconKey(asset: AssetRef): string {
  const o = asset.origin
  return `${asset.iconAssetId ?? asset.assetId}:${o?.ecosystem ?? ''}:${o?.chainId ?? ''}:${o?.assetId ?? ''}`
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('icon load failed'))
    img.src = url
  })
}

function sample(img: HTMLImageElement): string | null {
  const S = 24
  const canvas = document.createElement('canvas')
  canvas.width = S; canvas.height = S
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.clearRect(0, 0, S, S)
  try {
    ctx.drawImage(img, 0, 0, S, S)
    return vibrantColor(ctx.getImageData(0, 0, S, S).data)
  } catch {
    return null // tainted canvas (some SVGs) — caller falls back
  }
}

async function extract(asset: AssetRef): Promise<string | null> {
  // Skip assets with no single sampleable CDN icon (composites, known-missing) —
  // requesting them only 404s; the caller keeps its fallback color.
  const srcId = asset.iconAssetId ?? asset.assetId
  if (!iconIsSampleable(srcId) || !iconIsSampleable(asset.assetId)) return null
  for (const url of assetIconCandidates(srcId, asset.origin)) {
    try {
      const color = sample(await loadImage(url))
      if (color) return color
    } catch { /* try the next candidate */ }
  }
  return null
}

// ---- app-wide resolved colors (the session registry) ----
// Every asset ever asked for registers here (per assetId — an aToken that
// borrows its underlying's icon is still its own asset and can share a chart
// with it); resolveAssetChartColors assigns the whole registry at once in
// canonical order. `generation` versions the inputs (a new registration, a
// landed sample) and subscribed components re-render together, so every
// visible surface always agrees on a color.
const registered = new Map<number, AssetRef>()
let generation = 0
const listeners = new Set<() => void>()
function notify() { generation++; for (const l of [...listeners]) l() }
function subscribeColors(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l) } }
function colorGeneration(): number { return generation }

let resolvedAt = -1
let resolvedColors = new Map<string, string>()
function resolveAll(): Map<string, string> {
  if (resolvedAt !== generation) {
    resolvedColors = resolveAssetChartColors([...registered.values()].map(a => ({
      key: String(a.assetId), assetId: a.assetId, base: cache.get(iconKey(a)) ?? assetBrandColor(a.symbol),
    })))
    resolvedAt = generation
  }
  return resolvedColors
}

// Central asset-color resolver: kick off (once) the icon sample for `asset`,
// deduped/cached, with the app's curated per-asset color as the fallback. A
// landed sample that changes the input re-resolves the registry.
function ensureSample(asset: AssetRef): Promise<string> {
  const key = iconKey(asset)
  const cached = cache.get(key)
  if (cached != null) return Promise.resolve(cached)
  let p = inflight.get(key)
  if (!p) {
    const fallback = assetBrandColor(asset.symbol)
    p = extract(asset).then(c => {
      const v = c ?? fallback
      cache.set(key, v); inflight.delete(key)
      if (v !== fallback) notify() // the fallback was already the resolver's input
      return v
    })
    inflight.set(key, p)
  }
  return p
}

// Register an asset in the session registry (idempotent) and start its icon
// sample (deduped per icon, so shared icons are still sampled once).
function trackAsset(asset: AssetRef): void {
  if (!registered.has(asset.assetId)) {
    registered.set(asset.assetId, asset)
    notify()
  }
  void ensureSample(asset)
}

function assetColor(asset: AssetRef): string {
  return resolveAll().get(String(asset.assetId)) ?? cache.get(iconKey(asset)) ?? assetBrandColor(asset.symbol)
}

// THE way to get a single asset's brand color anywhere in the app: the icon's
// dominant sampled color (curated fallback until the sample lands), post the
// app-wide collision resolution. Registration and sampling run in the effect;
// the subscription re-renders the component whenever any input lands.
export function useAssetColor(asset: AssetRef): string {
  // assetId + icon identity: registration is per asset, sampling per icon.
  const key = `${asset.assetId}|${iconKey(asset)}`
  // The third argument keeps renderToString happy (tests SSR some pages);
  // the generation counter is as valid on the server as on the client.
  useSyncExternalStore(subscribeColors, colorGeneration, colorGeneration)
  useEffect(() => {
    trackAsset(asset)
    // key captures the asset identity; asset is only read to register/sample it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return assetColor(asset)
}

// Batch resolver for charts/lists with several asset segments (respects hook
// rules — one call resolves N assets). Returns a lookup yielding each asset's
// resolved color; re-renders as samples land or the registry re-resolves.
export function useAssetColors(assets: readonly (AssetRef | null | undefined)[]): (asset: AssetRef) => string {
  const list = assets.filter((a): a is AssetRef => !!a)
  const keys = list.map(a => `${a.assetId}|${iconKey(a)}`).join('||')
  useSyncExternalStore(subscribeColors, colorGeneration, colorGeneration)
  useEffect(() => {
    for (const asset of list) trackAsset(asset)
    // keys captures the asset identities; list is only read to register/sample.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys])
  return assetColor
}
