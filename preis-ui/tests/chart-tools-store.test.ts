import { beforeEach, describe, expect, it } from 'vitest'
import { readDrawings, writeDrawings } from '../src/chart-tools/store'
import type { ChartDrawing } from '../src/chart-tools/types'

const STORAGE_KEY = 'preis-drawings'

// The vitest environment is plain node, so provide a minimal in-memory
// localStorage stand-in with the subset of the API the store uses.
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
}

const storage = new MemoryStorage()
;(globalThis as { localStorage?: unknown }).localStorage = storage

function drawing(id: string, t1: number, p1: number, t2: number, p2: number): ChartDrawing {
  return { id, points: [{ time: t1, price: p1 }, { time: t2, price: p2 }] }
}

function channel(id: string, offset: number): ChartDrawing {
  return { ...drawing(id, 1_000, 1, 2_000, 2), kind: 'channel', offset }
}

beforeEach(() => {
  storage.clear()
})

describe('readDrawings', () => {
  it('returns [] when nothing is stored', () => {
    expect(readDrawings('5-10')).toEqual([])
  })

  it('returns [] for corrupt JSON', () => {
    storage.setItem(STORAGE_KEY, '{not json')
    expect(readDrawings('5-10')).toEqual([])
  })

  it('returns [] for wrong shapes', () => {
    for (const bad of ['[]', '42', '{"pairs":{}}', '{"version":2,"pairs":{}}', '{"version":1}', '{"version":1,"pairs":[]}']) {
      storage.setItem(STORAGE_KEY, bad)
      expect(readDrawings('5-10')).toEqual([])
    }
  })

  it('reads v1 entries (no kind) as trendlines and keeps channel fields', () => {
    const v1 = drawing('old', 1_000, 1, 2_000, 2)
    const ch = channel('ch', -0.5)
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, pairs: { '5-10': [v1, ch] } }))
    expect(readDrawings('5-10')).toEqual([v1, ch])
  })

  it('drops channels with a missing or non-finite offset and unknown kinds', () => {
    const good = channel('good', 2.5)
    storage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      pairs: {
        '5-10': [
          good,
          { ...channel('nooff', 0), offset: undefined },
          { ...channel('nan', 0), offset: Number.NaN },
          { ...channel('inf', 0), offset: Infinity },
          { ...channel('str', 0), offset: '1' },
          { ...drawing('weird', 1, 1, 2, 2), kind: 'ray' },
        ],
      },
    }))
    expect(readDrawings('5-10')).toEqual([good])
  })

  it('drops drawings with non-finite or missing point fields', () => {
    const good = drawing('ok', 1_700_000_000, 1.5, 1_700_003_600, 2.5)
    storage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      pairs: {
        '5-10': [
          good,
          { id: 'nan', points: [{ time: Number.NaN, price: 1 }, { time: 2, price: 2 }] },
          { id: 'inf', points: [{ time: 1, price: Infinity }, { time: 2, price: 2 }] },
          { id: 'missing', points: [{ time: 1, price: 1 }] },
          { id: 'strings', points: [{ time: '1', price: 1 }, { time: 2, price: 2 }] },
          { points: [{ time: 1, price: 1 }, { time: 2, price: 2 }] },
          null,
        ],
      },
    }))
    expect(readDrawings('5-10')).toEqual([good])
  })
})

describe('writeDrawings', () => {
  it('round-trips trendlines and channels through the storage key', () => {
    const drawings = [
      drawing('a', 1_700_000_000, 1, 1_700_003_600, 2),
      channel('b', 0.25),
    ]
    writeDrawings('5-10', drawings)
    expect(readDrawings('5-10')).toEqual(drawings)
  })

  it('preserves other pairs when writing one pair', () => {
    const a = [drawing('a', 1, 1, 2, 2)]
    const b = [drawing('b', 3, 3, 4, 4)]
    writeDrawings('5-10', a)
    writeDrawings('7-10', b)
    writeDrawings('5-10', [])
    expect(readDrawings('5-10')).toEqual([])
    expect(readDrawings('7-10')).toEqual(b)
  })

  it('replaces a corrupt store instead of throwing', () => {
    storage.setItem(STORAGE_KEY, '{not json')
    const drawings = [drawing('a', 1, 1, 2, 2)]
    writeDrawings('5-10', drawings)
    expect(readDrawings('5-10')).toEqual(drawings)
  })
})
