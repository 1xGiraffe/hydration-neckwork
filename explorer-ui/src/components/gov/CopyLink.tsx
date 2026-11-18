import { useEffect, useState } from 'react'

/**
 * "Copy link" as an icon button for a page's header row: the link icon flips to a
 * check for a moment, and a polite live region says it was copied.
 */
export function CopyLinkButton({ url, what }: { url: string; what: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 1400)
    return () => clearTimeout(t)
  }, [done])
  const name = done ? 'Link copied' : `Copy a link to ${what}`
  return (
    <>
      <button type="button" className={`gov-icon-btn${done ? ' done' : ''}`} title={name} aria-label={name}
        onClick={() => { void navigator.clipboard?.writeText(url); setDone(true) }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {done
            ? <path d="M20 6 9 17l-5-5" />
            : <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>}
        </svg>
      </button>
      <span className="sr-only" aria-live="polite">{done ? 'Link copied' : ''}</span>
    </>
  )
}
