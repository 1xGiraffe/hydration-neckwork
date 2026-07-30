import { useEffect, useState } from 'react'
import { assetIconCandidates, iconIsSampleable, assetBrandColor } from '../components/ui'
import type { AssetRef } from '../types'

// Derive a representative brand color from a token's icon. The dominant-color
// pick is a pure function over an RGBA buffer (unit-tested); the DOM glue loads
// the CDN icon with CORS, rasterises it to a small canvas, and samples it. Colors
// are cached per icon so each asset is only sampled once, and any failure (load
// error, tainted canvas, no vibrant pixels) falls back to the app's per-asset
// color so a tile always has one.

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

// Central asset-color resolver: kick off (once) the icon sample for `asset`,
// deduped/cached, with the app's curated per-asset color as the fallback.
function ensureSample(asset: AssetRef): Promise<string> {
  const key = iconKey(asset)
  const cached = cache.get(key)
  if (cached != null) return Promise.resolve(cached)
  let p = inflight.get(key)
  if (!p) {
    const fallback = assetBrandColor(asset.symbol)
    p = extract(asset).then(c => { const v = c ?? fallback; cache.set(key, v); inflight.delete(key); return v })
    inflight.set(key, p)
  }
  return p
}

// THE way to get a single asset's brand color anywhere in the app: the icon's
// dominant sampled color, or the curated fallback until the sample lands. The
// color is read straight from the cache each render (so it's correct the instant
// the asset changes); the effect only samples and nudges a re-render on resolve.
export function useAssetColor(asset: AssetRef): string {
  const key = iconKey(asset)
  const [, bump] = useState(0)
  useEffect(() => {
    if (cache.has(key)) return
    let cancelled = false
    ensureSample(asset).then(() => { if (!cancelled) bump(n => n + 1) })
    return () => { cancelled = true }
    // key captures the icon identity; asset is only read to sample it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return cache.get(key) ?? assetBrandColor(asset.symbol)
}

// Batch resolver for charts/lists with several asset segments (respects hook
// rules — one call resolves N assets). Returns a lookup yielding each asset's
// sampled color, or its curated fallback until the sample lands; re-renders as
// samples resolve.
export function useAssetColors(assets: readonly (AssetRef | null | undefined)[]): (asset: AssetRef) => string {
  const list = assets.filter((a): a is AssetRef => !!a)
  const keys = list.map(iconKey).join('|')
  const [, bump] = useState(0)
  useEffect(() => {
    let cancelled = false
    for (const asset of list) {
      if (cache.has(iconKey(asset))) continue
      ensureSample(asset).then(() => { if (!cancelled) bump(n => n + 1) })
    }
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys])
  return (asset: AssetRef) => cache.get(iconKey(asset)) ?? assetBrandColor(asset.symbol)
}
