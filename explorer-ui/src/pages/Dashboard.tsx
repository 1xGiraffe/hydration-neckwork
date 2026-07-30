import { SearchBar } from '../components/SearchBar'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

// Search-first start page; navigation remains in the top bar.
export function Dashboard() {
  useDocumentTitle()
  return (
    <section className="hero hero-search start">
      <div className="wrap">
        <SearchBar variant="hero" />
      </div>
    </section>
  )
}
