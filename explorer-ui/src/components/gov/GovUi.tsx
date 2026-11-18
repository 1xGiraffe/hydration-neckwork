/* eslint-disable react-refresh/only-export-components -- shared governance atoms + formatters module */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AddrPill, Amt, CopyTextButton, F } from '../ui'
import { Link, paths } from '../../router'
import type { AccountGovernanceLocks, BlockMoment, ForumAuthor, ForumPosition } from '../../governanceTypes'

// Small shared pieces of the governance and forum pages: names, dates, badges and
// the popover a control keeps its settings in. What a term means (conviction,
// approval vs support, locks) is written once in terms.tsx and shown through
// Disclosure.tsx (the page's "Terms on this page" fold, or an ⓘ).

/** `whitelisted_caller` → "Whitelisted caller". */
export function trackLabel(name: string | null | undefined): string {
  if (!name) return 'Unknown track'
  const words = name.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// One status vocabulary → one visual language, shared by referenda, motions and
// tips: green settled-yes, a second green for confirming, red settled-no, blue for
// anything still open, grey for the rest. Nothing in flight is red unless the
// caller says it cannot pass.
export function statusTone(status: string): 'good' | 'almost' | 'bad' | 'neutral' | 'quiet' {
  if (/^(approved|executed|passed|closed|paid|processed)$/.test(status)) return 'good'
  if (status === 'confirming') return 'almost'
  if (/^(rejected|not passed|disapproved|failed|killed|vetoed|timed out|cancelled|retracted|voided)$/.test(status)) return 'bad'
  if (/^(deciding|open|closing|submitted|started|preparing)$/.test(status)) return 'neutral'
  return 'quiet'
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * A status in a list. Settled-yes (approved, enacted, paid …) is plain text: a pill is
 * kept for what needs attention, a live state or one that failed (red) or was stopped
 * (amber, cancelled or timed out).
 */
export function StatusBadge({ status, failing, failedCall }: { status: string; failing?: boolean; failedCall?: boolean }) {
  if (failing) return <span className="badge gov-status bad" title={`Still ${status}, but as voted today it cannot pass`}>not passing</span>
  if (failedCall) return <span className="badge gov-status bad" title="Enacted, but the dispatched call failed">{status}</span>
  const tone = statusTone(status)
  // One word for a passed referendum on every page: "executed" is an approved one
  // whose call has run, said in the hover rather than as a second status.
  if (status === 'executed') return <span className="gov-status-text" title="Approved, and its call was enacted">Approved</span>
  if (tone === 'good' || tone === 'quiet') return <span className="gov-status-text">{cap(status)}</span>
  const stopped = tone === 'bad' && /^(cancelled|timed out|retracted|voided)$/.test(status)
  return <span className={`badge gov-status ${tone}${stopped ? ' stopped' : ''}`}>{status}</span>
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A moment's epoch ms: ISO strings, epoch numbers, and ClickHouse's "YYYY-MM-DD hh:mm:ss" (UTC). */
export function momentMs(ts: string | number): number {
  if (typeof ts === 'number') return ts
  const s = /^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?(\.\d+)?$/.test(ts) ? `${ts.replace(' ', 'T')}Z` : ts
  return Date.parse(s)
}

/** "Tue 12 Nov, 16:21 UTC" (with the year when it is not this year's). */
export function humanDate(ts: string | number, withTime = true): string {
  const d = new Date(momentMs(ts))
  if (!Number.isFinite(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  const year = d.getUTCFullYear() !== new Date().getUTCFullYear() ? ` ${d.getUTCFullYear()}` : ''
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year}${withTime ? `, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC` : ''}`
}

/** "in 3d 4h" / "2d 5h ago" — a relative reading of a moment. */
export function relativeTime(ts: string | number, now: number): string {
  const t = momentMs(ts)
  if (!Number.isFinite(t)) return '—'
  const diff = Math.round((t - now) / 1000)
  const s = Math.abs(diff)
  // Past a month a count of days reads worse than the date itself.
  if (s > 30 * 86_400) return humanDate(t, false)
  const part = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`
  return diff >= 0 ? `in ${part}` : `${part} ago`
}

/**
 * A chain moment as a reader wants it: a human date (or a relative one), the exact
 * block on hover, and an "≈" with a dotted rule when it is a projection. A past
 * block links to its page.
 */
export function MomentText({ at, now, relative = false, withTime = true, timeOnly = false }: { at: BlockMoment; now: number; relative?: boolean; withTime?: boolean; timeOnly?: boolean }) {
  const d = new Date(momentMs(at.ts))
  const label = timeOnly ? `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`
    : relative ? relativeTime(at.ts, now) : humanDate(at.ts, withTime)
  const title = `Block #${F.int(at.block)} · ${humanDate(at.ts)}${at.exact ? '' : ' — projected from the current block at the chain’s nominal block time; the real moment can drift'}`
  // A projected relative moment reads "in ~4d 17h"; a projected date keeps its "≈".
  if (!at.exact) return <span className="gov-moment projected" title={title}>{relative && !timeOnly ? label.replace(/^in /, 'in ~') : `≈ ${label}`}</span>
  return <Link to={paths.block(at.block)} className="gov-moment" title={title}>{label}</Link>
}

/** A snapshot-backed read still loading after an api restart: said plainly, never shown as empty. */
export function NotReady({ what }: { what: string }) {
  return (
    <div className="gov-not-ready" role="status" aria-live="polite">
      <span className="gov-not-ready-dot" aria-hidden="true" />
      <span>The {what} is still loading on the server. This page fills in by itself once it is ready — usually within a minute.</span>
    </div>
  )
}

/** A forum author: an account pill, or an imported legacy (email-only) username, unlinked. */
export function ForumAuthorName({ author }: { author: ForumAuthor | null }) {
  if (!author) return <span className="muted">deleted</span>
  if (author.account) return <AddrPill account={author.account} noCopy />
  return <span className="gov-legacy-author" title="An email-only account from the earlier forum: it has no on-chain address, so it links nowhere">{author.legacyName || 'unknown'} <span className="muted">· legacy user</span></span>
}

/** 'Locked4x' → '4×', 'None' → '0.1×'. */
export function convictionShort(name: string | null | undefined, index?: number | null): string {
  if (index === 0 || name === 'None') return '0.1×'
  const n = index ?? (name ? Number(/Locked(\d)x/.exec(name)?.[1]) : NaN)
  return Number.isFinite(n) && n != null ? `${n}×` : '—'
}

/** "Aye 4× · 53.4 HDX" — where a commenter stands on the referendum their thread is about. */
export function PositionBadge({ position, decimals = 12 }: { position: ForumPosition; decimals?: number }) {
  const side = position.side === 'Aye' ? 'aye' : position.side === 'Nay' ? 'nay' : 'split'
  const word = position.side === 'SplitAbstain' ? 'Abstain' : position.side
  return (
    <span className={`gov-position ${side}`} title={`Their vote on this referendum: ${word}${position.conviction ? ` with ${convictionShort(position.conviction)} conviction` : ''}, ${F.exact(position.balance, decimals)} HDX`}>
      <span className="gov-position-side">{word}</span>{position.side === 'Aye' || position.side === 'Nay' ? ` ${convictionShort(position.conviction)}` : ''} · <Amt raw={position.balance} dec={decimals} /> HDX
    </span>
  )
}

/** A Balances lock id in words ('stk_stks' → "HDX staking"). */
export function lockName(id: string): string {
  const names: Record<string, string> = {
    stk_stks: 'HDX staking', ghdxlock: 'GIGAHDX', ormlvest: 'vesting', democrac: 'the old Democracy votes',
    phrelect: 'the old council elections', insuffED: 'an insufficient-asset deposit', pyconvot: 'votes',
  }
  return names[id] ?? `the “${id}” lock`
}

/** What the unlock course makes spendable now: net of the other locks when they are known. */
export const spendableNowOf = (l: AccountGovernanceLocks): bigint => BigInt(l.spendableNow ?? l.unlockableNow)

/**
 * A perbill share as a percentage, at the precision the comparison needs: two
 * decimals when it is within one point of the bar it is read against (16.21% vs
 * 16.66%), one otherwise — the same figure reads the same on every surface.
 */
export function perbillPct(perbill: number | null | undefined, against?: number | null): string {
  if (perbill == null) return '—'
  const pct = perbill / 1e7
  if (pct >= 99.995) return '100%'
  const close = against != null && Math.abs(perbill - against) < 1e7
  return `${pct.toFixed(close || pct < 1 ? 2 : 1).replace(/\.0+$/, '')}%`
}

/** A forum label as readers see it: imported abbreviations spelled out ("Tech.Comm." → "Technical committee"). */
export function forumLabelText(label: string): string {
  const names: Record<string, string> = { 'Tech.Comm.': 'Technical committee' }
  return names[label] ?? label
}

/** One account label everywhere on the governance pages: "Name · 133n87…rEcQz", or the short address alone. */
export function accountLabel(address: string, name?: string | null): string {
  const short = F.shortAddr(address)
  return name ? `${name} · ${short}` : short
}

/** "7.6 days" — a lock length at the chain's measured pace, to a tenth of a day. */
export function dayText(days: number): string {
  const r = Math.round(days * 10) / 10
  return `${r} ${r === 1 ? 'day' : 'days'}`
}


/**
 * A small panel under a button, for a control's own settings (a feed URL, the
 * accounts list): opens on click, closes on Escape (focus back on the button), a
 * click elsewhere or focus leaving it. `icon` makes the button an icon button whose
 * name is `label`.
 */
export function GovPopover({ label, text, icon, title, children, className, primary, buttonClass }: { label: string; text?: ReactNode; icon?: ReactNode; title?: string; children: ReactNode; className?: string; primary?: boolean; buttonClass?: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const wrap = useRef<HTMLSpanElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: Event) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus() } }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  return (
    <span ref={wrap} className={`gov-pop-wrap${className ? ` ${className}` : ''}`} onBlur={e => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false) }}>
      <button ref={btn} type="button" className={buttonClass ?? (icon ? 'gov-icon-btn' : `gov-btn${primary ? ' gov-btn-primary' : ''}`)} aria-label={icon ? label : undefined} title={title ?? (icon ? label : undefined)}
        aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(o => !o)}>
        {icon ?? text ?? label}
      </button>
      {open && <div id={id} role="group" aria-label={label} className="gov-pop">{children}</div>}
    </span>
  )
}

const FeedIcon = () => <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="12.5" r="1.4" fill="currentColor" /><path d="M2.5 7.2a6.3 6.3 0 0 1 6.3 6.3M2.5 2.8a10.7 10.7 0 0 1 10.7 10.7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>

/** A URL to subscribe to, with its copy button, in a popover: a feed reader (icon) or a calendar app (a "Subscribe" button). */
export function SubscribeUrl({ url, note, label, kind }: { url: string; note: ReactNode; label: string; kind: 'feed' | 'calendar' }) {
  return (
    <GovPopover label={label} icon={kind === 'feed' ? <FeedIcon /> : undefined} text={kind === 'calendar' ? 'Subscribe' : undefined} className="gov-sub-pop">
      <p className="gov-pop-note">{note}</p>
      <div className="gov-pop-url"><code tabIndex={0}>{url}</code><CopyTextButton label="URL" text={url} /></div>
    </GovPopover>
  )
}
