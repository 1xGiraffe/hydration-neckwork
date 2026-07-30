import { useState, useEffect, useCallback } from 'react'

type Theme = 'dark' | 'light'

function currentTheme(): Theme {
  const t = document.documentElement.getAttribute('data-theme')
  return t === 'light' ? 'light' : 'dark'
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(currentTheme)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem('explorer-theme', theme) } catch { /* ignore */ }
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#030816' : '#EFEDEA')
  }, [theme])
  const toggle = useCallback(() => setTheme(t => (t === 'dark' ? 'light' : 'dark')), [])
  return { theme, toggle }
}
