import { useEffect } from 'react'

const DEFAULT_TITLE = 'Hydration Explorer'

// Entity-first document title, no product suffix ("Block #9,700,000", "DOT $3.42",
// "Treasury · 13UV…FsTB"). Pass nothing (or null) while data is loading to keep
// the default until the entity is known.
export function useDocumentTitle(title?: string | null) {
  useEffect(() => {
    document.title = title || DEFAULT_TITLE
    return () => { document.title = DEFAULT_TITLE }
  }, [title])
}

// Keeps a page that turned out to name nothing out of the search index.
//
// A single-page app cannot answer 404: nginx has already sent 200 with the shell
// by the time the router knows the id is unresolvable, and Google counts such a
// page as a soft 404 against the whole site. A robots meta tag added after the
// fact is the documented remedy — Google renders every 200 it fetches, so it
// reads a tag JavaScript wrote.
//
// Most unresolvable ids are already caught server-side (api/src/routes/seo.ts
// marks them before the HTML is sent); this covers what that cannot see — the
// router's own "not found" state, and a detail page whose entity the API
// reports missing only after the request completes.
//
// Removed on unmount, so navigating on from a missing page does not leave the
// next one silently unindexable.
export function useNoindex(active: boolean) {
  useEffect(() => {
    if (!active) return
    const existing = document.querySelector('meta[name="robots"]')
    if (existing) return   // the server already said it; leave its wording alone
    const tag = document.createElement('meta')
    tag.name = 'robots'
    tag.content = 'noindex'
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, [active])
}
