import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { termText, type TermKey } from './terms'

// The governance pages' three ways of keeping things one step away, and only these:
//  - Terms: what a word means. One "Terms on this page" fold per page (the house
//    `.ice-gloss`, as on /intents), and an ⓘ next to a single term in a sentence.
//  - Details: more facts about this item. `<GovDetails>`, always the last thing in
//    its section or sheet, never two in a row.
//  - Show more: more of the same list — the `.gov-more` button where the list is.

/** The page's one "Terms on this page" fold. `extra` adds page-specific entries (a data note, say). */
export function GovTerms({ terms, days, extra, className }: { terms: TermKey[]; days?: number[] | null; extra?: { dt: string; dd: ReactNode }[]; className?: string }) {
  const rows = [...terms.map(t => termText(t, days)), ...(extra ?? [])]
  return (
    <details className={`ice-gloss gov-terms${className ? ` ${className}` : ''}`}>
      <summary>Terms on this page</summary>
      <dl>{rows.map(r => <div key={r.dt} className="gov-terms-row"><dt>{r.dt}</dt><dd>{r.dd}</dd></div>)}</dl>
    </details>
  )
}

/**
 * An ⓘ beside one term or number: a small button whose note opens on click (and
 * closes on Escape, a click elsewhere or leaving it), so it works on touch as well
 * as with a mouse or keyboard. `label` names what it explains ("About support").
 */
export function InfoTip({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const ref = useRef<HTMLSpanElement>(null)
  const pop = useRef<HTMLSpanElement>(null)
  const [shift, setShift] = useState(0)
  // The note hangs from the ⓘ, so one near the right edge of a phone (a table
  // header, the end of a line) would reach past the screen and make the page
  // scroll sideways. Pull it left by what sticks out, keeping a 12px margin (by
  // `left`, not a transform: a transformed box still widens the page's scroll area).
  useLayoutEffect(() => {
    if (!open || !pop.current) { setShift(0); return }
    // Measured unshifted: closing resets the shift, and this runs only on opening.
    const r = pop.current.getBoundingClientRect()
    const vw = document.documentElement.clientWidth
    const over = r.right - (vw - 12)
    setShift(over > 0 ? Math.min(over, r.left - 12) : r.left < 12 ? r.left - 12 : 0)
  }, [open])
  useEffect(() => {
    if (!open) return
    const away = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  return (
    <span ref={ref} className={`gov-info${className ? ` ${className}` : ''}`} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false) }}>
      <button type="button" className="gov-info-btn" aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(o => !o)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M8 7.2v3.9M8 4.9v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
      {open && <span ref={pop} id={id} role="note" className="gov-info-pop" style={shift ? { left: -8 - shift } : undefined}>{children}</span>}
    </span>
  )
}

/** More facts about an item, closed by default: the last thing in its section or sheet. */
export function GovDetails({ summary = 'More details', children, className, open }: { summary?: ReactNode; children: ReactNode; className?: string; open?: boolean }) {
  return (
    <details className={`gov-details${className ? ` ${className}` : ''}`} open={open}>
      <summary>{summary}</summary>
      <div className="gov-details-body">{children}</div>
    </details>
  )
}
