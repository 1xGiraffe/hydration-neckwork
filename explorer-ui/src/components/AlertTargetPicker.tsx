/* eslint-disable react-refresh/only-export-components -- the picker plus the pure option builders its tests exercise directly */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { api } from '../api/explorer'
import { useMe } from '../hooks/useUser'
import { useSession } from '../session'
import { isAddressLike } from '../notificationKinds'
import { resolveTag, searchUserTags, useTagMapVersion, type UserTagSearchHit } from '../userTags'
import type { AccountRef, NotificationTarget, SearchResult } from '../types'
import { AccountEmoji, ShortAddr, TagIcon, noAutofill, tagMemberSuffix } from './ui'

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
  // The account's system/directory tag, as the server resolved it. `resolveTag`
  // needs it to find a system tag; a user-list tag it finds from the account id.
  tag?: AccountRef['tag']
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
  // NOT `accountId: addr`. The emoji is derived from the canonical AccountId32,
  // so seeding it with whichever form was typed picks a different animal than
  // the one this account wears everywhere else — a sloth where the rest of the
  // app draws a duck. An option that does not KNOW the account id says so, and
  // `OptionBody` resolves it rather than guessing.
  return { key: `address:${addr.toLowerCase()}`, target: { kind: 'address', address: addr }, label: addr, address: addr, ...extra }
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

// Every address on screen at once, resolved in ONE call. A search hit carries an
// emoji and an identity but no TAG, and an address typed, pasted or read back
// off a saved rule carries nothing at all — so nothing here can draw the account
// the way the rest of the app draws it without asking. The endpoint takes twenty
// addresses, which is more than a dropdown ever shows.
function useAddressRefs(options: readonly (TargetOption | null)[]): Map<string, AccountRef> {
  const addresses = useMemo(() => [...new Set(options
    .filter((o): o is TargetOption => !!o && o.target.kind === 'address')
    .map(o => o.address ?? '')
    .filter(Boolean))].sort().slice(0, 20), [options])
  const refQuery = useQuery({
    queryKey: ['alert-target-refs', addresses.join(',')],
    queryFn: ({ signal }) => api.accountRefs(addresses, signal),
    enabled: addresses.length > 0,
    staleTime: 300_000,
    retry: false,
  })
  return useMemo(() => {
    const out = new Map<string, AccountRef>()
    addresses.forEach((a, i) => {
      const ref = refQuery.data?.[i]
      if (ref) out.set(a.toLowerCase(), ref)
    })
    return out
  }, [addresses, refQuery.data])
}

// The resolved ref folded over an option: the account id (which is what the
// emoji is derived from), the tag, and the identity the search may not have had.
function withRef(option: TargetOption, ref: AccountRef | undefined): TargetOption {
  if (!ref) return option
  return {
    ...option,
    accountId: ref.accountId,
    address: ref.address,
    emoji: option.emoji ?? ref.emoji,
    emojiUrl: option.emojiUrl ?? ref.emojiUrl,
    emojiName: option.emojiName ?? ref.emojiName,
    tag: ref.tag,
    identity: option.identity ?? ref.profile?.name ?? ref.identity?.display ?? undefined,
    identityVerified: option.identityVerified ?? ref.identity?.verified ?? false,
  }
}

function OptionBody({ option }: { option: TargetOption }) {
  useTagMapVersion()   // the viewer's own tags decide the label — see AddrPill
  // A tagged account reads as its tag everywhere else in the app: the group's
  // icon and name, and the last three characters of the address to tell one
  // member from another. Same shape as UserTagPill, without its link — inside a
  // picker a click chooses the row rather than navigating away from the dialog.
  const tag = option.target.kind === 'address' && option.accountId
    ? resolveTag({ accountId: option.accountId, tag: option.tag ?? null })
    : null
  if (tag) {
    return (
      <>
        <TagIcon icon={tag.icon} title={tag.name} className="sr-emoji" />
        <span className="tag" style={tag.color ? { color: tag.color } : undefined}>{tag.name}</span>
        {tagMemberSuffix(tag, option.address ?? '')}
        {option.note && <span className="sr-desc">{option.note}</span>}
      </>
    )
  }
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
      {(option.emoji || option.accountId)
        && <AccountEmoji account={{ emoji: option.emoji, emojiName: option.emojiName, emojiUrl: option.emojiUrl, accountId: option.accountId ?? '' }} className="sr-emoji" />}
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
  const rawRows = fallback ? [fallback] : options
  // Chip and rows together, so one call answers for everything on screen.
  const refs = useAddressRefs(useMemo(() => [value, ...rawRows], [value, rawRows]))
  const rows = useMemo(() => rawRows.map(o => withRef(o, refs.get((o.address ?? '').toLowerCase()))), [rawRows, refs])
  const shownValue = value ? withRef(value, refs.get((value.address ?? '').toLowerCase())) : null

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
            <span className="acct-chip-label"><OptionBody option={shownValue ?? value} /></span>
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
