import { useEffect, useState } from 'react'
import { assetIconCandidates, iconIsSampleable } from '../components/ui'
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
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]
    if (a < 128) continue
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    const chroma = max - min
    if (chroma < 40) continue      // grey / white / black — background
    if (max < 30 || min > 232) continue // near-black outline / near-white fill
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    const bkt = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0, score: 0 }
    bkt.r += r; bkt.g += g; bkt.b += b; bkt.n += 1; bkt.score += 0.4 + chroma / 255
    buckets.set(key, bkt)
  }
  let best: { r: number; g: number; b: number; n: number; score: number } | null = null
  for (const bkt of buckets.values()) if (!best || bkt.score > best.score) best = bkt
  if (!best) return null
  const r = Math.round(best.r / best.n), g = Math.round(best.g / best.n), b = Math.round(best.b / best.n)
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')
}

const cache = new Map<string, string>()
const inflight = new Map<string, Promise<string | null>>()

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

// Resolve to the icon's dominant color, updating from `fallback` once sampled.
export function useIconColor(asset: AssetRef, fallback: string): string {
  const key = iconKey(asset)
  const [color, setColor] = useState<string>(() => cache.get(key) ?? fallback)
  useEffect(() => {
    // The state initializer already applied any cached color for this key.
    if (cache.has(key)) return
    let cancelled = false
    let p = inflight.get(key)
    if (!p) {
      p = extract(asset).then(c => { const v = c ?? fallback; cache.set(key, v); inflight.delete(key); return v })
      inflight.set(key, p)
    }
    p.then(c => { if (!cancelled && c) setColor(c) })
    return () => { cancelled = true }
    // fallback is derived from the same asset; keying on the icon identity is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return color
}
