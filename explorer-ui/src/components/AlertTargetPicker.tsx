/* eslint-disable react-refresh/only-export-components -- the picker plus the pure option builders its tests exercise directly */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { api } from '../api/explorer'
import { useMe } from '../hooks/useUser'
import { useSession } from '../session'
import { isAddressLike } from '../notificationKinds'
import { searchUserTags, useTagMapVersion, type UserTagSearchHit } from '../userTags'
import type { NotificationTarget, SearchResult } from '../types'
import { AccountEmoji, ShortAddr, TagIcon, noAutofill } from './ui'

// What an account-activity alert watches, chosen the way anything else on the
// explorer is found: by typing. The same three sources the global search bar
// merges — the shared /explorer/search (accounts and system tags only here),
// the viewer's OWN list tags (client-side, since the shared endpoint is
// anonymous and cached), and a raw address pasted verbatim — so "watch the
// treasury" does not require knowing an SS58 by heart.
//
// A tag target follows the tag's membership: adding an account to the tag
// later widens the alert, which is the whole reason to subscribe to a group
// rather than to the addresses it happens to hold today.

// One row of the dropdown, and equally the chosen value. Deliberately flat and
// serializable: the parent stores it as-is, the wire form comes off `target`,
// and everything else exists to draw the pill.
export interface TargetOption {
  key: string
  target: NotificationTarget
  label: string
  // Account rows
  address?: string
  accountId?: string
  emoji?: string
  emojiUrl?: string
  emojiName?: string
  identity?: string
  identityVerified?: boolean
  // Tag rows
  icon?: string
  color?: string
  memberCount?: number
  listName?: string
  // Why this row is being offered ("My account"), never part of the value.
  note?: string
}

// `label` on an address search result is the SS58/EVM form for a direct address
// hit and the identity display for an identity-name hit; `value` is always the
// canonical AccountId32. Same test the search bar uses.
const looksAddr = (s?: string) => !!s && (s.startsWith('0x') || /^[1-9A-HJ-NP-Za-km-z]{40,}$/.test(s))

export function addressOption(address: string, extra: Partial<TargetOption> = {}): TargetOption {
  const addr = address.trim()
  return { key: `address:${addr.toLowerCase()}`, target: { kind: 'address', address: addr }, label: addr, address: addr, accountId: addr, ...extra }
}

export function optionFromSearchResult(r: SearchResult): TargetOption | null {
  if (r.type === 'address') {
    const addr = looksAddr(r.label) ? r.label! : r.value
    return addressOption(addr, {
      accountId: r.value,
      emoji: r.emoji,
      emojiUrl: r.emojiUrl,
      emojiName: r.emojiName,
      identity: r.identity?.display ?? undefined,
      identityVerified: r.identity?.verified ?? false,
    })
  }
  if (r.type === 'tag') {
    return {
      key: `tag:${r.value}`,
      target: { kind: 'tag', tagId: r.value },
      label: r.label || r.value,
      icon: r.icon ?? '',
      color: r.color ?? '',
    }
  }
  return null
}

export function optionFromUserTag(hit: UserTagSearchHit): TargetOption {
  return {
    key: `list-tag:${hit.listId}:${hit.tagId}`,
    target: { kind: 'list-tag', listId: hit.listId, tagId: hit.tagId },
    label: hit.name,
    icon: hit.icon,
    color: hit.color,
    listName: hit.listName,
  }
}

// The dropdown's rows for one query: the viewer's own list tags first (a
// private name the shared search can never know), then the server's accounts
// and system tags, deduplicated and bounded.
export function targetOptions(results: readonly SearchResult[], userTags: readonly UserTagSearchHit[], limit = 8): TargetOption[] {
  const out: TargetOption[] = userTags.map(optionFromUserTag)
  for (const r of results) {
    const option = optionFromSearchResult(r)
    if (option && !out.some(o => o.key === option.key)) out.push(option)
  }
  return out.slice(0, limit)
}

// A typed value that matched nothing is still a valid target when it is an
// address — the search endpoint only knows accounts it has already seen, and a
// brand-new one is exactly what somebody watching a fresh wallet means.
export function rawAddressOption(text: string): TargetOption | null {
  return isAddressLike(text) ? addressOption(text.trim()) : null
}

function OptionBody({ option }: { option: TargetOption }) {
  if (option.target.kind !== 'address') {
    return (
      <>
        <TagIcon icon={option.icon ?? ''} title={option.label} className="sr-emoji" />
        <span className="acct-picker-name" style={option.color ? { color: option.color } : undefined}>{option.label}</span>
        {option.memberCount && option.memberCount > 1 ? <span className="tag-member-suffix mono">·{option.memberCount}</span> : null}
        {option.listName ? <span className="sr-desc">· {option.listName}</span> : null}
      </>
    )
  }
  return (
    <>
      <AccountEmoji account={{ emoji: option.emoji, emojiName: option.emojiName, emojiUrl: option.emojiUrl, accountId: option.accountId ?? option.address ?? '' }} className="sr-emoji" />
      {option.identity && <span className="acct-picker-name">{option.identity}{option.identityVerified && <span className="id-verified" title="Verified identity"> ✓</span>}</span>}
      <span className="mono acct-picker-addr"><ShortAddr addr={option.address ?? option.label} /></span>
      {option.note && <span className="sr-desc">{option.note}</span>}
    </>
  )
}

const DEBOUNCE_MS = 180

export function AlertTargetPicker({ value, onChange, onTextChange, disabled, inputId, addressOnly }: {
  value: TargetOption | null
  onChange: (option: TargetOption | null) => void
  // The raw text as it is typed. A form that accepts a pasted address verbatim
  // reads this, so somebody who pastes an SS58 and presses "Create alert"
  // without first picking the row the paste offered is not told to try again.
  onTextChange?: (text: string) => void
  disabled?: boolean
  inputId?: string
  // Offer accounts only — no tag rows at all. Fields whose parameter is ONE
  // address (an extrinsic's signer, a health factor's position) cannot express a
  // group, so offering one would be offering something that cannot be created.
  addressOnly?: boolean
}) {
  useTagMapVersion()   // the viewer's own tags become searchable the moment the map lands
  const session = useSession()
  const me = useMe()
  const [text, setText] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [resultsQuery, setResultsQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const debounce = useRef<number | undefined>(undefined)
  const blurTimeout = useRef<number | undefined>(undefined)
  const abort = useRef<AbortController | null>(null)
  const sequence = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  // Watching yourself is the single most common account alert and the one
  // address nobody wants to type: an empty, focused input offers it outright.
  const self: TargetOption | null = useMemo(() => {
    const account = me.data?.account
    const address = account?.address ?? session?.address
    if (!address) return null
    return addressOption(address, {
      accountId: account?.accountId ?? session?.accountId,
      emoji: account?.emoji,
      emojiUrl: account?.emojiUrl,
      emojiName: account?.emojiName,
      identity: account?.profile?.name || account?.identity?.display || undefined,
      identityVerified: account?.identity?.verified ?? false,
      note: 'My account',
    })
  }, [me.data?.account, session?.address, session?.accountId])

  const userTags = useMemo(() => searchUserTags(text), [text])
  const userTagHits = addressOnly ? [] : userTags
  const query = text.trim()
  // Server hits belong to the text they were fetched for; while a keystroke is
  // still debouncing they are stale and must not be what Enter picks.
  const serverResults = resultsQuery === query ? results : []
  const all: TargetOption[] = query
    ? targetOptions(serverResults, userTagHits)
    : (self ? [self] : [])
  const options = addressOnly ? all.filter(o => o.target.kind === 'address') : all
  // A pasted address the search does not know is still a target.
  const fallback = query && !options.length ? rawAddressOption(query) : null
  const rows = fallback ? [fallback] : options

  async function runSearch(raw: string) {
    const q = raw.trim()
    const seq = ++sequence.current
    abort.current?.abort()
    if (!q) { setResults([]); setResultsQuery(''); return }
    const controller = new AbortController()
    abort.current = controller
    try {
      const r = await api.search(q, controller.signal)
      if (controller.signal.aborted || seq !== sequence.current) return
      setResults(r); setResultsQuery(q); setActive(0)
    } catch {
      if (controller.signal.aborted || seq !== sequence.current) return
      setResults([]); setResultsQuery(q)
    } finally {
      if (abort.current === controller) abort.current = null
    }
  }

  function onText(next: string) {
    setText(next)
    onTextChange?.(next)
    setOpen(true)
    setActive(0)
    sequence.current++
    abort.current?.abort()
    window.clearTimeout(debounce.current)
    if (!next.trim()) { setResults([]); setResultsQuery(''); return }
    debounce.current = window.setTimeout(() => void runSearch(next), DEBOUNCE_MS)
  }

  function choose(option: TargetOption) {
    sequence.current++
    abort.current?.abort()
    onChange(option)
    setText(''); onTextChange?.(''); setResults([]); setResultsQuery(''); setOpen(false)
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, rows.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      const picked = rows[active] ?? rawAddressOption(text)
      if (picked) choose(picked)
    } else if (e.key === 'Escape') { setOpen(false) }
  }

  useEffect(() => () => {
    window.clearTimeout(debounce.current)
    window.clearTimeout(blurTimeout.current)
    sequence.current++
    abort.current?.abort()
  }, [])

  const showList = open && rows.length > 0

  return (
    <div className="acct-picker alert-target-picker">
      <div className={`acct-picker-box${disabled ? ' disabled' : ''}`} onClick={() => inputRef.current?.focus()}>
        {value && (
          <span className="acct-chip">
            <span className="acct-chip-label"><OptionBody option={value} /></span>
            <button type="button" className="acct-chip-x" aria-label={`Clear ${value.label}`} disabled={disabled}
              onClick={() => { onChange(null); inputRef.current?.focus() }}>×</button>
          </span>
        )}
        <input {...noAutofill}
          ref={inputRef}
          id={inputId}
          value={text}
          disabled={disabled}
          placeholder={value ? '' : (addressOnly ? 'Account or address' : 'Account, tag or address')}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && rows[active] ? `${listId}-option-${active}` : undefined}
          spellCheck={false}
          onChange={e => onText(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => { window.clearTimeout(blurTimeout.current); setOpen(true) }}
          onBlur={() => { blurTimeout.current = window.setTimeout(() => setOpen(false), 160) }}
        />
      </div>
      {showList && (
        <div className="acct-picker-results" id={listId} role="listbox" aria-label="Alert targets">
          {rows.map((option, i) => (
            <button
              key={option.key}
              id={`${listId}-option-${i}`}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`acct-picker-row${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={e => { e.preventDefault(); choose(option) }}
            >
              <OptionBody option={option} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
