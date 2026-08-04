import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { api } from '../api/explorer'
import type { SearchResult } from '../types'
import { AccountEmoji, ShortAddr, noAutofill } from './ui'
import { tokenizeAddresses } from './accountTokens'

// Email-recipient style account input: picked accounts sit as removable chips
// ahead of a free-text field that both SEARCHES (identity/name/address via the
// explorer's search endpoint, accounts only) and ACCEPTS pasted addresses —
// any run of whitespace/commas tokenizes into chips, so a list dumped from a
// spreadsheet just works. Values handed back are display addresses; the server
// normalizes and validates on submit, so the parent's inline error path stays
// the single source of validation truth.
//
// Two modes, picked by which callback the parent passes:
//  - `values`/`onChange` (Invites): the picker owns a staging list of chips the
//    parent doesn't act on until a separate button (Invite/Revoke) is pressed —
//    two distinct actions can't be inferred from a bare Enter.
//  - `onCommit` (a tag's member editor): there is only one action, so a
//    pick/Enter/paste-tokenize fires `onCommit` immediately and clears the
//    input instead of staging a chip — the picker renders no STAGING chips of
//    its own in this mode. The parent's own already-committed members render
//    as `chips`, a slot placed ahead of the input inside the very same
//    `.acct-picker-box` (see ListDetail's tag member editor) — one bordered
//    token surface, not a picker with a separate chip list bolted underneath.
//    The input clears optimistically, but a batch (a multi-token paste, or a
//    name-search result fired mid-typing) can still partly fail server-side —
//    `onCommit` may return the addresses it never got to (submits
//    sequentially and stops at the first rejection, like Invites' own
//    Invite/Revoke), and whatever comes back is restored into the input as
//    text rather than silently dropped.

const looksAddr = (s?: string) => !!s && (s.startsWith('0x') || /^[1-9A-HJ-NP-Za-km-z]{40,}$/.test(s))

export function AccountPicker({ values = [], onChange, onCommit, chips, placeholder, disabled, inputId }: {
  values?: string[]
  onChange?: (next: string[]) => void
  onCommit?: (addresses: string[]) => Promise<string[] | void> | void
  // Rendered ahead of the input, inside `.acct-picker-box` — only meaningful
  // alongside `onCommit` (the `values` mode renders its own chips instead).
  chips?: ReactNode
  placeholder?: string
  disabled?: boolean
  inputId?: string
}) {
  const [text, setText] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  // The dropdown's visibility DERIVES from the current text + results (plus an
  // explicit dismiss flag) rather than being set inside the search effect —
  // synchronous setState in an effect cascades renders and trips the lint.
  const [dismissed, setDismissed] = useState(false)
  const [cursor, setCursor] = useState(0)
  // Pretty chip labels for accounts picked from search (identity display);
  // pasted chips just shorten. Keyed by the chip value.
  const [labels, setLabels] = useState<Record<string, string>>({})
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  // Debounced account search; aborted when the query moves on. Pure addresses
  // don't need a lookup round trip to be addable, but searching them anyway
  // lets a full pasted address show its identity before being picked.
  useEffect(() => {
    const q = text.trim()
    if (q.length < 2) return
    const ctl = new AbortController()
    const t = setTimeout(() => {
      api.search(q, ctl.signal)
        .then(all => {
          setResults(all.filter(r => r.type === 'address').slice(0, 6))
          setCursor(0)
          setDismissed(false)
        })
        .catch(() => { /* aborted or offline — typing/pasting still works */ })
    }, 200)
    return () => { clearTimeout(t); ctl.abort() }
  }, [text])

  const openList = !dismissed && text.trim().length >= 2 && results.length > 0

  useEffect(() => {
    if (!openList) return
    const close = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setDismissed(true) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [openList])

  function addChips(next: string[], nextLabels?: Record<string, string>) {
    if (onCommit) {
      // Clears optimistically (the common case: everything lands) — any
      // addresses `onCommit` reports back as unsent (it never resolved, or
      // failed partway through a batch) are restored as text, not lost.
      // Clearing `text`/`results` in the same tick also closes the dropdown
      // (`openList` derives from both), so there's nothing left clickable to
      // double-fire a second commit while the caller's own `disabled` prop
      // hasn't yet propagated back down through a re-render.
      setText('')
      setResults([])
      const pending = onCommit(next)
      if (pending) void pending.then(remainder => { if (remainder?.length) setText(remainder.join(' ')) })
      return
    }
    const merged = [...values]
    for (const v of next) if (!merged.includes(v)) merged.push(v)
    if (nextLabels) setLabels(prev => ({ ...prev, ...nextLabels }))
    onChange?.(merged)
    setText('')
    setResults([])
  }

  function pick(r: SearchResult) {
    const addr = looksAddr(r.label) ? r.label! : r.value
    const identity = r.identity?.display ?? (looksAddr(r.label) ? undefined : r.label)
    addChips([addr], identity ? { [addr]: identity } : undefined)
    inputRef.current?.focus()
  }

  function commitText() {
    const tokens = tokenizeAddresses(text)
    if (tokens.length) addChips(tokens)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!onCommit && e.key === 'Backspace' && !text && values.length) {
      onChange?.(values.slice(0, -1))
      return
    }
    if (openList && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setCursor(c => (c + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (openList && results[cursor]) pick(results[cursor])
      else commitText()
      return
    }
    if (e.key === ',' || e.key === ' ') {
      // Separators commit the pending token instead of typing — but only when
      // it already looks like an address; names with spaces keep searching.
      if (looksAddr(text.trim())) { e.preventDefault(); commitText() }
      return
    }
    if (e.key === 'Escape') setDismissed(true)
  }

  return (
    <div className="acct-picker" ref={rootRef}>
      <div className={`acct-picker-box${disabled ? ' disabled' : ''}`} onClick={() => inputRef.current?.focus()}>
        {!onCommit && values.map(v => (
          <span key={v} className="acct-chip">
            <span className="acct-chip-label">{labels[v] ?? <ShortAddr addr={v} />}</span>
            <button type="button" className="acct-chip-x" aria-label={`Remove ${labels[v] ?? v}`} disabled={disabled} onClick={() => onChange?.(values.filter(x => x !== v))}>×</button>
          </span>
        ))}
        {onCommit && chips}
        <input {...noAutofill}
          ref={inputRef}
          id={inputId}
          value={text}
          disabled={disabled}
          placeholder={!onCommit && values.length ? '' : placeholder}
          role="combobox"
          aria-expanded={openList}
          aria-controls={listId}
          aria-autocomplete="list"
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => { if (looksAddr(text.trim())) commitText() }}
          onPaste={e => {
            const pasted = e.clipboardData.getData('text')
            const tokens = tokenizeAddresses(pasted)
            // A multi-token or address-shaped paste chips immediately; a name
            // paste falls through to normal typing → search.
            if (tokens.length > 1 || (tokens.length === 1 && looksAddr(tokens[0]))) {
              e.preventDefault()
              addChips(tokens)
            }
          }}
        />
      </div>
      {openList && (
        <div className="acct-picker-results" id={listId} role="listbox">
          {results.map((r, i) => {
            const addr = looksAddr(r.label) ? r.label! : r.value
            return (
              <button
                key={`${r.value}-${i}`}
                type="button"
                role="option"
                aria-selected={i === cursor}
                className={`acct-picker-row${i === cursor ? ' active' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(r)}
              >
                <AccountEmoji account={{ emoji: r.emoji, emojiName: r.emojiName, emojiUrl: r.emojiUrl, accountId: r.value }} className="sr-emoji" />
                {r.identity?.display && <span className="acct-picker-name">{r.identity.display}{r.identity.verified && <span className="id-verified" title="Verified identity"> ✓</span>}</span>}
                <span className="mono acct-picker-addr"><ShortAddr addr={addr} /></span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
