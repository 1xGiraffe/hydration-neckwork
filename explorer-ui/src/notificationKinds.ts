import type { NotificationKind, NotificationRule, NotificationTarget } from './types'

// The UI's copy of the notification rule registry
// (api/src/notifications/notificationRules.ts). The server owns validation —
// every create/update is re-parsed there and a bad parameter comes back as a
// 422 carrying the field name — so this side mirrors only what a FORM needs:
// which kinds exist, what each is called, which enumerations a picker offers,
// and the two floors a user would otherwise only discover by being rejected.
// Keep the lists below in step with that module; a value here the server does
// not know is a rule that can never match.

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'account-activity', 'large-trade', 'large-transfer', 'price', 'health-factor',
  'referendum', 'tc-motion', 'safety', 'extrinsic', 'event',
]

// Display names for the kind itself (rule picker, rules list, inbox grouping).
export const KIND_LABELS: Record<NotificationKind, string> = {
  'account-activity': 'Account activity',
  'large-trade': 'Large trade',
  'large-transfer': 'Large transfer',
  price: 'Price alert',
  'health-factor': 'Health factor',
  referendum: 'Referendum',
  'tc-motion': 'TC motion',
  safety: 'Safety action',
  extrinsic: 'Extrinsic matcher',
  event: 'Event matcher',
}

// One line of "what this kind watches", shown under the kind in the picker.
export const KIND_HINTS: Record<NotificationKind, string> = {
  'account-activity': 'Everything one address does — optionally one category, or only above a value.',
  'large-trade': 'Any trade over a threshold, chain-wide or on one token.',
  'large-transfer': 'Any transfer over a threshold, chain-wide or of one token.',
  price: 'A token crossing a price, in either direction.',
  'health-factor': 'A money-market position falling toward liquidation.',
  referendum: 'Governance referenda entering the phases you care about.',
  'tc-motion': 'Technical Committee motions — proposals, member votes and outcomes.',
  safety: 'Circuit breakers, pauses, freezes and lockdowns.',
  extrinsic: 'A specific call, by pallet and method.',
  event: 'A specific runtime event, by pallet and method.',
}

// The activity-type union the explorer feed routes accept. A rule naming a type
// the feed cannot filter would silently never match.
export const ACTIVITY_TYPES = ['all', 'transfer', 'trade', 'dca', 'liquidity', 'mm', 'xcm', 'stake', 'vote', 'otc'] as const
export type NotificationActivityType = typeof ACTIVITY_TYPES[number]

// Referenda lifecycle phases the evaluator watches.
export const REFERENDUM_PHASES = ['submitted', 'deciding', 'confirmed', 'rejected', 'cancelled', 'timed-out', 'killed'] as const
export type ReferendumPhase = typeof REFERENDUM_PHASES[number]

// Technical Committee motion phases the evaluator watches. Its own kind, never a
// phase of `referendum`: committee business is not what somebody subscribing to
// public referenda asked for, so nobody receives it without choosing it here.
export const TC_MOTION_PHASES = ['proposed', 'voted', 'approved', 'disapproved', 'executed', 'closed'] as const
export type TcMotionPhase = typeof TC_MOTION_PHASES[number]

// The safety-timeline action kinds the security service emits.
export const SAFETY_KINDS = ['limit', 'pause', 'unpause', 'lockdown', 'lockdown-lifted', 'freeze', 'unfreeze'] as const
export type SafetyKind = typeof SAFETY_KINDS[number]

// Hydration's OpenGov tracks, id → runtime name. The chain reports the numeric
// id, so a rule stores the id and a picker offers the name; the server accepts
// either and normalizes.
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

// The floor the two value-floor kinds (large trade, large transfer) share. Below
// $100 a "large trade" is every trade: the row lane shares one window query per
// kind, so an unbounded rule is a fan-out problem for every subscriber, not just
// its owner.
export const LARGE_VALUE_MIN_USD = 100
// The value floor the asset page's trade and transfer alerts open on. A round
// number a reader recognises as "large" for either feed, and one of the
// USD_FLOOR_PRESETS chips, so the prefill reads as pressed rather than as a
// value the chips disagree with.
export const ASSET_ALERT_MIN_USD = 10_000
// zod's own default, restated so the form opens on the value it would get.
export const HEALTH_FACTOR_DEFAULT = 1.1
export const HEALTH_FACTOR_MIN = 0.5
export const HEALTH_FACTOR_MAX = 10
// One-click thresholds, taken from the app's OWN health-factor bands
// (healthFactorDisplay in components/ui.tsx: < 1.1 reads hf-bad, < 1.6 hf-warn):
// 1.1 is the edge the explorer already paints red, 1.6 the edge of the warning
// band, and 1.3 the middle of it. Anything else is still typeable.
export const HEALTH_FACTOR_PRESETS: readonly number[] = [1.1, 1.3, 1.6]

// One-click USD floors for every "only above" field. The steps are the ones
// people actually name out loud, and every one of them clears the $100 registry
// floor, so a chip can never produce a rule the server refuses.
export const USD_FLOOR_PRESETS: readonly { value: number; label: string }[] = [
  { value: 1_000, label: '$1k' },
  { value: 10_000, label: '$10k' },
  { value: 100_000, label: '$100k' },
  { value: 1_000_000, label: '$1M' },
]

// Quick-adjust steps for a price threshold, as percentages of what the token
// costs NOW. A price alert is almost always "tell me if it moves this far", and
// that is a percentage of the current price rather than an absolute number
// anybody wants to compute. Every step is measured from the live price, so
// tapping two of them in a row does not compound.
export const PRICE_STEP_PCTS: readonly number[] = [-10, -5, 5, 10]

// How a step reads on its chip. A real minus sign, so −5% and +5% are the same
// width and the pair reads as one scale.
export function priceStepLabel(pct: number): string {
  return `${pct < 0 ? '−' : '+'}${Math.abs(pct)}%`
}

// The threshold a step means against a given price. Exact, not rounded: what a
// chip fills in is what the rule watches, the same way "Use current" posts the
// price the page holds rather than the one it displays.
export function priceAtStep(current: number, pct: number): number {
  return current * (1 + pct / 100)
}

// Which way a price alert should watch, given the threshold somebody typed and
// what the token costs now: a threshold ABOVE the current price can only be
// reached by rising, one below it only by falling. A suggestion — the form leaves
// the select in the reader's hands the moment they touch it.
export function suggestPriceDirection(threshold: number, current: number): 'above' | 'below' {
  return threshold >= current ? 'above' : 'below'
}

// Address SHAPE only — SS58 (base58, no 0/O/I/l) or an H160. Canonicalization
// is the server's job; this is what lets a form say "that isn't an address"
// before spending a round trip.
const SS58_RE = /^[1-9A-HJ-NP-Za-km-z]{46,50}$/
const H160_RE = /^0x[0-9a-fA-F]{40}$/
export function isAddressLike(value: string): boolean {
  const a = value.trim()
  return SS58_RE.test(a) || H160_RE.test(a)
}

// Pallet/call/event names are matched case-insensitively by the evaluator, so
// only the shape is constrained.
const PALLET_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
export function isPalletNameLike(value: string): boolean {
  return PALLET_RE.test(value.trim())
}

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value)
}

// Cooldown choices offered by the new-alert form. 0 = every match fires.
export const COOLDOWN_CHOICES: { value: number; label: string }[] = [
  { value: 0, label: 'Every match' },
  { value: 300, label: 'At most every 5 min' },
  { value: 3600, label: 'At most hourly' },
  { value: 86_400, label: 'At most daily' },
]

/* ── account-activity targets ─────────────────────────────────────────────
 *
 * An account-activity rule watches a `target`: one address, a system tag, or
 * one of the viewer's own list tags. The server still accepts (and older rules
 * still carry) the flat `{ address }` shape, so reading a target has to cope
 * with both — every UI comparison and every form goes through these two
 * functions rather than poking at `params.address` directly.
 */

export function readTarget(params: Record<string, unknown>): NotificationTarget | null {
  const raw = params.target
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const t = raw as Record<string, unknown>
    if (t.kind === 'address' && typeof t.address === 'string' && t.address.trim()) {
      return { kind: 'address', address: t.address.trim() }
    }
    if (t.kind === 'tag' && typeof t.tagId === 'string' && t.tagId) return { kind: 'tag', tagId: t.tagId }
    if (t.kind === 'list-tag' && typeof t.listId === 'string' && t.listId && typeof t.tagId === 'string' && t.tagId) {
      return { kind: 'list-tag', listId: t.listId, tagId: t.tagId }
    }
    return null
  }
  // Legacy flat form, written before targets existed.
  const address = params.address
  return typeof address === 'string' && address.trim() ? { kind: 'address', address: address.trim() } : null
}

// The wire form a form/button submits: always the union, never the legacy key.
export function targetParams(target: NotificationTarget): { target: NotificationTarget } {
  return { target }
}

/* ── parameter equivalence ────────────────────────────────────────────────
 *
 * "Is this exact alert already subscribed?" is asked by every subscribe
 * affordance on every surface, against rules the server wrote — which may spell
 * the same subscription differently from the button: a legacy `{ address }`
 * against a `{ target }`, a stored `threshold` against an omitted default, a
 * track id as a number against the string the store keeps, phases in a
 * different order. Canonicalizing per kind — and comparing the canonical form,
 * never the raw object — is what makes the subscribed state survive a reload.
 */

// An address is compared case-sensitively as SS58 (base58 is case-significant)
// and case-insensitively as an H160 (hex is not).
function normalizeAddress(value: string): string {
  const a = value.trim()
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a
}

// Empty is absent: '', null, undefined and [] all mean "not set" in a rule's
// params, whichever the writer chose. 0 and false are real values and stay.
function isEmpty(value: unknown): boolean {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0)
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue).sort((a, b) => String(a).localeCompare(String(b)))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (isEmpty(v)) continue
      out[key] = canonicalValue(v)
    }
    return out
  }
  // A number that travelled as a string ('5' for a track id, '0' for an asset)
  // is the same parameter as the number itself.
  if (typeof value === 'string') {
    const t = value.trim()
    return /^-?\d+(?:\.\d+)?$/.test(t) ? Number(t) : t
  }
  return value
}

// Per-kind normalization, applied before the generic canonicalizer: the parts
// where two spellings of one subscription differ by more than key order.
function normalizeParams(kind: NotificationKind, params: Record<string, unknown>): Record<string, unknown> {
  const p = { ...params }
  switch (kind) {
    case 'account-activity': {
      const target = readTarget(p)
      const minUsd = Number(p.minUsd ?? 0)
      return {
        target: target && target.kind === 'address' ? { kind: 'address', address: normalizeAddress(target.address) } : target,
        // 'all' is what omitting the category means.
        type: p.type === 'all' ? undefined : p.type,
        action: typeof p.action === 'string' ? p.action.trim() : p.action,
        minUsd: Number.isFinite(minUsd) && minUsd > 0 ? minUsd : undefined,
      }
    }
    case 'health-factor':
      return {
        address: typeof p.address === 'string' ? normalizeAddress(p.address) : p.address,
        threshold: Number(p.threshold ?? HEALTH_FACTOR_DEFAULT),
      }
    case 'extrinsic':
      return {
        section: String(p.section ?? '').trim().toLowerCase(),
        method: typeof p.method === 'string' ? p.method.trim().toLowerCase() : undefined,
        success: p.success,
        signer: typeof p.signer === 'string' ? normalizeAddress(p.signer) : p.signer,
      }
    case 'event':
      return {
        section: String(p.section ?? '').trim().toLowerCase(),
        method: typeof p.method === 'string' ? p.method.trim().toLowerCase() : undefined,
      }
    default:
      return p
  }
}

// The comparable form of one rule's parameters: a stable string, so equality is
// a string compare and a fixture can key a map on it.
export function canonicalRuleParams(kind: NotificationKind, params: Record<string, unknown>): string {
  return JSON.stringify(canonicalValue(normalizeParams(kind, params ?? {})))
}

export function sameRuleParams(kind: NotificationKind, a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return canonicalRuleParams(kind, a) === canonicalRuleParams(kind, b)
}

// The rule a subscribe button is really asking about, or undefined. Only the
// kind and its parameters count — a rule's name, channels, cooldown and mute
// state are how the OWNER manages it, not what it subscribes to.
export function findEquivalentRule<R extends { kind: NotificationKind; params: Record<string, unknown> }>(
  rules: readonly R[],
  want: { kind: NotificationKind; params: Record<string, unknown> },
): R | undefined {
  const key = canonicalRuleParams(want.kind, want.params)
  return rules.find(r => r.kind === want.kind && canonicalRuleParams(r.kind, r.params) === key)
}

// How many alerts of one kind the viewer already has ON one token — whatever
// their threshold or direction. Deliberately NOT findEquivalentRule: a second
// price alert at another level, or a lower trade floor, is an ordinary thing to
// want, so the asset page counts subscriptions instead of toggling one exact
// rule. A rule of the same kind with no `assetId` watches every token and is
// not about this asset, so it is not counted — and `assetId` absent must never
// read as asset 0, which is HDX.
export function assetRuleCount<R extends { kind: NotificationKind; params: Record<string, unknown> }>(
  rules: readonly R[],
  kind: NotificationKind,
  assetId: number,
): number {
  return rules.filter(r => {
    if (r.kind !== kind) return false
    const raw = r.params?.assetId
    return raw != null && raw !== '' && Number(raw) === assetId
  }).length
}

// Whether a rule carries a tag target the rules table should draw as a pill.
export function ruleTagTarget(rule: Pick<NotificationRule, 'kind' | 'params'>): NotificationTarget | null {
  if (rule.kind !== 'account-activity') return null
  const target = readTarget(rule.params)
  return target && target.kind !== 'address' ? target : null
}

/* ── removing a rule ──────────────────────────────────────────────────────
 *
 * Deleting an alert cannot be undone and stops delivery immediately, so every
 * surface that offers it — the rules table's Delete, and every "Alerting ✓"
 * toggle on every page — asks first, with the SAME words naming the SAME rule.
 */

// How a rule is named where it is about to be removed: the name its owner gave
// it, else the server's summary — the same two strings, in the same order, the
// rules table leads with.
export function ruleSubject(rule: { name?: string; summary?: string }): string {
  return (rule.name || rule.summary || '').trim() || 'this alert'
}

export function deleteRuleConfirmBody(rule: { name?: string; summary?: string }): string {
  return `Delete "${ruleSubject(rule)}"? It stops alerting immediately.`
}

// How a rule's cooldown reads in the rules list.
export function cooldownLabel(cooldownS: number): string {
  if (!cooldownS) return 'every match'
  if (cooldownS % 86_400 === 0) return `${cooldownS / 86_400}d`
  if (cooldownS % 3600 === 0) return `${cooldownS / 3600}h`
  if (cooldownS % 60 === 0) return `${cooldownS / 60}m`
  return `${cooldownS}s`
}

// The subscribed state keeps the button's subject — two quick-add buttons both
// reading a bare "Alerting ✓" are indistinguishable. Only the generic labels,
// where the surrounding page IS the subject, collapse to the plain form.
export function subscribedLabel(label: string): string {
  const watching = label.replace(/^Watch\b/, 'Watching')
  if (watching !== label) return `${watching} ✓`
  if (label === 'Get notified' || label === 'Notify') return 'Alerting ✓'
  return `${label} ✓`
}
