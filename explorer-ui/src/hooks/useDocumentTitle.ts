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
