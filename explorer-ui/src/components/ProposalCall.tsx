import { CopyTextButton } from './ui'

// The referendum's actual proposal, decoded from its preimage.
//
// The chain stores a proposal as SCALE bytes behind a hash, so this is the only place a
// reader can see what a referendum would DO. Rendered as a tree rather than raw JSON:
// nested calls (a batch of batches is normal here) get their own pallet.call heading, and
// the leaves are formatted for the shapes governance calls actually contain — 32-byte
// account ids, long EVM calldata, and 128-bit amounts that must never pass through a
// double.

// A subsquid enum is { __kind, value }; a nested CALL is one whose value carries its own
// __kind, which is how a batch's entries and dispatch_as's inner call arrive.
function asNestedCall(value: unknown): { pallet: string; call: string; args: Record<string, unknown> } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const outer = value as { __kind?: unknown; value?: unknown }
  if (typeof outer.__kind !== 'string' || !outer.value || typeof outer.value !== 'object') return null
  const inner = outer.value as { __kind?: unknown } & Record<string, unknown>
  if (typeof inner.__kind !== 'string') return null
  const { __kind: call, ...args } = inner
  return { pallet: outer.__kind, call: call as string, args }
}

// A plain enum variant with no payload, e.g. {"__kind":"Signed"}.
function asPlainVariant(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value as Record<string, unknown>)
  const kind = (value as { __kind?: unknown }).__kind
  return keys.length === 1 && typeof kind === 'string' ? kind : null
}

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

function ArgTree({ value, depth }: { value: unknown; depth: number }) {
  const nested = asNestedCall(value)
  if (nested) return <CallNode pallet={nested.pallet} call={nested.call} args={nested.args} depth={depth + 1} />

  const variant = asPlainVariant(value)
  if (variant) return <span className="pc-variant">{variant}</span>

  if (Array.isArray(value)) {
    if (!value.length) return <span className="muted">empty</span>
    return (
      <ol className="pc-list">
        {value.map((item, i) => <li key={i}><ArgTree value={item} depth={depth} /></li>)}
      </ol>
    )
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    // An enum with a payload reads as "Kind → payload" rather than two unrelated rows.
    const kind = (value as { __kind?: unknown }).__kind
    if (typeof kind === 'string' && entries.length === 2 && 'value' in (value as Record<string, unknown>)) {
      return <><span className="pc-variant">{kind}</span> <ArgTree value={(value as { value: unknown }).value} depth={depth} /></>
    }
    return (
      <div className="pc-args">
        {entries.map(([key, item]) => (
          <div className="pc-arg" key={key}>
            <span className="pc-key">{key}</span>
            <div className="pc-val"><ArgTree value={item} depth={depth} /></div>
          </div>
        ))}
      </div>
    )
  }

  return <Leaf value={value} />
}

function CallNode({ pallet, call, args, depth }: { pallet: string; call: string; args: Record<string, unknown>; depth: number }) {
  const entries = Object.entries(args)
  return (
    <div className={`pc-call${depth > 0 ? ' pc-nested' : ''}`}>
      <div className="pc-head">
        <span className="pc-pallet">{pallet}</span>
        <span className="pc-dot">.</span>
        <span className="pc-name">{call}</span>
      </div>
      {entries.length > 0 && <ArgTree value={args} depth={depth} />}
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
  const args = (call.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown>
  return (
    <div className="panel pc-panel">
      <CallNode pallet={call.pallet} call={call.callName} args={args} depth={0} />
      <div className="pc-foot">
        <span className="muted">{call.byteLength.toLocaleString('en-US')} bytes</span>
        <CopyRow call={call} hash={hash} />
      </div>
    </div>
  )
}
