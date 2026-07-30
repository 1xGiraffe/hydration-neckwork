import { useCallback, useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'

function readTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'dark' || attr === 'light') return attr
  return 'dark'
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme)

  useEffect(() => {
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
  }, [theme])

  const toggle = useCallback(() => setTheme(t => (t === 'dark' ? 'light' : 'dark')), [])

  return { theme, toggle }
}
