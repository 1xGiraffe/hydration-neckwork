import { useCallback, useEffect, useState } from 'react'

export interface FavoritePair {
  baseId: number
  quoteId: number
}

const STORAGE_KEY = 'preis-favorites'

function read(): FavoritePair[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const out: FavoritePair[] = []
    for (const p of parsed) {
      if (
        p && typeof p.baseId === 'number' && typeof p.quoteId === 'number' &&
        Number.isFinite(p.baseId) && Number.isFinite(p.quoteId)
      ) {
        const key = `${p.baseId}-${p.quoteId}`
        if (!seen.has(key)) {
          seen.add(key)
          out.push({ baseId: p.baseId, quoteId: p.quoteId })
        }
      }
    }
    return out
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
    (baseId: number, quoteId: number) => favorites.some(f => f.baseId === baseId && f.quoteId === quoteId),
    [favorites],
  )

  const toggle = useCallback((baseId: number, quoteId: number) => {
    setFavorites(prev => {
      const idx = prev.findIndex(f => f.baseId === baseId && f.quoteId === quoteId)
      if (idx >= 0) return prev.filter((_, i) => i !== idx)
      return [...prev, { baseId, quoteId }]
    })
  }, [])

  return { favorites, isFavorite, toggle }
}
