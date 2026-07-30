import { useSyncExternalStore } from 'react'

// The wallet login session: an opaque bearer token plus the canonical account
// it belongs to. Cleared on logout, on a 401 from any /user request, and kept
// in sync across tabs. The token is only ever sent as an Authorization header —
// never a cookie — so shared API caches never see credentialed requests.
export interface Session { token: string; accountId: string; address: string }

export const SESSION_STORAGE_KEY = 'explorer-session'

function read(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Session
    return v && typeof v.token === 'string' && typeof v.accountId === 'string' ? v : null
  } catch { return null }
}

let session: Session | null = read()
const listeners = new Set<() => void>()
function emit() { listeners.forEach(l => l()) }

export function getSession(): Session | null { return session }
export function setSession(next: Session | null): void {
  session = next
  try {
    if (next) localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(next))
    else localStorage.removeItem(SESSION_STORAGE_KEY)
  } catch { /* ignore */ }
  emit()
}
export function useSession(): Session | null {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb)
      const onStorage = (e: StorageEvent) => { if (e.key === SESSION_STORAGE_KEY) { session = read(); cb() } }
      window.addEventListener('storage', onStorage)
      return () => { listeners.delete(cb); window.removeEventListener('storage', onStorage) }
    },
    () => session,
    () => null,
  )
}
