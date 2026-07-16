import { useState, useRef, useEffect, useId } from 'react'
import { api } from '../api/explorer'
import { navigate, paths } from '../router'
import type { SearchResult } from '../types'
import { ShortAddr, AccountEmoji, AssetIcon, TagIcon } from './ui'

// `value` is the canonical AccountId32 (public-key hex); `label` carries the
// human SS58/EVM form. Account links and display must use the latter.
const srLooksAddr = (s?: string) => !!s && (s.startsWith('0x') || /^[1-9A-HJ-NP-Za-km-z]{40,}$/.test(s))

function routeFor(r: SearchResult): string {
  switch (r.type) {
    case 'block': return paths.block(r.value)
    case 'extrinsic': return paths.extrinsic(r.value)
    // Never link to the raw public key — use the SS58/EVM address from `label`.
    case 'address': return paths.account(srLooksAddr(r.label) ? r.label! : r.value)
    case 'asset': return paths.asset(Number(r.value))
    case 'tag': return paths.tag(r.value)
    default: return paths.dashboard()
  }
}
const TYPE_LABEL: Record<SearchResult['type'], string> = {
  block: 'Block', extrinsic: 'Extrinsic', address: 'Account', asset: 'Asset', tag: 'Tag',
}

// Account results use the same avatar and shortened-address treatment as account
// pills. Identity names remain secondary so the address stays visible in compact
// dropdowns.
function SearchResultBody({ r }: { r: SearchResult }) {
  if (r.type === 'address') {
    // `label` is the SS58 for a direct address hit, or the identity display for
    // an identity-name hit; `value` is the canonical accountId32.
    const addr = srLooksAddr(r.label) ? r.label! : r.value
    const ident = r.identity
    return (
      <span className="sr-acct">
        <AccountEmoji account={{ emoji: r.emoji, emojiName: r.emojiName, emojiUrl: r.emojiUrl, accountId: r.value }} className="sr-emoji" />
        <span className="sr-val mono"><ShortAddr addr={addr} /></span>
        {ident?.display
          ? <span className="sr-acct-identity">{ident.display}{ident.verified && <span className="id-verified" title="Verified identity"> ✓</span>}</span>
          : null}
      </span>
    )
  }
  if (r.type === 'asset') {
    const asset = r.asset
    return (
      <span className="sr-acct">
        <AssetIcon assetId={Number(r.value)} iconAssetId={asset?.iconAssetId} symbol={r.label || r.value} size={20} parachainId={asset?.parachainId} origin={asset?.origin} />
        <span className="sr-acct-name"><span className="mono">{r.label || r.value}</span>{r.desc && r.desc !== r.label && <span className="sr-desc">{r.desc}</span>}</span>
      </span>
    )
  }
  if (r.type === 'tag') {
    return (
      <span className="sr-acct">
        <TagIcon icon={r.icon ?? ''} color={r.color} size={20} title={r.label || r.value} />
        <span className="sr-acct-name"><span className="mono">{r.label || r.value}</span></span>
      </span>
    )
  }
  return <span className="sr-val mono">{r.label || r.value}</span>
}

export function SearchBar({ variant }: { variant: 'hero' | 'topbar' }) {
  const [value, setValue] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [searched, setSearched] = useState(false)
  const debounce = useRef<number | undefined>(undefined)
  const blurTimeout = useRef<number | undefined>(undefined)
  const searchAbort = useRef<AbortController | null>(null)
  const searchSequence = useRef(0)
  const resultsId = useId()

  async function runSearch(qRaw: string) {
    const q = qRaw.trim()
    const sequence = ++searchSequence.current
    searchAbort.current?.abort()
    if (!q) { setResults([]); setOpen(false); setSearched(false); return }
    const controller = new AbortController()
    searchAbort.current = controller
    try {
      const r = await api.search(q, controller.signal)
      if (controller.signal.aborted || sequence !== searchSequence.current) return
      setResults(r); setActive(0); setOpen(true); setSearched(true)
    } catch {
      if (controller.signal.aborted || sequence !== searchSequence.current) return
      setResults([]); setOpen(true); setSearched(true)
    } finally {
      if (searchAbort.current === controller) searchAbort.current = null
    }
  }
  function onChange(v: string) {
    setValue(v)
    // Invalidate the in-flight query immediately. Waiting for the next debounce
    // would leave a short window where an old response can paint under new text.
    searchSequence.current++
    searchAbort.current?.abort()
    window.clearTimeout(debounce.current)
    if (!v.trim()) {
      setResults([]); setOpen(false); setSearched(false)
      return
    }
    debounce.current = window.setTimeout(() => runSearch(v), 180)
  }
  function go(r: SearchResult) {
    searchSequence.current++
    searchAbort.current?.abort()
    navigate(routeFor(r)); setOpen(false); setValue(''); setResults([]); setSearched(false)
  }
  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { if (results[active]) go(results[active]); else runSearch(value) }
    else if (e.key === 'Escape') { setOpen(false) }
  }

  useEffect(() => () => {
    window.clearTimeout(debounce.current)
    window.clearTimeout(blurTimeout.current)
    searchSequence.current++
    searchAbort.current?.abort()
  }, [])

  return (
    <div className={`search ${variant === 'hero' ? 'xl' : ''} search-wrap`} id={variant === 'hero' ? 'heroSearch' : undefined}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
      <input
        id={variant === 'hero' ? 'heroSearchInput' : 'topbarSearchInput'}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKey}
        onFocus={() => { window.clearTimeout(blurTimeout.current); if (results.length) setOpen(true) }}
        onBlur={() => { blurTimeout.current = window.setTimeout(() => setOpen(false), 160) }}
        placeholder="Account, Asset, Hash, Block, Tag"
        aria-label="Search explorer"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && !!value.trim()}
        aria-controls={resultsId}
        aria-activedescendant={open && results[active] ? `${resultsId}-option-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
      />
      {variant === 'hero' && <span className="hint">↵</span>}
      {variant === 'topbar' && <span className="kbd-slash" title="Press / to search">/</span>}
      <div id={resultsId} className="search-results" role="listbox" aria-label="Search results" hidden={!open || !value.trim()}>
        {results.length ? results.map((r, i) => (
          <a key={`${r.type}:${r.value}`} id={`${resultsId}-option-${i}`} role="option" aria-selected={i === active} className={`sr-item${i === active ? ' on' : ''}`} href={routeFor(r)}
            onMouseDown={e => { e.preventDefault(); go(r) }} onMouseEnter={() => setActive(i)}>
            <span className="sr-type">{TYPE_LABEL[r.type]}</span>
            <SearchResultBody r={r} />
          </a>
        )) : <div className="sr-empty" role="status">{searched ? `No match for “${value.trim()}”` : 'Searching…'}</div>}
      </div>
    </div>
  )
}
