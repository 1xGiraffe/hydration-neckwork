import { useSyncExternalStore } from 'react'

// Global Live/Paused state. When enabled, list views poll on LIVE_MS; when
// paused, they do not refetch. Persisted to
// localStorage so the choice survives reloads. The server-side single-flight
// cache keeps DB load O(1) regardless of how many clients poll.
// Hydration targets roughly one block every six seconds. Polling more often only
// re-fetched the same head while forcing the API cache to expire between clients.
export const LIVE_MS = 6000

let liveOn = (() => {
  try { return localStorage.getItem('explorer-live') !== '0' } catch { return true }
})()

const listeners = new Set<() => void>()
function emit() { listeners.forEach(l => l()) }

export function toggleLive(): void {
  liveOn = !liveOn
  try { localStorage.setItem('explorer-live', liveOn ? '1' : '0') } catch { /* ignore */ }
  emit()
}
export function useLive(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    () => liveOn,
    () => liveOn,
  )
}
