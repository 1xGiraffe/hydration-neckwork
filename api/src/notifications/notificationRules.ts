import { z } from 'zod'

// The notification rule registry: one zod schema and one human summary per
// rule kind. Deliberately dependency-free — the evaluator, the routes, the
// renderer and (mirrored) the explorer UI all describe a rule from the same
// definition, so a kind's parameter set exists in exactly one place.

export const NOTIFICATION_KINDS = [
  'account-activity', 'large-trade', 'large-transfer', 'price', 'health-factor',
  'referendum', 'tc-motion', 'safety', 'extrinsic', 'event',
  'protocol-revenue', 'liquidation',
] as const
export type NotificationKind = typeof NOTIFICATION_KINDS[number]

// Mirrors the activity-type union the explorer feed routes accept
// (`activityTypes` in routes/explorer.ts, pinned by a parity test): a rule
// naming a type the feed cannot filter would silently never match.
export const ACTIVITY_TYPES = ['all', 'transfer', 'trade', 'dca', 'liquidity', 'mm', 'xcm', 'stake', 'vote', 'otc'] as const
// Referenda lifecycle phases the row lane watches.
export const REFERENDUM_PHASES = ['submitted', 'deciding', 'confirmed', 'executed', 'rejected', 'cancelled', 'timed-out', 'killed'] as const
// Technical Committee motion phases the row lane watches. STRICTLY separate from
// the referendum kind: a TC motion is a committee's own procedural business, and
// most people subscribing to "referenda" are asking about public votes — folding
// the two would deliver committee traffic to everybody who wanted the latter.
// `MemberExecuted` folds into 'executed' (the same act, dispatched by one member
// rather than by the collective); `Closed` keeps its own phase because a motion
// can close without ever being approved or disapproved.
export const TC_MOTION_PHASES = ['proposed', 'voted', 'approved', 'disapproved', 'executed', 'closed'] as const
// Everything one security subscription can report, and the only vocabulary a
// safety rule narrows on. It spans two sources on purpose — there is exactly ONE
// security kind, so a subscriber cannot end up half-covered:
//
//   * indexed Hydration actions on the Security ledger (circuit-breaker limits,
//     transaction pauses, withdraw lockdowns, asset freezes, and the Wormhole
//     NTT managers' own governance and queue logs);
//   * states of the Wormhole bridge nothing on Hydration indexes — a backing
//     deficit, an origin-chain rate-limiter queue, an origin manager's pause
//     flag, and a rate-limit fuse running out.
//
// Which source delivers which event is fixed by the delivery matrix in
// evaluator.ts (SAFETY_ROW_LANE_KINDS / SAFETY_SNAPSHOT_KINDS), so no event can
// arrive twice. A rule may narrow to any subset.
export const SAFETY_KINDS = [
  'limit', 'pause', 'unpause', 'lockdown', 'lockdown-lifted', 'freeze', 'unfreeze',
  'deficit', 'queued', 'released', 'fuse',
] as const
export type SafetyKind = typeof SAFETY_KINDS[number]

// Hydration's OpenGov tracks, id → runtime name, transcribed from the runtime's
// own `TRACKS_DATA` (`runtime/hydradx/src/governance/tracks.rs` in
// galacticcouncil/HydraDX-node). The chain puts the numeric id on Submitted and
// DecisionStarted, so the id is what a rule matches on; the name exists because
// nobody subscribes to "track 5".
export const REFERENDUM_TRACKS: readonly { id: number; name: string }[] = [
  { id: 0, name: 'root' },
  { id: 1, name: 'whitelisted_caller' },
  { id: 2, name: 'referendum_canceller' },
  { id: 3, name: 'referendum_killer' },
  { id: 4, name: 'general_admin' },
  { id: 5, name: 'treasurer' },
  { id: 6, name: 'spender' },
  { id: 7, name: 'tipper' },
  { id: 8, name: 'omnipool_admin' },
  { id: 9, name: 'economic_parameters' },
]

// A track is stored as its numeric id, whichever form the request used: names
// are typed by people ("root") and ids come from the chain, and the matcher only
// ever sees an id. Names are matched loosely — case, spaces and dashes are how
// the same track gets written by hand ("Whitelisted Caller").
const trackKey = (value: string): string => value.trim().toLowerCase().replace(/[\s-]+/g, '_')

export function referendumTrackId(value: string): number | null {
  const raw = value.trim()
  if (/^\d{1,5}$/.test(raw)) {
    const id = Number(raw)
    return REFERENDUM_TRACKS.some(t => t.id === id) ? id : null
  }
  const key = trackKey(raw)
  return REFERENDUM_TRACKS.find(t => t.name === key)?.id ?? null
}

export function referendumTrackName(id: number | string): string | null {
  const numeric = Number(id)
  return REFERENDUM_TRACKS.find(t => t.id === numeric)?.name ?? null
}

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value)
}

// Address shape only — SS58 (base58, no 0/O/I/l) or an H160. Canonicalization
// to an accountId is the route's job (normalizeAddress); keeping this module
// free of the crypto stack is what lets the UI mirror it verbatim.
const SS58_RE = /^[1-9A-HJ-NP-Za-km-z]{46,50}$/
const H160_RE = /^0x[0-9a-fA-F]{40}$/
const address = z.string().trim().refine(a => SS58_RE.test(a) || H160_RE.test(a), 'Expected an SS58 or 0x address')
// Pallet/call/event names are matched case-insensitively by the evaluator, so
// only the shape is constrained here.
const palletName = z.string().trim().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Expected a pallet or call name')
const assetId = z.number().int().min(0).max(4_294_967_295)
// A tag identifier: a system tag id is a short hand-picked slug
// ('money-market'), a list id or list-tag id a uuid minted by userListService.
// Both id spaces are checked for real existence at creation time — this only
// keeps a shape that could never name either out of the store.
const tagIdent = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Expected a tag id')

// What an account-activity rule watches. An address watches one account; a tag
// watches whatever the tag holds AT EVALUATION TIME, which is the point of the
// two tag forms — a member added to the tag tomorrow is matched with no change
// to the rule, and the rule still counts as one rule against the per-account cap.
export const accountActivityTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('address'), address }).strict(),
  z.object({ kind: z.literal('tag'), tagId: tagIdent }).strict(),
  z.object({ kind: z.literal('list-tag'), listId: tagIdent, tagId: tagIdent }).strict(),
])
export type AccountActivityTarget = z.infer<typeof accountActivityTarget>

const accountActivityShape = z.object({
  target: accountActivityTarget,
  type: z.enum(ACTIVITY_TYPES).optional(),
  action: z.string().trim().min(1).max(32).optional(),
  minUsd: z.number().min(0).optional(),
}).strict()

// The pre-target spelling — `{ address, … }` — is still accepted and rewritten
// into the address target. Rules persisted before targets existed are re-parsed
// on every load (loadNotifications), so they normalize in place and need no
// migration; a client that still posts the old shape keeps working.
export function normalizeAccountActivityParams(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const o = { ...(value as Record<string, unknown>) }
  if (o.target === undefined && typeof o.address === 'string') o.target = { kind: 'address', address: o.address }
  // `address` is not part of the current shape, so a request carrying BOTH
  // spellings keeps the explicit target rather than being rejected as strict.
  delete o.address
  return o
}

export const accountActivityParams = z.preprocess(normalizeAccountActivityParams, accountActivityShape)

// The two value-floor kinds — large trades and large transfers — take the same
// pair of parameters over two different activity feeds, so they share one
// schema. A floor below $100 would turn "large trade" into "every trade" — the
// row lane shares one window query per kind, so an unbounded rule is a fan-out
// problem for every subscriber, not just its owner.
const valueFloorParams = z.object({
  assetId: assetId.optional(),
  minUsd: z.number().min(100),
}).strict()
export const largeTransferParams = valueFloorParams
// A DCA schedule is a standing order over the same feed, so a large-trade rule
// also answers "did somebody just start pushing this much per hour?". Opt-OUT:
// a rule stored before this shipped carries no flag and must behave as enabled.
// `.default(true)` rather than `.optional()` keeps the parsed params explicit —
// rule creation is idempotent on the canonical params, and an implied default
// would give one rule two canonical keys. large-transfer has no DCA to start, so
// it keeps the bare schema and rejects the flag.
export const largeTradeParams = valueFloorParams.extend({
  dcaStart: z.boolean().default(true),
})

// What the protocol itself earned on one extrinsic, LP share excluded. A floor is
// mandatory for the same reason large-trade has one: a routed swap earns the protocol
// fractions of a cent, so an unbounded rule fires on essentially every extrinsic, and
// the row lane shares one window query per kind — an unbounded rule is a fan-out
// problem for every subscriber, not just its owner.
export const protocolRevenueParams = z.object({
  minUsd: z.number().min(1),
}).strict()

// Liquidations are rare (single digits per thousands of blocks), so unlike the
// large-value kinds this one needs no floor to stay bounded — `minUsd` is offered for
// owners who only care about big ones. An optional target narrows it to one account or
// tag; without one the rule watches the whole chain.
const liquidationShape = z.object({
  minUsd: z.number().min(0).optional(),
  target: accountActivityTarget.optional(),
}).strict()
export const liquidationParams = z.preprocess(normalizeAccountActivityParams, liquidationShape)

export const priceParams = z.object({
  assetId,
  direction: z.enum(['above', 'below']),
  price: z.number().positive(),
}).strict()

const healthFactorShape = z.object({
  // Whose position(s): one address, or a tag whose members are all watched —
  // the same target union as account-activity, resolved live per tick, so an
  // account added to the tag later is watched from the next tick.
  target: accountActivityTarget,
  threshold: z.number().min(0.5).max(10).default(1.1),
}).strict()

// The pre-target spelling — `{ address, threshold }` — is still accepted and
// rewritten into the address target, exactly like account-activity above: rules
// persisted before targets existed re-parse on every load and normalize in
// place, and a client that still posts the old shape keeps working.
export function normalizeHealthFactorParams(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const o = { ...(value as Record<string, unknown>) }
  if (o.target === undefined && typeof o.address === 'string') o.target = { kind: 'address', address: o.address }
  delete o.address
  return o
}

export const healthFactorParams = z.preprocess(normalizeHealthFactorParams, healthFactorShape)

// `track` accepts either form and stores the numeric id, so the matcher only
// ever compares an id to the id the chain reported.
const referendumTrack = z.string().trim().min(1).max(48)
  .refine(v => referendumTrackId(v) != null, 'Expected an OpenGov track id or name')
  .transform(v => String(referendumTrackId(v)))

export const referendumParams = z.object({
  phases: z.array(z.enum(REFERENDUM_PHASES)).min(1).optional(),
  track: referendumTrack.optional(),
}).strict()

export const tcMotionParams = z.object({
  phases: z.array(z.enum(TC_MOTION_PHASES)).min(1).optional(),
}).strict()

// An absent `kinds` means every event: the point of the kind is "tell me when
// something is wrong with the protocol", and narrowing is the exception.
//
// The two floors belong to the two LEVEL events. Both defaults are explicit
// rather than optional (the large-trade `dcaStart` precedent) so one rule has
// one canonical parameter set: a bell posting `params: {}` and a stored rule
// carrying the defaults have to be the same subscription, or pressing the bell
// again would mint a second rule beside the one it already owns.
export const safetyParams = z.object({
  kinds: z.array(z.enum(SAFETY_KINDS)).min(1).optional(),
  /** USD floor a backing deficit must pass before it is worth reporting. */
  deficitUsd: z.number().min(0).default(100),
  /** Origin rate-limit utilization, in percent, at which the fuse event fires. */
  fusePct: z.number().min(0).max(100).default(90),
}).strict()

export const extrinsicParams = z.object({
  section: palletName,
  method: palletName.optional(),
  success: z.boolean().optional(),
  signer: address.optional(),
}).strict()

export const eventParams = z.object({
  section: palletName,
  method: palletName.optional(),
}).strict()

export const ruleParamSchemas = {
  'account-activity': accountActivityParams,
  'large-trade': largeTradeParams,
  'large-transfer': largeTransferParams,
  price: priceParams,
  'health-factor': healthFactorParams,
  referendum: referendumParams,
  'tc-motion': tcMotionParams,
  safety: safetyParams,
  extrinsic: extrinsicParams,
  event: eventParams,
  'protocol-revenue': protocolRevenueParams,
  liquidation: liquidationParams,
} as const satisfies Record<NotificationKind, z.ZodType>

export type RuleParams = {
  'account-activity': z.infer<typeof accountActivityParams>
  'large-trade': z.infer<typeof largeTradeParams>
  'large-transfer': z.infer<typeof largeTransferParams>
  price: z.infer<typeof priceParams>
  'health-factor': z.infer<typeof healthFactorParams>
  referendum: z.infer<typeof referendumParams>
  'tc-motion': z.infer<typeof tcMotionParams>
  safety: z.infer<typeof safetyParams>
  extrinsic: z.infer<typeof extrinsicParams>
  event: z.infer<typeof eventParams>
  'protocol-revenue': z.infer<typeof protocolRevenueParams>
  liquidation: z.infer<typeof liquidationParams>
}

export type ParsedRuleParams<K extends NotificationKind = NotificationKind> = RuleParams[K]

// Parse without throwing: the route turns a failure into a 422 carrying the
// message, and the store re-parses persisted params on load so a row written
// by an older kind definition is dropped rather than fed to the evaluator.
export function parseRuleParams<K extends NotificationKind>(kind: K, params: unknown):
  { ok: true; params: RuleParams[K] } | { ok: false; error: string } {
  const schema: z.ZodType = ruleParamSchemas[kind]
  const result = schema.safeParse(params ?? {}) as { success: true; data: RuleParams[K] } | { success: false; error: z.ZodError }
  if (result.success) return { ok: true, params: result.data }
  const first = result.error.issues[0]
  const path = first?.path.join('.')
  return { ok: false, error: path ? `${path}: ${first?.message}` : (first?.message ?? 'Invalid parameters') }
}

const shortAddr = (a: string) => (a.length > 14 ? `${a.slice(0, a.startsWith('0x') ? 6 : 4)}…${a.slice(-5)}` : a)
const usd = (n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`)

/**
 * Asset id → ticker. Passed in rather than imported: this module stays
 * dependency-free so the UI can mirror it, and the registry lives in
 * explorerAssets. Without one, a summary names the bare id.
 */
export type AssetSymbolLookup = (assetId: number) => string
const assetLabel = (assetId: number, symbolOf?: AssetSymbolLookup): string =>
  symbolOf?.(assetId) ?? `asset ${assetId}`

/**
 * Tag target → its display name (and, for a list tag, the list it lives on).
 * Passed in for the same reason as the symbol lookup: resolving a tag needs the
 * system tag index and the recipient's own lists, and this module stays
 * dependency-free. Without one, a tag rule describes itself generically rather
 * than naming a tag the reader may no longer be able to see.
 */
export type TargetLabelLookup = (target: AccountActivityTarget) => { name: string; listName?: string } | null

// One line describing what a rule watches, used by the rules list, the inbox
// and the human-facing parts of a message. Falls back to the bare kind for
// params that no longer parse, so an unreadable rule still renders.
export function describeRule(
  kind: NotificationKind, params: unknown,
  symbolOf?: AssetSymbolLookup, targetLabelOf?: TargetLabelLookup,
): string {
  const parsed = parseRuleParams(kind, params)
  if (!parsed.ok) return KIND_LABELS[kind]
  switch (kind) {
    case 'account-activity': {
      const p = parsed.params as RuleParams['account-activity']
      const filtered = p.action ? `${p.action} activity` : p.type && p.type !== 'all' ? `${p.type} activity` : null
      const floor = p.minUsd ? ` over ${usd(p.minUsd)}` : ''
      // An address target names no group, and every surface that shows this
      // sentence shows the account beside it as a pill — so the sentence says
      // WHAT is watched and the pill says whose. Repeating a truncated address
      // here is what made a rule read "Activity of 1C1rAh…kR3nv" twice over.
      if (p.target.kind === 'address') return `${filtered ?? 'any activity'}${floor}`
      // A tag target names a group rather than an account, so an unfiltered rule
      // reads "Any activity by …" instead of the address form's bare "activity".
      const what = `${filtered ?? 'Any activity'}${floor}`
      const label = targetLabelOf?.(p.target) ?? null
      if (p.target.kind === 'tag') return `${what} by ${label ? `tag "${label.name}"` : 'a tag'}`
      return `${what} by ${label ? `"${label.name}" (${label.listName ?? 'a list'})` : 'a list tag'}`
    }
    case 'large-trade': {
      const p = parsed.params as RuleParams['large-trade']
      return `trades over ${usd(p.minUsd)}${p.assetId === undefined ? '' : ` on ${assetLabel(p.assetId, symbolOf)}`}`
    }
    case 'large-transfer': {
      const p = parsed.params as RuleParams['large-transfer']
      return `transfers over ${usd(p.minUsd)}${p.assetId === undefined ? '' : ` of ${assetLabel(p.assetId, symbolOf)}`}`
    }
    case 'price': {
      const p = parsed.params as RuleParams['price']
      return `${assetLabel(p.assetId, symbolOf)} price ${p.direction} $${p.price}`
    }
    case 'health-factor': {
      const p = parsed.params as RuleParams['health-factor']
      if (p.target.kind === 'address') return `health factor below ${p.threshold}`
      const label = targetLabelOf?.(p.target) ?? null
      if (p.target.kind === 'tag') return `health factor below ${p.threshold} in tag "${label?.name ?? 'a tag'}"`
      return `health factor below ${p.threshold} in ${label ? `"${label.name}" (${label.listName ?? 'a list'})` : 'a list tag'}`
    }
    case 'referendum': {
      const p = parsed.params as RuleParams['referendum']
      const phases = p.phases?.length ? p.phases.join(', ') : 'any phase'
      const track = p.track ? referendumTrackName(p.track) ?? `track ${p.track}` : null
      return `referenda — ${phases}${track ? ` on ${track}` : ''}`
    }
    case 'tc-motion': {
      const p = parsed.params as RuleParams['tc-motion']
      return `technical committee motions — ${p.phases?.length ? p.phases.join(', ') : 'any phase'}`
    }
    case 'safety': {
      const p = parsed.params as RuleParams['safety']
      // A floor is stated only for an event the rule NAMES. An unnarrowed rule
      // watches everything and reads as such; spelling out both defaults it
      // never chose would bury what it actually watches.
      const floors: string[] = []
      if (p.kinds?.includes('deficit')) floors.push(`deficit ≥ ${usd(p.deficitUsd)}`)
      if (p.kinds?.includes('fuse')) floors.push(`fuse ≥ ${p.fusePct}%`)
      const events = p.kinds?.length ? p.kinds.join(', ') : 'every action'
      return `Security · ${floors.length ? `${floors.join(', ')} · ` : ''}${events}`
    }
    case 'extrinsic': {
      const p = parsed.params as RuleParams['extrinsic']
      const call = `${p.section}.${p.method ?? '*'}`
      const outcome = p.success === undefined ? '' : p.success ? ' (successful)' : ' (failed)'
      return `extrinsic ${call}${outcome}${p.signer ? ` from ${shortAddr(p.signer)}` : ''}`
    }
    case 'event': {
      const p = parsed.params as RuleParams['event']
      return `event ${p.section}.${p.method ?? '*'}`
    }
    case 'protocol-revenue': {
      const p = parsed.params as RuleParams['protocol-revenue']
      return `extrinsics earning the protocol over ${usd(p.minUsd)}`
    }
    case 'liquidation': {
      const p = parsed.params as RuleParams['liquidation']
      const floor = p.minUsd ? ` over ${usd(p.minUsd)}` : ''
      if (!p.target) return `liquidations${floor}`
      if (p.target.kind === 'address') return `liquidations${floor}`
      const label = targetLabelOf?.(p.target) ?? null
      if (p.target.kind === 'tag') return `liquidations${floor} of ${label ? `tag "${label.name}"` : 'a tag'}`
      return `liquidations${floor} of ${label ? `"${label.name}" (${label.listName ?? 'a list'})` : 'a list tag'}`
    }
  }
}

// Display names for the kind itself (rule pickers, inbox grouping).
export const KIND_LABELS: Record<NotificationKind, string> = {
  'account-activity': 'Account activity',
  'large-trade': 'Large trade',
  'large-transfer': 'Large transfer',
  price: 'Price alert',
  'health-factor': 'Health factor',
  referendum: 'Referendum',
  'tc-motion': 'TC motion',
  safety: 'Security',
  extrinsic: 'Extrinsic matcher',
  event: 'Event matcher',
  'protocol-revenue': 'Protocol revenue',
  liquidation: 'Liquidation',
}
