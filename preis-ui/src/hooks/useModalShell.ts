import { useEffect, type RefObject } from 'react'
import { keepTabFocusInside } from '../utils/focus'

/**
 * The behaviour every modal surface in the app shares while it is open: focus
 * moves to its close button, Tab stays inside the panel, the page behind it
 * stops scrolling, Escape closes it, and focus returns to whatever opened it.
 *
 * Escape is ignored once another surface has claimed it (`defaultPrevented`),
 * so a dialog stacked on top consumes the press alone — one press must never
 * tear down both, which would also drop the lower surface's URL state.
 *
 * `onClose` has to be referentially stable (a `useCallback`); an inline arrow
 * would re-run the effect on every render and pull focus back each time.
 */
export function useModalShell(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  closeRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    const focusFrame = window.requestAnimationFrame(() => closeRef.current?.focus())
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      keepTabFocusInside(event, panelRef.current)
    }
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [open, panelRef, closeRef, onClose])
}
