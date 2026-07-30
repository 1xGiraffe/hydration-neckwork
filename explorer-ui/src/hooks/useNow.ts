import { useState, useEffect } from 'react'

// Shared 1s ticking clock so relative timestamps ("12s ago") stay fresh without
// each row owning a timer.
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
