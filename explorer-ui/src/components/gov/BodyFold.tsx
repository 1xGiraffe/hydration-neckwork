import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react'

// A forum text read lightly, the same everywhere it is shown (a referendum's
// description, a proposer's updates, a thread's comments): a long text shows its
// opening under a fade until the reader asks for the rest, a long code block its
// first lines, and an image opens full size.

/** Code blocks past this many lines show their first lines and a "Show all N lines". */
const CODE_LINES = 16

/** A folded text that would hide less than this (about two lines) is shown whole instead. */
const FOLD_SLACK_PX = 48

/**
 * A long text stays readable: a code block over CODE_LINES lines is cut to its first
 * lines with a button for the rest, and each image (capped in height by the CSS)
 * opens full size in a new tab. Applied to the rendered text inside `root` (re-applied
 * whenever it re-renders); the controls are built with DOM calls and text only, and an
 * image link points only at the image's own /ipfs/ address, which the renderer has
 * already vetted.
 */
function useLongBodyControls(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current
    if (!el) return
    const apply = () => {
      for (const pre of Array.from(el.querySelectorAll<HTMLPreElement>('.md-body pre'))) {
        if (pre.dataset.clamp) continue
        const lines = (pre.textContent ?? '').replace(/\n$/, '').split('\n').length
        if (lines <= CODE_LINES) { pre.dataset.clamp = 'none'; continue }
        pre.dataset.clamp = 'on'
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'gov-more md-pre-more'
        btn.setAttribute('aria-expanded', 'false')
        btn.textContent = `Show all ${lines} lines`
        btn.addEventListener('click', () => {
          const opening = pre.dataset.clamp === 'on'
          pre.dataset.clamp = opening ? 'off' : 'on'
          btn.setAttribute('aria-expanded', String(opening))
          btn.textContent = opening ? 'Show fewer lines' : `Show all ${lines} lines`
        })
        pre.after(btn)
      }
      for (const img of Array.from(el.querySelectorAll<HTMLImageElement>('.md-body img.md-img'))) {
        const src = img.getAttribute('src') ?? ''
        if (img.closest('a') || !/^\/ipfs\/[A-Za-z0-9]+$/.test(src)) continue
        const a = document.createElement('a')
        a.href = src
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        a.className = 'md-img-open'
        a.title = 'Open the full image'
        img.replaceWith(a)
        a.append(img)
      }
    }
    apply()
    const obs = new MutationObserver(apply)
    obs.observe(el, { childList: true, subtree: true })
    return () => obs.disconnect()
  }, [root])
}

/**
 * The text (its single child, a rendered Markdown body) with the long-text controls,
 * and — `fold` — folded when long: it shows its opening under a fade (the height is in
 * the CSS, by `size`), and the faded text itself is the control — a tap or click
 * anywhere on it shows the rest. A click that follows a link, presses a control in the
 * text or ends a text selection is left alone, so reading and copying work as on any
 * page; a mouse sees the hint on hover, a keyboard reaches the same expand through the
 * fade's own button. Whether the text overflows is measured, not guessed from its
 * length, and re-measured as images load, the width changes or the text is replaced.
 * `open`: start unfolded (a permalink to this text).
 */
export function BodyFold({ children, fold = true, size = 'page', open = false }: {
  children: ReactNode
  fold?: boolean
  size?: 'page' | 'inline'
  open?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(open)
  const [overflows, setOverflows] = useState<boolean | null>(null)
  const active = fold && !expanded
  useLongBodyControls(box)
  useLayoutEffect(() => {
    const el = box.current?.firstElementChild
    if (!active || !(el instanceof HTMLElement)) return
    const measure = () => setOverflows(el.scrollHeight - el.clientHeight > FOLD_SLACK_PX)
    const ro = new ResizeObserver(measure)
    const observe = () => {
      ro.disconnect()
      ro.observe(el)
      for (const child of Array.from(el.children)) ro.observe(child)
      measure()
    }
    observe()
    // An edit replaces the text's children: watch the new ones too.
    const mo = new MutationObserver(observe)
    mo.observe(el, { childList: true })
    return () => { ro.disconnect(); mo.disconnect() }
  }, [active])
  const folded = active && overflows !== false
  const expand = () => {
    setExpanded(true)
    // The fade's button goes with the fold: keep the keyboard where the text continues.
    box.current?.focus({ preventScroll: true })
  }
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!folded) return
    const t = e.target as HTMLElement
    if (t.closest('a, button, summary, input, textarea, select, label, [role="button"]')) return
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && box.current?.contains(sel.anchorNode)) return
    expand()
  }
  return (
    <div ref={box} tabIndex={-1} className={`gov-post-fold${size === 'inline' ? ' inline' : ''}${folded ? ' clamped' : ''}`} onClick={onClick}>
      {children}
      {folded && (
        <button type="button" className="gov-post-fold-more" aria-expanded={false} onClick={expand}>
          <span className="sr-only">Show the full text</span>
          <svg aria-hidden viewBox="0 0 16 16" width="16" height="16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      )}
    </div>
  )
}
