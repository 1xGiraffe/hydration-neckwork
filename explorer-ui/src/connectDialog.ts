import { useEffect, useRef } from 'react'

// A visitor can meet a "Subscribe" (or "Log in") affordance on any page —
// /tags' discovery rows, a public library's own detail page, the topbar
// itself — but the actual <ConnectDialog> is mounted exactly once, lazily,
// by Topbar (see the file-level comment there on why: it's a route-chunk-
// style import so a logged-in visitor never pays for Radix + the dialog).
// Anywhere else that needs to open it calls requestConnect() rather than
// mounting a second instance of its own; Topbar is the sole subscriber.
// Mirrors live.ts's module-store shape exactly (a plain module-level value +
// a listener Set), the smallest mechanism already established in this
// codebase for "one piece of app-wide state, one consumer that reacts to it".
let requests = 0
const listeners = new Set<() => void>()
function emit() { listeners.forEach(l => l()) }

export function requestConnect(): void {
  requests++
  emit()
}

// Topbar-only: fires `onRequest` once per requestConnect() call, including
// ones that happen before this effect's first run (e.g. a request that
// raced Topbar's own lazy mount) — a plain useSyncExternalStore subscriber
// would only see requests as a changing number, not a "do this now" edge, so
// this tracks the last request it already handled instead.
export function useConnectRequest(onRequest: () => void): void {
  const seen = useRef(requests)
  useEffect(() => {
    const check = () => {
      if (requests !== seen.current) { seen.current = requests; onRequest() }
    }
    check()   // catch a request that landed before this effect ran
    listeners.add(check)
    return () => { listeners.delete(check) }
  }, [onRequest])
}
