import { useEffect, useRef, useState } from 'react'

const EMPTY: ReadonlySet<string> = new Set()

// Detects which row keys appeared since the previous data update, so a live table
// can briefly highlight freshly-added rows (giving a feel for which / how many were
// added). Only flags additions when `live` is true AND the update is incremental
// (shares some keys with the prior set) — so the initial load, pagination, and
// filter changes don't animate the whole table.
export function useNewRows(keys: string[], live: boolean): ReadonlySet<string> {
  const prev = useRef<string[] | null>(null)
  const [added, setAdded] = useState<ReadonlySet<string>>(EMPTY)
  const signature = JSON.stringify(keys)

  useEffect(() => {
    const prevKeys = prev.current
    const nextKeys = JSON.parse(signature) as string[]
    prev.current = nextKeys
    if (!live || !prevKeys) { setAdded(EMPTY); return }
    const prevSet = new Set(prevKeys)
    const fresh = nextKeys.filter(k => !prevSet.has(k))
    const overlaps = nextKeys.some(k => prevSet.has(k))
    setAdded(fresh.length && overlaps ? new Set(fresh) : EMPTY)
  }, [signature, live])

  return added
}
