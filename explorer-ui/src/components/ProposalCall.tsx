import { useMemo, useState, type ReactNode } from 'react'
import { CopyTextButton } from './ui'
import {
  asInlineVariant, asNestedCall, asPlainVariant, callFoldHint, proposalCallRows,
  CALL_LIST_CAP, FOLD_ROW_THRESHOLD,
} from '../utils/proposalCall'

// The referendum's actual proposal, decoded from its preimage.
//
// The chain stores a proposal as SCALE bytes behind a hash, so this is the only place a
// reader can see what a referendum would DO. Rendered as a tree rather than raw JSON:
// nested calls (a batch of batches is normal here) get their own pallet.call heading, and
// the leaves are formatted for the shapes governance calls actually contain — 32-byte
// account ids, long EVM calldata, and 128-bit amounts that must never pass through a
// double.
//
// Governance batches run to thousands of calls, so a proposal past FOLD_ROW_THRESHOLD
// lines arrives as an outline: every call below the proposal's own is a heading the reader
// opens. The shape of the batch stays legible without the page becoming a scroll of
// arguments nobody asked for.

const HEX = /^0x[0-9a-f]*$/i

// Digit groups make a 128-bit amount readable; the exact value stays in the title, since
// grouping is presentation and these are financial quantities.
function formatLeaf(value: unknown): { text: string; title?: string; cls: string } {
  if (value == null) return { text: '—', cls: 'muted' }
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', cls: 'mono' }
  if (typeof value === 'number') return { text: value.toLocaleString('en-US'), cls: 'mono' }
  const text = String(value)
  if (HEX.test(text) && text.length > 22) {
    return { text: `${text.slice(0, 10)}…${text.slice(-8)}`, title: text, cls: 'mono' }
  }
  if (/^\d{5,}$/.test(text)) {
    return { text: text.replace(/\B(?=(\d{3})+(?!\d))/g, ','), title: text, cls: 'mono' }
  }
  return { text, cls: 'mono' }
}

function Leaf({ value }: { value: unknown }) {
  const { text, title, cls } = formatLeaf(value)
  return <span className={cls} title={title}>{text}</span>
}

// A bounded prefix of a long list, with the remainder one click away. The reader's choice
// lives here rather than in the panel so opening one huge batch does not unfold the rest.
function ArgList({ items, depth, folded }: { items: unknown[]; depth: number; folded: boolean }) {
  const [showAll, setShowAll] = useState(false)
  const capped = !showAll && items.length > CALL_LIST_CAP
  const shown = capped ? items.slice(0, CALL_LIST_CAP) : items
  const remaining = items.length - CALL_LIST_CAP
  // "calls" only when they are calls; a capped list of asset ids is not.
  const noun = asNestedCall(items[0]) ? 'calls' : 'entries'
  return (
    <>
      <ol className="pc-list">
        {shown.map((item, i) => <li key={i}><ArgTree value={item} depth={depth} folded={folded} /></li>)}
      </ol>
      {capped && (
        <button type="button" className="pc-more" onClick={() => setShowAll(true)}>
          Show remaining {remaining.toLocaleString('en-US')} {noun}
        </button>
      )}
    </>
  )
}

function ArgTree({ value, depth, folded }: { value: unknown; depth: number; folded: boolean }) {
  const nested = asNestedCall(value)
  if (nested) return <CallNode pallet={nested.pallet} call={nested.call} args={nested.args} depth={depth + 1} folded={folded} />

  const variant = asPlainVariant(value)
  if (variant) return <span className="pc-variant">{variant}</span>

  if (Array.isArray(value)) {
    if (!value.length) return <span className="muted">empty</span>
    return <ArgList items={value} depth={depth} folded={folded} />
  }

  if (value && typeof value === 'object') {
    // An enum with a payload reads as "Kind → payload" rather than two unrelated rows.
    const inline = asInlineVariant(value)
    if (inline) {
      const kind = (value as { __kind: string }).__kind
      return <><span className="pc-variant">{kind}</span> <ArgTree value={inline.payload} depth={depth} folded={folded} /></>
    }
    return (
      <div className="pc-args">
        {Object.entries(value as Record<string, unknown>).map(([key, item]) => (
          <div className="pc-arg" key={key}>
            <span className="pc-key">{key}</span>
            <div className="pc-val"><ArgTree value={item} depth={depth} folded={folded} /></div>
          </div>
        ))}
      </div>
    )
  }

  return <Leaf value={value} />
}

function CallNode({ pallet, call, args, depth, folded, action }: {
  pallet: string
  call: string
  args: Record<string, unknown>
  depth: number
  folded: boolean
  action?: ReactNode
}) {
  const entries = Object.entries(args)
  const signature = (
    <>
      <span className="pc-pallet">{pallet}</span>
      <span className="pc-dot">.</span>
      <span className="pc-name">{call}</span>
    </>
  )
  const body = entries.length > 0 ? <ArgTree value={args} depth={depth} folded={folded} /> : null

  // The proposal's own call always shows; only what it wraps folds. A native <details>
  // carries the keyboard and focus behaviour of the close-accounts disclosure for free.
  if (folded && depth > 0) {
    const hint = callFoldHint(args)
    return (
      <details className="pc-call pc-nested pc-fold">
        <summary className="pc-head">
          {signature}
          {hint && <span className="pc-hint">{hint}</span>}
          <span className="pc-chevron" aria-hidden="true">⌄</span>
        </summary>
        {body}
      </details>
    )
  }
  return (
    <div className={`pc-call${depth > 0 ? ' pc-nested' : ''}`}>
      <div className="pc-head">{signature}{action}</div>
      {body}
    </div>
  )
}

export interface ProposalCallData {
  pallet: string
  callName: string
  args: unknown
  // The exact SCALE bytes the chain stored, so the encoded call is copyable and not just
  // its decoded form.
  encoded: string | null
  byteLength: number
  decodeError: string | null
}

// The decoded call as JSON, in the shape a reader would expect to paste elsewhere: the
// pallet and call named, then the arguments.
function callJson(call: ProposalCallData): string {
  return JSON.stringify({ pallet: call.pallet, call: call.callName, args: call.args }, null, 2)
}

// Copy buttons for the three forms of a proposal worth taking away: what identifies it
// (the hash), what the chain stored (the encoded call), and what it means (the JSON).
function CopyRow({ call, hash }: { call: ProposalCallData; hash: string | null }) {
  return (
    <div className="pc-copy">
      {hash && <CopyTextButton label="hash" text={hash} />}
      {call.encoded && <CopyTextButton label="encoded call" text={call.encoded} />}
      {!call.decodeError && <CopyTextButton label="JSON" text={callJson(call)} />}
    </div>
  )
}

export function ProposalCall({ call, hash }: { call: ProposalCallData; hash: string | null }) {
  const [expandAll, setExpandAll] = useState(false)
  const args = useMemo(
    () => (call.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown>,
    [call.args],
  )
  const foldable = useMemo(() => proposalCallRows(args) > FOLD_ROW_THRESHOLD, [args])

  // A hash that could not be decoded says so, rather than looking like a referendum with
  // no proposal at all.
  if (call.decodeError) {
    return (
      <div className="panel pc-panel">
        <div className="pc-unavailable">
          Preimage could not be decoded ({call.byteLength.toLocaleString('en-US')} bytes)
          <div className="pc-error mono">{call.decodeError}</div>
          <CopyRow call={call} hash={hash} />
        </div>
      </div>
    )
  }
  // Expanding swaps the disclosures for plain blocks, so the tree returns to exactly its
  // unfolded form and find-in-page reaches every argument.
  return (
    <div className="panel pc-panel">
      <CallNode
        pallet={call.pallet}
        call={call.callName}
        args={args}
        depth={0}
        folded={foldable && !expandAll}
        action={foldable && (
          <button type="button" className="pc-toggle" onClick={() => setExpandAll(value => !value)}>
            {expandAll ? 'Collapse all' : 'Expand all'}
          </button>
        )}
      />
      <div className="pc-foot">
        <span className="muted">{call.byteLength.toLocaleString('en-US')} bytes</span>
        <CopyRow call={call} hash={hash} />
      </div>
    </div>
  )
}
