import { useCallback, useEffect, useState, type RefObject } from 'react'

// Full screen for the /revenue rivers: ONE view holding both rivers, opened
// from either river's button. The Fullscreen API is used where the browser
// grants it to an element; where it does not (iPhone Safari has no element
// fullscreen, an embedding frame may refuse it) the same view is a fixed,
// viewport-filling layer instead ('css'). Esc leaves either: the browser
// handles it for the native mode, a key listener for the CSS one.

export type RiverFullscreenMode = 'off' | 'native' | 'css'

interface FullscreenTarget { requestFullscreen?: () => Promise<void> }

/** Ask the browser for element fullscreen; fall back to the CSS layer when it is absent or refused. */
export async function requestRiverFullscreen(el: FullscreenTarget): Promise<RiverFullscreenMode> {
  if (typeof el.requestFullscreen !== 'function') return 'css'
  try {
    await el.requestFullscreen()
    return 'native'
  } catch {
    return 'css'
  }
}

/** The mode after a `fullscreenchange`: native when our element is the fullscreen one, off when native fullscreen left. */
export function riverModeAfterChange(prev: RiverFullscreenMode, oursIsFullscreen: boolean): RiverFullscreenMode {
  if (oursIsFullscreen) return 'native'
  return prev === 'native' ? 'off' : prev
}

export function useRiverFullscreen(ref: RefObject<HTMLElement | null>): {
  mode: RiverFullscreenMode
  fullscreen: boolean
  toggle: () => void
} {
  const [mode, setMode] = useState<RiverFullscreenMode>('off')

  useEffect(() => {
    const onChange = () => setMode(prev => riverModeAfterChange(prev, document.fullscreenElement != null && document.fullscreenElement === ref.current))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [ref])

  useEffect(() => {
    if (mode === 'off') return
    // Native fullscreen: the browser normally consumes Esc itself (and fires
    // fullscreenchange); when the key does reach the page, it exits the same way.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
      setMode('off')
    }
    const root = document.documentElement
    document.addEventListener('keydown', onKey)
    if (mode === 'css') root.classList.add('rev-fs-lock')
    return () => {
      document.removeEventListener('keydown', onKey)
      root.classList.remove('rev-fs-lock')
    }
  }, [mode])

  // (Navigating away needs no cleanup: removing the fullscreen element from
  // the document ends native fullscreen, and the CSS mode dies with the view.)

  const toggle = useCallback(() => {
    if (mode !== 'off') {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
      setMode('off')
      return
    }
    const el = ref.current
    if (!el) return
    void requestRiverFullscreen(el).then(setMode)
  }, [mode, ref])

  return { mode, fullscreen: mode !== 'off', toggle }
}
