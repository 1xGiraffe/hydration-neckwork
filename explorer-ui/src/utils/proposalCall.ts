// Shape and size facts about a decoded proposal call.
//
// The renderer in components/ProposalCall.tsx reads these predicates to decide what a
// value IS, and this module counts the lines that rendering would produce. Both live here
// so the size gate can never drift from what the tree actually draws, and so the
// thresholds are testable without a DOM.

export interface NestedCall {
  pallet: string
  call: string
  args: Record<string, unknown>
}

// A subsquid enum is { __kind, value }; a nested CALL is one whose value carries its own
// __kind, which is how a batch's entries and dispatch_as's inner call arrive.
export function asNestedCall(value: unknown): NestedCall | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const outer = value as { __kind?: unknown; value?: unknown }
  if (typeof outer.__kind !== 'string' || !outer.value || typeof outer.value !== 'object') return null
  const inner = outer.value as { __kind?: unknown } & Record<string, unknown>
  if (typeof inner.__kind !== 'string') return null
  const { __kind: call, ...args } = inner
  return { pallet: outer.__kind, call: call as string, args }
}

// A plain enum variant with no payload, e.g. {"__kind":"Signed"}.
export function asPlainVariant(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value as Record<string, unknown>)
  const kind = (value as { __kind?: unknown }).__kind
  return keys.length === 1 && typeof kind === 'string' ? kind : null
}

// An enum with a payload, rendered inline as "Kind → payload" rather than two rows.
export function asInlineVariant(value: unknown): { payload: unknown } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const entries = Object.keys(record)
  if (typeof record.__kind !== 'string' || entries.length !== 2 || !('value' in record)) return null
  return { payload: record.value }
}

// Lines the call tree would draw for a value, following ArgTree branch for branch: a
// nested call costs its heading plus its arguments, a list costs its items, an argument
// map costs a row per entry, and everything else is one line. Measured against real
// referenda a line runs 23–31px, so this is the page height the reader would face.
export function proposalCallRows(value: unknown): number {
  const nested = asNestedCall(value)
  if (nested) return 1 + argRows(nested.args)

  if (asPlainVariant(value)) return 1

  if (Array.isArray(value)) {
    if (!value.length) return 1
    return value.reduce<number>((total, item) => total + proposalCallRows(item), 0)
  }

  if (value && typeof value === 'object') {
    const inline = asInlineVariant(value)
    if (inline) return proposalCallRows(inline.payload)
    return argRows(value as Record<string, unknown>)
  }

  return 1
}

// An argument map draws one grid row per entry, each as tall as its own value.
function argRows(args: Record<string, unknown>): number {
  const entries = Object.entries(args)
  if (!entries.length) return 0
  return entries.reduce((total, [, item]) => total + proposalCallRows(item), 0)
}

// What a folded call says about itself. A wrapper whose whole payload is another call
// names that call — otherwise a batch of dispatch_as entries would be a column of
// identical "1 arg" rows. Everything else counts its arguments.
export function callFoldHint(args: Record<string, unknown>): string | null {
  const entries = Object.entries(args)
  if (!entries.length) return null
  if (entries.length === 1) {
    const inner = asNestedCall(entries[0][1])
    if (inner) return `→ ${inner.pallet}.${inner.call}`
  }
  return `${entries.length} ${entries.length === 1 ? 'arg' : 'args'}`
}

// Over this many lines a proposal folds every call below its own to a heading. It is the
// 75th percentile of the referenda indexed so far, landing the cutoff under one viewport:
// the median proposal (15 lines) still arrives fully open.
export const FOLD_ROW_THRESHOLD = 40

// A batch can hold thousands of entries — the chain's first referendum holds 2,556 — so a
// long list draws a bounded prefix until the reader asks for the rest. Applied whether the
// calls are folded or expanded, which is what keeps "expand all" bounded too.
export const CALL_LIST_CAP = 50
