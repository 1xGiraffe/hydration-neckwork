import { useCallback, useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'

function readTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'dark' || attr === 'light') return attr
  return 'dark'
}

// `data-theme` carries the CSS custom properties, so anything that paints from a
// computed token (the chart canvas) reads the document rather than this state.
// That makes WHEN the attribute lands part of the contract: React runs a child's
// effects before its parent's, so setting it in an effect here would let the
// chart repaint a frame in the outgoing palette. Applying it in the same turn as
// the state change keeps the document and the tree in step.
function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  try {
    localStorage.setItem('preis-theme', theme)
  } catch {
    // Ignore persistence failures; the current document theme is already set.
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    theme === 'dark' ? '#030816' : '#EFEDEA'
  )
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme)

  // Seeds a document that has no attribute yet (a first visit restores nothing).
  useEffect(() => { applyTheme(theme) }, [theme])

  // Flips against the document, not a captured value, so the callback needs no
  // dependency on the current theme and cannot act on a stale one.
  const toggle = useCallback(() => {
    const next: Theme = readTheme() === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    setTheme(next)
  }, [])

  return { theme, toggle }
}
