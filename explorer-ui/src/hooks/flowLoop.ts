// ONE requestAnimationFrame loop for every revenue river on the page. Two
// rivers with a loop each would schedule two rAF callbacks per frame and two
// rounds of React state updates; with one, both rivers' schedulers drain in the
// same frame and the browser composites once. The loop runs while at least one
// river is subscribed and skips work while the document is hidden (browsers
// already suspend rAF for hidden pages; the check covers a restored page whose
// visibility flag lags). A frame firing is itself proof of visibility, which is
// what each river uses to self-heal a stale paused flag.

type FrameFn = (now: number) => void

const subscribers = new Set<FrameFn>()
let frame = 0

function loop(): void {
  if (typeof document === 'undefined' || !document.hidden) {
    const now = Date.now()
    for (const fn of subscribers) fn(now)
  }
  frame = window.requestAnimationFrame(loop)
}

export function subscribeFrame(fn: FrameFn): () => void {
  subscribers.add(fn)
  if (subscribers.size === 1) frame = window.requestAnimationFrame(loop)
  return () => {
    subscribers.delete(fn)
    if (subscribers.size === 0) {
      window.cancelAnimationFrame(frame)
      frame = 0
    }
  }
}

/** Subscribed frame callbacks right now (tests: one loop serves every river). */
export const frameSubscriberCount = (): number => subscribers.size
