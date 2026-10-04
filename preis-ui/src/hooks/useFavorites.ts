import { useCallback, useEffect, useState } from 'react'
import { pairKeyString, samePair, type PairKey } from '../utils/pairs'

// Stored as `{ baseId, quoteId }`, plus `quoteAsset: true` for a
// stablecoin-quoted pair — entries saved before that flag existed are plain
// pairs, which is what they were.
export interface FavoritePair {
  baseId: number
  quoteId: number
  quoteAsset?: true
}

const STORAGE_KEY = 'preis-favorites'

function toKey(p: FavoritePair): PairKey {
  return { baseId: p.baseId, quoteId: p.quoteId, quoteAsset: p.quoteAsset === true }
}

function fromKey(key: PairKey): FavoritePair {
  return key.quoteAsset
    ? { baseId: key.baseId, quoteId: key.quoteId, quoteAsset: true }
    : { baseId: key.baseId, quoteId: key.quoteId }
}

export function parseFavorites(raw: string | null): FavoritePair[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const out: FavoritePair[] = []
    for (const p of parsed) {
      if (
        p && typeof p.baseId === 'number' && typeof p.quoteId === 'number' &&
        Number.isFinite(p.baseId) && Number.isFinite(p.quoteId)
      ) {
        const key = toKey(p)
        const id = pairKeyString(key)
        if (!seen.has(id)) {
          seen.add(id)
          out.push(fromKey(key))
        }
      }
    }
    return out
  } catch {
    return []
  }
}

function read(): FavoritePair[] {
  try {
    return parseFavorites(localStorage.getItem(STORAGE_KEY))
  } catch {
    return []
  }
}

function write(list: FavoritePair[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    // Ignore persistence failures; favorites still work for the current tab.
  }
}

export function useFavorites() {
  const [favorites, setFavorites] = useState<FavoritePair[]>(() => read())

  useEffect(() => { write(favorites) }, [favorites])

  // Cross-tab sync.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setFavorites(read())
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  const isFavorite = useCallback(
    (key: PairKey) => favorites.some(f => samePair(toKey(f), key)),
    [favorites],
  )

  const toggle = useCallback((key: PairKey) => {
    setFavorites(prev => {
      const idx = prev.findIndex(f => samePair(toKey(f), key))
      if (idx >= 0) return prev.filter((_, i) => i !== idx)
      return [...prev, fromKey(key)]
    })
  }, [])

  return { favorites, isFavorite, toggle }
}
