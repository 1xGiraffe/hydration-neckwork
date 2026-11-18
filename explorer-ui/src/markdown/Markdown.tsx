import { useLayoutEffect, useMemo, useRef, type MouseEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { navigate } from '../router'
import { api } from '../api/explorer'
import { renderForumBody, type BodyFormat, type RefContext } from './render'

/**
 * What a `#N` in this body may link to: the highest OpenGov and democracy indexes,
 * from the governance overview (the same cached read the governance pages use),
 * fetched only for a body that has a `#` followed by a digit.
 */
function useRefContext(body: string, native: boolean): RefContext | undefined {
  const wanted = /#\d/.test(body)
  const q = useQuery({ queryKey: ['governance'], queryFn: ({ signal }) => api.governance(signal), enabled: wanted, staleTime: 300_000 })
  const counts = q.data?.counts
  return useMemo(() => (wanted && counts
    ? { native, maxOpenGov: counts.opengov > 0 ? counts.opengov - 1 : null, maxDemocracy: counts.democracy > 0 ? counts.democracy - 1 : null }
    : undefined), [wanted, counts, native])
}

// Mounts a forum body rendered by render.ts. The fragment is sanitized and policed
// before it reaches the live document, and is attached with replaceChildren — this
// component never hands a string to innerHTML. Same-origin links navigate inside the
// app; external ones open a new tab (the renderer set their target and rel).
// `native` says the text was written here rather than imported, which decides how
// a `#N` in it is read (render.ts RefContext).
export function Markdown({ body, format, media, className, native = false }: {
  body: string
  format: BodyFormat
  media?: Record<string, string>
  className?: string
  native?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const refs = useRefContext(body, native)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.replaceChildren(renderForumBody({ body, format, media, refs }))
  }, [body, format, media, refs])

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = (e.target as HTMLElement).closest('a[data-internal]')
    if (!a || !ref.current?.contains(a)) return
    const href = a.getAttribute('href')
    if (!href || !href.startsWith('/') || href.startsWith('//')) return
    e.preventDefault()
    navigate(href)
  }

  // The click handler only routes clicks on the links inside; the links themselves
  // are the keyboard-reachable controls.
  return <div ref={ref} className={`md-body${className ? ` ${className}` : ''}`} onClick={onClick} />
}
