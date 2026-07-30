import type { AnchorPoint, ChartDrawing } from './types'

const STORAGE_KEY = 'preis-drawings'

interface DrawingsStore {
  version: 1
  pairs: Record<string, ChartDrawing[]>
}

function isValidPoint(point: unknown): point is AnchorPoint {
  if (typeof point !== 'object' || point === null) return false
  const p = point as { time?: unknown; price?: unknown }
  return typeof p.time === 'number' && Number.isFinite(p.time) &&
    typeof p.price === 'number' && Number.isFinite(p.price)
}

function sanitizeDrawings(value: unknown): ChartDrawing[] {
  if (!Array.isArray(value)) return []
  const out: ChartDrawing[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const d = entry as { id?: unknown; points?: unknown; kind?: unknown; offset?: unknown }
    if (typeof d.id !== 'string' || d.id.length === 0) continue
    if (!Array.isArray(d.points) || d.points.length !== 2) continue
    const [a, b] = d.points
    if (!isValidPoint(a) || !isValidPoint(b)) continue
    const points: [AnchorPoint, AnchorPoint] =
      [{ time: a.time, price: a.price }, { time: b.time, price: b.price }]
    if (d.kind === 'channel') {
      if (typeof d.offset !== 'number' || !Number.isFinite(d.offset)) continue
      out.push({ id: d.id, points, kind: 'channel', offset: d.offset })
    } else if (d.kind === undefined || d.kind === 'trendline') {
      // v1 entries have no kind; normalize trendlines to the kind-less shape.
      out.push({ id: d.id, points })
    }
    // Unknown kinds are dropped defensively.
  }
  return out
}

function readStore(): DrawingsStore {
  const empty: DrawingsStore = { version: 1, pairs: {} }
  try {
    // localStorage can be unavailable in private or hardened contexts.
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return empty
    const store = parsed as { version?: unknown; pairs?: unknown }
    if (store.version !== 1) return empty
    if (typeof store.pairs !== 'object' || store.pairs === null || Array.isArray(store.pairs)) return empty
    const pairs: Record<string, ChartDrawing[]> = {}
    for (const [pairKey, drawings] of Object.entries(store.pairs)) {
      pairs[pairKey] = sanitizeDrawings(drawings)
    }
    return { version: 1, pairs }
  } catch {
    return empty
  }
}

export function readDrawings(pairKey: string): ChartDrawing[] {
  return readStore().pairs[pairKey] ?? []
}

export function writeDrawings(pairKey: string, drawings: ChartDrawing[]): void {
  try {
    const store = readStore()
    store.pairs[pairKey] = drawings
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Ignore persistence failures; drawings still work for the current tab.
  }
}
