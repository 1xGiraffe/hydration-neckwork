import { useEffect, useMemo, useRef, useState } from 'react'

const EMPTY: ReadonlySet<string> = new Set()

// Detects which row keys appeared since the previous data update, so a live table
// can briefly highlight freshly-added rows (giving a feel for which / how many were
// added). Only flags additions when `live` is true AND the update is incremental
// (shares some keys with the prior set) — so the initial load, pagination, and
// filter changes don't animate the whole table.
export function useNewRows(keys: string[], live: boolean): ReadonlySet<string> {
  const prev = useRef<string[] | null>(null)
  const [added, setAdded] = useState<ReadonlySet<string>>(EMPTY)
  // What the effect runs on: the ROWS changing, not the caller building a fresh
  // array of the same rows. Callers pass a literal `rows.map(...)`, so the array
  // itself is a new reference every render, and these tables re-render on the
  // 1 Hz clock — hence a cheap join for the identity, and a memo that hands the
  // effect the same array back until that identity actually moves.
  const signature = keys.join('\n')
  const stableKeys = useMemo(() => keys, [signature])   // eslint-disable-line react-hooks/exhaustive-deps -- `signature` IS the content of `keys`

  useEffect(() => {
    const prevKeys = prev.current
    const nextKeys = stableKeys
    prev.current = nextKeys
    if (!live || !prevKeys) { setAdded(EMPTY); return }
    const prevSet = new Set(prevKeys)
    const fresh = nextKeys.filter(k => !prevSet.has(k))
    const overlaps = nextKeys.some(k => prevSet.has(k))
    setAdded(fresh.length && overlaps ? new Set(fresh) : EMPTY)
  }, [stableKeys, live])

  return added
}
