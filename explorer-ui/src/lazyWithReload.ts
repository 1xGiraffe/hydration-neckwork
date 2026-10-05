import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

// Every lazy() chunk goes through here. After a redeploy the content-hashed
// chunk names change, so a tab that was opened before it asks for files the new
// container no longer has, and the import rejects. The page then reloads ONCE to
// pick up the current shell and its chunk names.
//
// The loop guard is a sessionStorage flag set just before that reload. A page
// that boots with the flag already present is itself the product of a chunk
// reload, so every further chunk failure in that page's lifetime is rethrown to
// RootErrorBoundary (components/RootErrorBoundary.tsx, around <App /> in
// main.tsx), which shows "A new version is live — reload", instead of reloading
// again — even if a sibling chunk loaded fine meanwhile. A successful load
// clears the stored flag, so the NEXT page load (a reload or a fresh tab in the
// same session) gets its own one automatic reload for a later deploy; the page
// that booted from a reload never reloads itself again. Without usable storage
// the guard cannot hold, so the error is rethrown to the boundary rather than
// risking a reload loop. Non-chunk errors are always rethrown.

const RELOAD_FLAG = 'chunk-load-reload'

// Chrome, Firefox and Safari word a failed dynamic import differently; webpack
// names it ChunkLoadError; Vite's preload helper reports a missing CSS chunk.
const CHUNK_ERROR = /ChunkLoadError|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i

export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const { name, message } = error as { name?: unknown; message?: unknown }
  return CHUNK_ERROR.test(`${String(name ?? '')} ${String(message ?? '')}`)
}

type FlagStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface ChunkReloadEnv {
  // Returns the storage, or throws when it is unavailable (privacy mode, a
  // sandboxed frame); every access below is guarded.
  storage: () => FlagStorage
  reload: () => void
}

export function createChunkReloader(env: ChunkReloadEnv) {
  let bootedFromReload: boolean
  try {
    bootedFromReload = env.storage().getItem(RELOAD_FLAG) !== null
  } catch {
    bootedFromReload = true
  }

  // Set the flag and report whether a reload is safe: only when this page was
  // not itself a chunk reload and the flag demonstrably persisted.
  function armReload(): boolean {
    if (bootedFromReload) return false
    try {
      const storage = env.storage()
      storage.setItem(RELOAD_FLAG, String(Date.now()))
      return storage.getItem(RELOAD_FLAG) !== null
    } catch {
      return false
    }
  }

  function clearFlag() {
    try {
      env.storage().removeItem(RELOAD_FLAG)
    } catch {
      // Nothing to clear without storage.
    }
  }

  return async function load<T>(importer: () => Promise<T>): Promise<T> {
    let mod: T
    try {
      mod = await importer()
    } catch (error) {
      if (!isChunkLoadError(error) || !armReload()) throw error
      env.reload()
      // Keep the Suspense fallback up while the browser navigates away.
      return new Promise<T>(() => {})
    }
    clearFlag()
    return mod
  }
}

const loadChunk = createChunkReloader({
  storage: () => window.sessionStorage,
  reload: () => window.location.reload(),
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors React.lazy's own constraint
export function lazyWithReload<T extends ComponentType<any>>(
  importer: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() => loadChunk(importer))
}
