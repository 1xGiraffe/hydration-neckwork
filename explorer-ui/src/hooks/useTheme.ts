import { useState, useEffect, useCallback } from 'react'

type Theme = 'dark' | 'light'

const STORAGE_KEY = 'explorer-theme'

function currentTheme(): Theme {
  const t = document.documentElement.getAttribute('data-theme')
  return t === 'light' ? 'light' : 'dark'
}

function hasSavedTheme(): boolean {
  try {
    const t = localStorage.getItem(STORAGE_KEY)
    return t === 'light' || t === 'dark'
  } catch {
    return false
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(currentTheme)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#030816' : '#EFEDEA')
  }, [theme])
  // Follow OS changes live until the visitor picks a theme themselves.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: light)')
    if (!mq) return
    const onChange = (e: MediaQueryListEvent) => {
      if (!hasSavedTheme()) setTheme(e.matches ? 'light' : 'dark')
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  // Only an explicit toggle is persisted; without one, index.html follows the OS.
  const toggle = useCallback(() => setTheme(t => {
    const next = t === 'dark' ? 'light' : 'dark'
    try { localStorage.setItem(STORAGE_KEY, next) } catch { /* ignore */ }
    return next
  }), [])
  return { theme, toggle }
}
