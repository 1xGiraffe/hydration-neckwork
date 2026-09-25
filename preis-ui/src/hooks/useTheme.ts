import { useCallback, useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'preis-theme'
const LIGHT_QUERY = '(prefers-color-scheme: light)'

function readTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'dark' || attr === 'light') return attr
  return 'dark'
}

function savedTheme(): Theme | null {
  try {
    const t = localStorage.getItem(STORAGE_KEY)
    return t === 'dark' || t === 'light' ? t : null
  } catch {
    return null
  }
}

// `data-theme` carries the CSS custom properties, so anything that paints from a
// computed token (the chart canvas) reads the document rather than this state.
// That makes WHEN the attribute lands part of the contract: React runs a child's
// effects before its parent's, so setting it in an effect here would let the
// chart repaint a frame in the outgoing palette. Applying it in the same turn as
// the state change keeps the document and the tree in step.
function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    theme === 'dark' ? '#030816' : '#EFEDEA'
  )
}

// Only an explicit toggle is persisted: a visitor who never chose keeps
// following the OS setting (index.html bootstraps it before first paint).
function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Ignore persistence failures; the current document theme is already set.
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme)

  // Seeds a document that has no attribute yet.
  useEffect(() => { applyTheme(theme) }, [theme])

  // Tracks OS changes live until the visitor picks a theme themselves.
  useEffect(() => {
    const mq = window.matchMedia?.(LIGHT_QUERY)
    if (!mq) return
    const onChange = (e: MediaQueryListEvent) => {
      if (savedTheme()) return
      const next: Theme = e.matches ? 'light' : 'dark'
      applyTheme(next)
      setTheme(next)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // Flips against the document, not a captured value, so the callback needs no
  // dependency on the current theme and cannot act on a stale one.
  const toggle = useCallback(() => {
    const next: Theme = readTheme() === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    persistTheme(next)
    setTheme(next)
  }, [])

  return { theme, toggle }
}
