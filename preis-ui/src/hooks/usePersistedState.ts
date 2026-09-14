import { useEffect, useState } from 'react'

/**
 * State mirrored into localStorage: read once on mount, written on every change.
 * Both sides swallow failures — storage is unavailable in private or hardened
 * contexts, and the in-memory value works regardless — so `decode` also has to
 * answer for a missing key.
 *
 * `decode` and `encode` must be stable (module-level functions); an inline
 * closure would make the write effect run on every render.
 */
export function usePersistedState<T>(
  key: string,
  decode: (raw: string | null) => T,
  encode: (value: T) => string,
) {
  const [value, setValue] = useState<T>(() => {
    try {
      return decode(localStorage.getItem(key))
    } catch {
      return decode(null)
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, encode(value))
    } catch {
      // Ignore persistence failures; the in-memory value still works.
    }
  }, [key, encode, value])

  return [value, setValue] as const
}
