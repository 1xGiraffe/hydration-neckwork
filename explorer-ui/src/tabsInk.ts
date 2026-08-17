// Sliding active-tab indicator, app-wide, as a progressive enhancement. Every
// `.tabs` bar gets a `::before` ink line (see global.css) whose position is
// two CSS custom properties on the bar itself; this module only writes those
// two variables plus a `has-ink` class, so it never inserts DOM into
// React-owned children (an appended child made the reconciler and the
// MutationObserver fight — the page wedged) and never forces layout flushes.
// Without JS the per-button underline fallback still renders; under
// prefers-reduced-motion the ink renders too, just without sliding (the
// global reduced-motion CSS zeroes its transition).

const BAR_SELECTOR = '.tabs'

function activeButton(bar: HTMLElement): HTMLElement | null {
  for (const child of bar.children) {
    if (child instanceof HTMLElement && child.classList.contains('active')) return child
  }
  return null
}

function position(bar: HTMLElement): void {
  const active = activeButton(bar)
  if (!active) {
    bar.classList.remove('has-ink')
    return
  }
  // offsetLeft is layout-relative (scroll-independent) and the ink renders
  // inside the scrollport, so a horizontally scrolled bar keeps it under its tab.
  bar.style.setProperty('--ink-left', `${active.offsetLeft}px`)
  bar.style.setProperty('--ink-width', `${active.offsetWidth}px`)
  // First placement must not slide in from 0: enable the transition only after
  // the initial position has been committed in a separate frame.
  if (!bar.classList.contains('has-ink')) {
    bar.classList.add('has-ink')
    window.requestAnimationFrame(() => bar.classList.add('ink-live'))
  }
}

function positionAll(): void {
  document.querySelectorAll<HTMLElement>(BAR_SELECTOR).forEach(position)
}

let scheduled = false
/** Coalesce bursts of mutations into one rAF pass — and never re-enter. */
function schedulePositionAll(): void {
  if (scheduled) return
  scheduled = true
  window.requestAnimationFrame(() => {
    scheduled = false
    positionAll()
  })
}

/** Idempotent app-level init (called once from main.tsx). */
export function initTabsInk(): void {
  if (typeof document === 'undefined') return

  // Class flips (active moving between buttons) and mounted/unmounted bars.
  // Our own writes are style/class on the BAR: the class additions happen at
  // most once per bar and re-adding an existing class emits no record, and
  // the rAF coalescing breaks any remaining feedback into one settled pass.
  const mutations = new MutationObserver(schedulePositionAll)
  mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })

  window.addEventListener('resize', schedulePositionAll, { passive: true })
  if (document.fonts?.ready) void document.fonts.ready.then(schedulePositionAll)

  schedulePositionAll()
}
