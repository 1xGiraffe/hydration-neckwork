/* eslint-disable react-refresh/only-export-components -- dialog + its pure param builder */
import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ACTIVITY_ACTIONS, F, noAutofill } from './ui'
import { Combo, tokenFilterOptions } from './Filters'
import { nameOptionsInPallet, palletOptions } from './activityFilters'
import { addressOption, AlertTargetPicker, type TargetOption } from './AlertTargetPicker'
import { useFilterNames } from '../hooks/useExplorerData'
import { useNotificationsOverview } from '../hooks/useNotifications'
import {
  ACTIVITY_TYPES, COOLDOWN_CHOICES, HEALTH_FACTOR_DEFAULT, HEALTH_FACTOR_DEFAULT_MARKET, HEALTH_FACTOR_MAX, HEALTH_FACTOR_MIN,
  HEALTH_FACTOR_PRESETS, KIND_HINTS, KIND_LABELS, LARGE_VALUE_MIN_USD, NOTIFICATION_KINDS, PRICE_STEP_PCTS,
  REFERENDUM_PHASES, REFERENDUM_TRACKS, SAFETY_DEFICIT_DEFAULT_USD, SAFETY_FUSE_DEFAULT_PCT, SAFETY_KINDS,
  TC_MOTION_PHASES, USD_FLOOR_PRESETS, isAddressLike,
  isPalletNameLike, priceAtStep, priceStepLabel, readTarget, suggestPriceDirection, targetParams,
} from '../notificationKinds'
import type { AssetFilterItem, NotificationKind, NotificationMarket, NotificationRule, NotificationRuleInput, NotificationTarget } from '../types'

// "New alert": pick what to watch, then fill in that kind's own parameters.
// The field set per kind mirrors api/src/notifications/notificationRules.ts —
// the server re-validates everything and answers 422 by field name, so the
// checks here exist to catch the obvious ones before a round trip, never to be
// the authority.

// Free-text values keyed by field name, exactly like the filter zone's
// FilterValues — one state shape whatever kind is selected.
export type AlertFormValues = Record<string, string>

// What a surface hands the dialog when it opens it FOR something it is already
// showing — the asset page's three alert buttons. The kind is decided, the token
// is decided, and the fields open on values that already mean something, so the
// reader CONFIRMS an alert (adjusting a number if they like) instead of
// composing one from a blank form. Without a preset the dialog is the
// Notifications page's own "New alert", unchanged.
export type AlertPreset = {
  kind: NotificationKind
  // How the surface named the intent ("Trade alert") — the dialog title, and
  // nothing else. Falls back to the kind's registry label.
  label?: string
  // The values the form opens on, keyed by ITS field names, which for the three
  // asset kinds are the rule's own parameter names (assetId, minUsd, price,
  // direction). Numbers are accepted because a caller holds parameters rather
  // than form strings.
  params?: Record<string, string | number>
  name?: string
  // The token this dialog is FOR: shown as a fixed chip instead of a combo, and
  // its live price is what the price form's quick-adjust chips work from — the
  // asset page has that price already, so the dialog needs no directory of its own.
  lockAsset?: { assetId: number; symbol: string; price?: number | null }
}

// A preset's opening form state. The locked token always wins over a spelled-out
// assetId, since it is the one field the reader cannot change here.
function presetValues(preset: AlertPreset | null | undefined): AlertFormValues {
  if (!preset) return {}
  const values: AlertFormValues = {}
  for (const [key, value] of Object.entries(preset.params ?? {})) values[key] = String(value)
  if (preset.lockAsset) values.assetId = String(preset.lockAsset.assetId)
  return values
}

// An existing rule's SERVER params → the form's state, the reverse of
// buildRuleParams. Scalars flatten to strings like a preset's do; the union
// targets become picker options — a tag one dressed with the display fields the
// rules table already carries, an address one with the plain address pill.
function seededTarget(rule: NotificationRule, raw: unknown): TargetOption | null {
  const target = readTarget({ target: raw } as Record<string, unknown>)
  if (!target) return null
  if (target.kind === 'address') return addressOption(target.address)
  return {
    key: target.kind === 'tag' ? `tag:${target.tagId}` : `list-tag:${target.listId}:${target.tagId}`,
    target,
    label: rule.targetLabel ?? target.tagId,
    icon: rule.targetIcon,
    color: rule.targetColor,
  }
}

export function seedFromRule(rule: NotificationRule): {
  values: AlertFormValues
  phases: string[]
  motionPhases: string[]
  safetyKinds: string[]
  target: TargetOption | null
  signerTarget: TargetOption | null
} {
  const p = rule.params
  const values: AlertFormValues = {}
  for (const [key, value] of Object.entries(p)) {
    if (value == null || typeof value === 'object' || typeof value === 'boolean') continue
    values[key] = String(value)
  }
  // Booleans and unions take their form spellings.
  if (rule.kind === 'extrinsic' && typeof p.success === 'boolean') values.success = p.success ? 'yes' : 'no'
  if (rule.kind === 'large-trade' && typeof p.dcaStart === 'boolean') values.dcaStart = p.dcaStart ? 'yes' : 'no'
  return {
    values,
    phases: rule.kind === 'referendum' && Array.isArray(p.phases) ? p.phases.map(String) : [],
    motionPhases: rule.kind === 'tc-motion' && Array.isArray(p.phases) ? p.phases.map(String) : [],
    safetyKinds: rule.kind === 'safety' && Array.isArray(p.kinds) ? p.kinds.map(String) : [],
    target: seededTarget(rule, p.target),
    signerTarget: typeof p.signer === 'string' && p.signer ? addressOption(p.signer) : null,
  }
}

function num(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : undefined
}

// The form's values → the kind's `params` object, or the first thing wrong with
// them. Pure, so the mapping from a filled-in form to a rule is testable
// without a DOM. `sets` carries the two multi-select kinds (referendum phases,
// safety kinds) and the account-activity `target` the picker chose; an empty
// set means "all", which is what omitting the key does.
export function buildRuleParams(
  kind: NotificationKind,
  v: AlertFormValues,
  sets: {
    phases: string[]
    motionPhases: string[]
    safetyKinds: string[]
    target?: NotificationTarget | null
    // The extrinsic form's signer picker, read the same way as `target`: a picked
    // account wins over whatever text is sitting in the box, because picking one
    // empties that box by design.
    signerTarget?: NotificationTarget | null
  },
): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  const address = (v.address ?? '').trim()
  switch (kind) {
    case 'account-activity': {
      // The picker's own selection wins; a raw address left sitting in the box
      // (typed, never picked) is accepted verbatim, since the search endpoint
      // only knows accounts it has already seen.
      const target = sets.target ?? (isAddressLike(address) ? ({ kind: 'address', address } as const) : null)
      if (!target) return { ok: false, error: 'Pick an account or tag to watch, or paste an SS58 or 0x address' }
      const minUsd = num(v.minUsd ?? '')
      const action = (v.action ?? '').trim()
      return { ok: true, params: {
        ...targetParams(target),
        ...(v.type && v.type !== 'all' ? { type: v.type } : {}),
        ...(action ? { action } : {}),
        ...(minUsd != null && minUsd > 0 ? { minUsd } : {}),
      } }
    }
    // The two value-floor kinds take the same pair of parameters; only the feed
    // behind them differs.
    case 'large-trade':
    case 'large-transfer': {
      const minUsd = num(v.minUsd ?? '')
      if (minUsd == null || minUsd < LARGE_VALUE_MIN_USD) return { ok: false, error: `Set a floor of at least $${LARGE_VALUE_MIN_USD}` }
      const assetId = num(v.assetId ?? '')
      return { ok: true, params: {
        minUsd,
        ...(assetId != null ? { assetId } : {}),
        // Only the trade kind has DCA schedules to watch — the transfer schema
        // rejects the flag. Omitting it means ON (the server defaults it), so the
        // form only ever sends the explicit opt-out.
        ...(kind === 'large-trade' && v.dcaStart === 'no' ? { dcaStart: false } : {}),
      } }
    }
    // Judged on the protocol's own share, so the floor is small by nature: a routed
    // swap earns the protocol fractions of a cent, while a liquidation can earn
    // hundreds. Any floor at all is what keeps the rule from firing on everything.
    case 'protocol-revenue': {
      const minUsd = num(v.minUsd ?? '')
      if (minUsd == null || minUsd < 1) return { ok: false, error: 'Set a floor of at least $1' }
      return { ok: true, params: { minUsd } }
    }
    // Liquidations are rare enough to need no floor, and the target is optional: with
    // none the rule watches every liquidation on the chain.
    case 'liquidation': {
      const target = sets.target ?? (isAddressLike(address) ? ({ kind: 'address', address } as const) : null)
      const minUsd = num(v.minUsd ?? '')
      return { ok: true, params: {
        ...(target ? targetParams(target) : {}),
        ...(minUsd != null && minUsd > 0 ? { minUsd } : {}),
      } }
    }
    case 'price': {
      const assetId = num(v.assetId ?? '')
      if (assetId == null) return { ok: false, error: 'Pick a token' }
      const price = num(v.price ?? '')
      if (price == null || price <= 0) return { ok: false, error: 'Enter the price to watch for' }
      return { ok: true, params: { assetId, direction: v.direction === 'below' ? 'below' : 'above', price } }
    }
    case 'health-factor': {
      // The picker's selection wins; a pasted, never-picked address still counts
      // (same contract as account-activity above). A tag watches every member's
      // position — in the ONE market the rule names, since the markets are
      // isolated and a borrower in two has two health factors. The market is sent
      // explicitly, default included, so a stored rule and the form agree.
      const target = sets.target ?? (isAddressLike(address) ? ({ kind: 'address', address } as const) : null)
      if (!target) return { ok: false, error: 'Pick an account or tag to watch, or paste an SS58 or 0x address' }
      const threshold = num(v.threshold ?? '') ?? HEALTH_FACTOR_DEFAULT
      if (threshold < HEALTH_FACTOR_MIN || threshold > HEALTH_FACTOR_MAX) {
        return { ok: false, error: `The threshold must be between ${HEALTH_FACTOR_MIN} and ${HEALTH_FACTOR_MAX}` }
      }
      const market = (v.market ?? '').trim() || HEALTH_FACTOR_DEFAULT_MARKET
      return { ok: true, params: { ...targetParams(target), threshold, market } }
    }
    // One rule per market: every capped reserve of it, or one token's. The market
    // is the one thing the rule cannot do without.
    case 'mm-cap': {
      const market = (v.market ?? '').trim()
      if (!market) return { ok: false, error: 'Pick the money market to watch' }
      const assetId = num(v.assetId ?? '')
      return { ok: true, params: { market, ...(assetId != null ? { assetId } : {}) } }
    }
    case 'referendum': {
      const track = (v.track ?? '').trim()
      return { ok: true, params: {
        ...(sets.phases.length ? { phases: sets.phases } : {}),
        ...(track ? { track } : {}),
      } }
    }
    // Its own phase set, so a referendum rule can never be built out of motion
    // phases (or the other way round) — the server rejects the crossed spelling too.
    case 'tc-motion':
      return { ok: true, params: sets.motionPhases.length ? { phases: sets.motionPhases } : {} }
    // One kind covers every security event, so each of the two numbers belongs
    // to one event alone and is only sent while that event is watched — an
    // empty chip set being "every event", both count as watched there too.
    // Omitting a number means the server's own default.
    case 'safety': {
      const kinds = sets.safetyKinds
      const watches = (kind: string) => !kinds.length || kinds.includes(kind)
      const deficitUsd = num(v.deficitUsd ?? '')
      const fusePct = num(v.fusePct ?? '')
      if (watches('deficit') && deficitUsd != null && deficitUsd < 0) {
        return { ok: false, error: 'The deficit floor cannot be negative' }
      }
      if (watches('fuse') && fusePct != null && (fusePct < 0 || fusePct > 100)) {
        return { ok: false, error: 'The fuse threshold must be between 0 and 100' }
      }
      return { ok: true, params: {
        ...(kinds.length ? { kinds } : {}),
        ...(watches('deficit') && deficitUsd != null ? { deficitUsd } : {}),
        ...(watches('fuse') && fusePct != null ? { fusePct } : {}),
      } }
    }
    case 'extrinsic': {
      const section = (v.section ?? '').trim()
      if (!isPalletNameLike(section)) return { ok: false, error: 'Enter a pallet name, e.g. Omnipool' }
      const method = (v.method ?? '').trim()
      if (method && !isPalletNameLike(method)) return { ok: false, error: 'Enter a call name, e.g. sell' }
      const picked = sets.signerTarget
      const signer = (picked && picked.kind === 'address' ? picked.address : (v.signer ?? '')).trim()
      if (signer && !isAddressLike(signer)) return { ok: false, error: 'The signer must be an SS58 or 0x address' }
      return { ok: true, params: {
        section,
        ...(method ? { method } : {}),
        ...(v.success === 'yes' ? { success: true } : v.success === 'no' ? { success: false } : {}),
        ...(signer ? { signer } : {}),
      } }
    }
    case 'event': {
      const section = (v.section ?? '').trim()
      if (!isPalletNameLike(section)) return { ok: false, error: 'Enter a pallet name, e.g. Referenda' }
      const method = (v.method ?? '').trim()
      if (method && !isPalletNameLike(method)) return { ok: false, error: 'Enter an event name, e.g. Submitted' }
      return { ok: true, params: { section, ...(method ? { method } : {}) } }
    }
  }
}

// The actions an account-activity rule can name, for the category it is watching:
// the SAME per-category map the activity filters offer, because the rule's `action`
// is matched against the activity feed's own label. A category with no actions (and
// "Everything") has nothing to narrow, so the field is absent rather than empty,
// and '' — no option selected — means every action.
export function actionOptions(type: string | undefined): { v: string; label: string }[] {
  return ACTIVITY_ACTIONS[type ?? ''] ?? []
}

// A set of on/off chips — referendum phases and safety kinds are both "any of
// these", and none selected means all of them (the key is simply omitted).
function ChipSet({ options, selected, onToggle, label, disabled }: {
  options: readonly string[]
  selected: string[]
  onToggle: (value: string) => void
  label: string
  disabled?: boolean
}) {
  return (
    <div className="activity-chips" role="group" aria-label={label}>
      {options.map(option => (
        <button
          key={option}
          type="button"
          className={`activity-chip${selected.includes(option) ? ' on' : ''}`}
          aria-pressed={selected.includes(option)}
          disabled={disabled}
          onClick={() => onToggle(option)}
        >{option}</button>
      ))}
    </div>
  )
}

// One-click values for a number field: the chip fills the input rather than
// replacing it, so the common answers cost no typing and an uncommon one is still
// typeable. A chip reads as pressed while the input holds its value, which is what
// makes the set say where the current value SITS, not just what it could be.
function PresetChips({ options, value, onPick, label, disabled }: {
  options: readonly { value: number; label: string }[]
  value: string
  onPick: (value: string) => void
  label: string
  disabled?: boolean
}) {
  const current = value.trim() ? Number(value) : Number.NaN
  return (
    <div className="activity-chips alert-presets" role="group" aria-label={label}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          className={`activity-chip${current === option.value ? ' on' : ''}`}
          aria-pressed={current === option.value}
          disabled={disabled}
          onClick={() => onPick(String(option.value))}
        >{option.label}</button>
      ))}
    </div>
  )
}

export function NewAlertDialog({ open, onOpenChange, assets, pending, initialKind, preset, submitLabel, onSubmit, editRule }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  assets: AssetFilterItem[]
  pending: boolean
  initialKind?: NotificationKind
  // Set by a surface that opened this dialog for one thing (see AlertPreset):
  // the kind picker goes away, the token is fixed, and the fields arrive filled.
  preset?: AlertPreset | null
  // Overrides the primary button's words where the click does something other
  // than create — logged out it starts a login instead, and saying so is the
  // difference between an alert affordance and a dead end.
  submitLabel?: string
  // Resolving with `{ existing: true }` says the server answered its idempotent
  // create with the rule that was already there; the dialog then says so in
  // place rather than treating a harmless duplicate as an error.
  onSubmit: (input: NotificationRuleInput) => Promise<{ existing?: boolean } | void>
  // An existing rule to EDIT: the kind is fixed, every field arrives seeded from
  // the rule's own params, and submit hands the parent the same input shape —
  // the parent patches instead of creating. Name and frequency are always sent,
  // so clearing them clears them.
  editRule?: NotificationRule | null
}) {
  const seed = editRule ? seedFromRule(editRule) : null
  const [kind, setKind] = useState<NotificationKind>(editRule?.kind ?? preset?.kind ?? initialKind ?? 'large-trade')
  const [values, setValues] = useState<AlertFormValues>(() => seed?.values ?? presetValues(preset))
  const [target, setTarget] = useState<TargetOption | null>(seed?.target ?? null)
  const [signerTarget, setSignerTarget] = useState<TargetOption | null>(seed?.signerTarget ?? null)
  const [phases, setPhases] = useState<string[]>(seed?.phases ?? [])
  const [motionPhases, setMotionPhases] = useState<string[]>(seed?.motionPhases ?? [])
  const [safetyKinds, setSafetyKinds] = useState<string[]>(seed?.safetyKinds ?? [])
  const [name, setName] = useState(editRule?.name ?? preset?.name ?? '')
  const [cooldownS, setCooldownS] = useState(editRule?.cooldownS ?? 0)
  const [error, setError] = useState<string | null>(null)
  // "You already have this one" — a note, not an error: the create is idempotent,
  // so nothing went wrong and nothing was duplicated.
  const [existingNote, setExistingNote] = useState(false)
  // The names the data actually holds, so the two matcher kinds offer pallets and
  // calls/events instead of asking to be told one. Suggestions only: both combos
  // accept free text, since a name too new for the catalogue's window is still a
  // perfectly good matcher.
  const filterNames = useFilterNames()
  // The isolated money markets a health-factor or cap rule can name, as this
  // deployment configures them. Off the overview the topbar already keeps warm,
  // so the two market forms cost no request of their own.
  const markets: NotificationMarket[] = useNotificationsOverview().data?.markets ?? []
  const shownMarket = (values.market ?? '').trim() || (kind === 'health-factor' ? HEALTH_FACTOR_DEFAULT_MARKET : '')

  // Prop-change reset, the same pattern ListFormDialog/ConnectDialog use: every
  // open starts from a clean form so a previous attempt's half-filled fields
  // and its error never greet the next one.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      const freshSeed = editRule ? seedFromRule(editRule) : null
      setKind(editRule?.kind ?? preset?.kind ?? initialKind ?? 'large-trade')
      setValues(freshSeed?.values ?? presetValues(preset))
      setTarget(freshSeed?.target ?? null); setSignerTarget(freshSeed?.signerTarget ?? null)
      setPhases(freshSeed?.phases ?? []); setMotionPhases(freshSeed?.motionPhases ?? []); setSafetyKinds(freshSeed?.safetyKinds ?? [])
      setName(editRule?.name ?? preset?.name ?? ''); setCooldownS(editRule?.cooldownS ?? 0); setError(null); setExistingNote(false)
    }
  }

  const set = (key: string, value: string) => setValues(current => ({ ...current, [key]: value }))
  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter(v => v !== value) : [...list, value])

  const lockAsset = preset?.lockAsset
  // A locked token's price comes from the surface that locked it (the asset page
  // is already showing it), so this dialog needs no token directory at all there.
  const lockedPrice = typeof lockAsset?.price === 'number' && lockAsset.price > 0 ? lockAsset.price : null
  // A picked token's live price, off the directory the dialog already loaded —
  // what turns a price threshold from a guess into a decision.
  const priceOf = (assetId: string | undefined) => {
    if (lockedPrice != null && assetId === String(lockAsset?.assetId)) return lockedPrice
    const asset = assetId ? assets.find(a => String(a.assetId) === assetId) : undefined
    return typeof asset?.price === 'number' && asset.price > 0 ? asset.price : null
  }
  // The direction the form shows: the reader's own choice once they make one
  // (`values.direction` set IS the choice), otherwise the one their threshold
  // implies against the current price. Read by both the select and submit, so what
  // is shown is always what gets sent.
  function shownDirection(v: AlertFormValues): 'above' | 'below' {
    if (v.direction === 'above' || v.direction === 'below') return v.direction
    const current = priceOf(v.assetId)
    const threshold = num(v.price ?? '')
    return current != null && threshold != null && threshold > 0 ? suggestPriceDirection(threshold, current) : 'above'
  }

  async function submit() {
    setError(null)
    setExistingNote(false)
    const built = buildRuleParams(kind, { ...values, direction: shownDirection(values) }, {
      phases, motionPhases, safetyKinds,
      target: target?.target ?? null,
      signerTarget: signerTarget?.target ?? null,
    })
    if (!built.ok) { setError(built.error); return }
    try {
      // An edit always carries name and frequency, so clearing either clears
      // it on the rule; a create keeps omitting what was never set.
      const result = await onSubmit(editRule
        ? { kind, params: built.params, name: name.trim(), cooldownS }
        : {
          kind,
          params: built.params,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(cooldownS ? { cooldownS } : {}),
        })
      if (result?.existing) setExistingNote(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : editRule ? 'Could not save the alert' : 'Could not create the alert')
    }
  }

  const tokenOptions = tokenFilterOptions(assets)
  const currentPrice = priceOf(values.assetId)
  // With a preset the title names the intent the surface offered and the token it
  // offered it for — "Price alert · DOT" — because the reader clicked something
  // specific and the dialog has to be recognisably the answer to it.
  const intent = editRule ? `Edit alert · ${KIND_LABELS[editRule.kind]}` : preset ? (preset.label ?? KIND_LABELS[preset.kind]) : 'New alert'
  const title = !editRule && preset && lockAsset ? `${intent} · ${lockAsset.symbol}` : intent
  const catalogue = kind === 'event' ? filterNames.data?.events ?? [] : filterNames.data?.calls ?? []
  const pallets = palletOptions(catalogue, kind === 'event' ? 'event' : 'call')
  const methods = nameOptionsInPallet(catalogue, values.section ?? '')

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog">
          <div className="dialog-head">
            <Dialog.Title asChild><h2>{title}</h2></Dialog.Title>
            <Dialog.Close asChild>
              <button className="theme-toggle" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </Dialog.Close>
          </div>
          <div className="dialog-body">
            <Dialog.Description className="dialog-hint">
              {preset ? `${KIND_HINTS[kind]} ` : ''}Alerts run on finalized blocks only and never fire for backfilled history.
            </Dialog.Description>
            {error && <div className="dialog-error">{error}</div>}
            {/* Idempotent create: an identical rule was already there and was kept.
                Nothing failed, so this reads as information rather than a refusal —
                and the alert list is where anything more is done about it. */}
            {existingNote && (
              <div className="dialog-note">
                You are already alerting on exactly this — your existing alert was kept.
              </div>
            )}

            {/* A preset (or the rule under edit) decided the kind, so the picker
                would only offer a way to turn this dialog into a different one. */}
            {!preset && !editRule && (
              <div className="field">
                <label htmlFor="alert-kind">Watch</label>
                <select id="alert-kind" value={kind} disabled={pending} onChange={e => { setKind(e.target.value as NotificationKind); setError(null) }}>
                  {NOTIFICATION_KINDS.map(k => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                </select>
                <div className="muted" style={{ fontSize: 11 }}>{KIND_HINTS[kind]}</div>
              </div>
            )}

            {kind === 'health-factor' && (
              <div className="field">
                {/* The same picker as account-activity: an account by name or
                    address, a tag by its name, the viewer's own account offered
                    before anything is typed. A tag watches every member's
                    position — membership is followed live. */}
                <label htmlFor="alert-hf-target" className="field-label">Whose position</label>
                <AlertTargetPicker inputId="alert-hf-target" value={target} onChange={setTarget}
                  onTextChange={t => set('address', t)} disabled={pending} />
              </div>
            )}

            {kind === 'liquidation' && (
              <div className="field">
                {/* Optional, unlike the other target kinds: with nothing picked the
                    rule watches every liquidation on the chain, which is the common
                    case. A tag follows its membership live. */}
                <label htmlFor="alert-liq-target" className="field-label">Whose position (optional)</label>
                <AlertTargetPicker inputId="alert-liq-target" value={target} onChange={setTarget}
                  onTextChange={t => set('address', t)} disabled={pending} />
              </div>
            )}

            {(kind === 'liquidation' || kind === 'protocol-revenue') && (
              <div className="field">
                <label htmlFor="alert-min-rev">
                  {kind === 'protocol-revenue' ? 'Protocol earns over (USD)' : 'Position over (USD, optional)'}
                </label>
                <input {...noAutofill} id="alert-min-rev" type="number"
                  min={kind === 'protocol-revenue' ? 1 : 0}
                  placeholder={kind === 'protocol-revenue' ? '10' : 'any size'}
                  value={values.minUsd ?? ''} disabled={pending} onChange={e => set('minUsd', e.target.value)} />
                {/* The protocol's own share of the fees, not the LPs'. A big routed
                    swap can pay LPs handsomely and the protocol very little. */}
                <div className="muted" style={{ fontSize: 11 }}>{KIND_HINTS[kind]}</div>
              </div>
            )}

            {kind === 'account-activity' && (
              <>
                {/* Found by typing, like anything else on the explorer — an
                    account by name or address, a tag by its name. A tag target
                    follows the tag: accounts added to it later are watched too. */}
                <div className="field">
                  <label htmlFor="alert-target" className="field-label">Watch what</label>
                  <AlertTargetPicker inputId="alert-target" value={target} onChange={setTarget}
                    onTextChange={t => set('address', t)} disabled={pending} />
                </div>
                {/* Changing the category changes which actions exist, so a
                    stale one is cleared with it rather than left to match
                    nothing. */}
                <div className="field">
                  <label htmlFor="alert-type">Category</label>
                  <select id="alert-type" value={values.type ?? 'all'} disabled={pending}
                    onChange={e => setValues(current => ({ ...current, type: e.target.value, action: '' }))}>
                    {ACTIVITY_TYPES.map(t => <option key={t} value={t}>{t === 'all' ? 'Everything' : t}</option>)}
                  </select>
                </div>
                {/* The actions a category HAS, from the same map the activity
                    filters offer — a typed action the feed does not use would
                    simply never match. Categories with no action list (and
                    "Everything") have nothing to narrow, so the field is absent
                    rather than empty. */}
                {actionOptions(values.type).length > 0 && (
                  <div className="field">
                    <label htmlFor="alert-action">Action</label>
                    <select id="alert-action" value={values.action ?? ''} disabled={pending} onChange={e => set('action', e.target.value)}>
                      <option value="">Any action</option>
                      {actionOptions(values.type).map(a => <option key={a.v} value={a.v}>{a.label}</option>)}
                    </select>
                    <div className="muted" style={{ fontSize: 11 }}>The action label the activity feed shows, within the category above.</div>
                  </div>
                )}
                <div className="field">
                  <label htmlFor="alert-min-activity">Only above (USD)</label>
                  <input {...noAutofill} id="alert-min-activity" type="number" min={0} placeholder="Optional"
                    value={values.minUsd ?? ''} disabled={pending} onChange={e => set('minUsd', e.target.value)} />
                  <PresetChips options={USD_FLOOR_PRESETS} value={values.minUsd ?? ''} label="Value floor presets"
                    disabled={pending} onPick={v => set('minUsd', v)} />
                </div>
              </>
            )}

            {kind === 'health-factor' && (
              <div className="field">
                <label htmlFor="alert-threshold">Alert below</label>
                <input {...noAutofill} id="alert-threshold" type="number" step="0.05" min={HEALTH_FACTOR_MIN} max={HEALTH_FACTOR_MAX}
                  placeholder={String(HEALTH_FACTOR_DEFAULT)} value={values.threshold ?? ''} disabled={pending}
                  onChange={e => set('threshold', e.target.value)} />
                {/* The app's own bands: 1.1 is where the explorer already paints a
                    health factor red, 1.6 where the warning band ends. */}
                <PresetChips options={HEALTH_FACTOR_PRESETS.map(v => ({ value: v, label: v.toFixed(1) }))}
                  value={values.threshold ?? ''} label="Health factor presets" disabled={pending}
                  onPick={v => set('threshold', v)} />
              </div>
            )}

            {/* The markets are isolated pools: a borrower in two has two health
                factors, and a cap belongs to one market's reserve. Both kinds
                therefore pick ONE market; the health-factor form opens on the
                primary one, which is what its rules have always meant. */}
            {(kind === 'health-factor' || kind === 'mm-cap') && (
              <div className="field">
                <label htmlFor="alert-market">Money market</label>
                {/* One effective market for what the select SHOWS and what submit
                    sends: an empty value (the box cleared on the cap form, then
                    the kind switched) means the health-factor default, exactly
                    as buildRuleParams reads it. */}
                <select id="alert-market" value={shownMarket} disabled={pending} onChange={e => set('market', e.target.value)}>
                  {kind === 'mm-cap' && <option value="">Pick a market</option>}
                  {markets.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                  {/* The shown market may be one the overview has not listed —
                      the list not loaded yet, or a rule under edit naming a market
                      the deployment no longer configures. Keep it selectable and
                      visible rather than rendering a blank choice that submits. */}
                  {shownMarket && !markets.some(m => m.key === shownMarket) && (
                    <option value={shownMarket}>{shownMarket === HEALTH_FACTOR_DEFAULT_MARKET ? 'Primary money market' : shownMarket}</option>
                  )}
                </select>
                <div className="muted" style={{ fontSize: 11 }}>
                  {kind === 'health-factor'
                    ? 'Each market has its own health factor; this rule watches this one only.'
                    : 'Every capped reserve of this market, on both the borrow and the supply side.'}
                </div>
              </div>
            )}

            {kind === 'mm-cap' && (
              <div className="field">
                <label className="field-label">Token</label>
                <Combo value={values.assetId ?? ''} placeholder="Every reserve" label="Token"
                  options={tokenOptions} onChange={v => set('assetId', v)} />
                <div className="muted" style={{ fontSize: 11 }}>Optional — narrow to one reserve, e.g. HOLLAR.</div>
              </div>
            )}

            {(kind === 'large-trade' || kind === 'large-transfer' || kind === 'price') && (
              <div className="field">
                <label id="alert-token-label" className="field-label">Token</label>
                {/* Opened from a token's own page, the token is not a decision left
                    to make: it reads as the settled fact it is, not as a combo
                    whose one job would be to be changed back. */}
                {lockAsset
                  ? <div className="alert-locked"><span className="notif-chip alert-locked-token">{lockAsset.symbol} · #{lockAsset.assetId}</span></div>
                  : <Combo value={values.assetId ?? ''} placeholder={kind === 'price' ? 'Pick a token' : 'Any token'} label="Token"
                      options={tokenOptions} onChange={v => set('assetId', v)} />}
              </div>
            )}

            {(kind === 'large-trade' || kind === 'large-transfer') && (
              <div className="field">
                <label htmlFor={kind === 'large-trade' ? 'alert-min-trade' : 'alert-min-transfer'}>
                  {kind === 'large-trade' ? 'Trades over (USD)' : 'Transfers over (USD)'}
                </label>
                <input {...noAutofill} id={kind === 'large-trade' ? 'alert-min-trade' : 'alert-min-transfer'} type="number"
                  min={LARGE_VALUE_MIN_USD} placeholder={String(LARGE_VALUE_MIN_USD)}
                  value={values.minUsd ?? ''} disabled={pending} onChange={e => set('minUsd', e.target.value)} />
                <PresetChips options={USD_FLOOR_PRESETS} value={values.minUsd ?? ''} label="Value floor presets"
                  disabled={pending} onPick={v => set('minUsd', v)} />
              </div>
            )}

            {/* A DCA schedule is a standing order, so it is judged on the lower of
                its hourly rate and its whole size — the same floor, read as a rate.
                On unless turned off, so an alert written before this existed keeps
                behaving the way its owner expects. */}
            {kind === 'large-trade' && (
              <div className="field">
                <label htmlFor="alert-dca-start">DCA schedules</label>
                <select id="alert-dca-start" value={values.dcaStart === 'no' ? 'no' : 'yes'} disabled={pending}
                  onChange={e => set('dcaStart', e.target.value)}>
                  <option value="yes">Also alert when one starts at this rate per hour</option>
                  <option value="no">Only alert on individual trades</option>
                </select>
              </div>
            )}

            {kind === 'price' && (
              <>
                {/* The threshold comes first here: what the token costs now is
                    what makes a number meaningful, and the direction then follows
                    from the two — until the reader says otherwise. */}
                <div className="field">
                  <label htmlFor="alert-price">Price (USD)</label>
                  <input {...noAutofill} id="alert-price" type="number" step="any" min={0} placeholder="0.00"
                    value={values.price ?? ''} disabled={pending} onChange={e => set('price', e.target.value)} />
                  {currentPrice != null && (
                    <div className="alert-price-hint muted">
                      Now <span className="mono">{F.priceUsd(currentPrice)}</span>
                      {/* The EXACT price, not the rounded display value — the same
                          thing the asset page's own bell subscribes to. */}
                      <button type="button" className="btn sm" disabled={pending} onClick={() => set('price', String(currentPrice))}>Use current</button>
                    </div>
                  )}
                  {/* "Tell me if it moves this far" is what a price alert usually
                      means, and it is a percentage of the CURRENT price — so each
                      step is measured from the live price rather than from whatever
                      the field holds, and tapping two in a row never compounds. The
                      direction follows the sign, and stays overridable below. */}
                  {currentPrice != null && (
                    <div className="activity-chips alert-presets" role="group" aria-label="Adjust from the current price">
                      {PRICE_STEP_PCTS.map(pct => {
                        const stepped = priceAtStep(currentPrice, pct)
                        const on = num(values.price ?? '') === stepped
                        return (
                          <button key={pct} type="button" className={`activity-chip${on ? ' on' : ''}`} aria-pressed={on}
                            title={F.priceUsd(stepped)} disabled={pending}
                            onClick={() => setValues(current => ({ ...current, price: String(stepped), direction: pct < 0 ? 'below' : 'above' }))}
                          >{priceStepLabel(pct)}</button>
                        )
                      })}
                    </div>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="alert-direction">Direction</label>
                  <select id="alert-direction" value={shownDirection(values)} disabled={pending} onChange={e => set('direction', e.target.value)}>
                    <option value="above">Rises above</option>
                    <option value="below">Falls below</option>
                  </select>
                  {currentPrice != null && values.direction == null && num(values.price ?? '') != null && (
                    <div className="muted" style={{ fontSize: 11 }}>Suggested from the price you entered — change it if you meant the other way.</div>
                  )}
                </div>
              </>
            )}

            {kind === 'referendum' && (
              <>
                <div className="field">
                  <label className="field-label">Phases</label>
                  <ChipSet options={REFERENDUM_PHASES} selected={phases} label="Referendum phases" disabled={pending}
                    onToggle={value => setPhases(current => toggle(current, value))} />
                  <div className="muted" style={{ fontSize: 11 }}>{phases.length ? `${phases.length} selected` : 'None selected — every phase.'}</div>
                </div>
                {/* The chain reports the numeric track id, so the option value
                    is the id and the label is the runtime's own name. */}
                <div className="field">
                  <label htmlFor="alert-track">Track</label>
                  <select id="alert-track" value={values.track ?? ''} disabled={pending} onChange={e => set('track', e.target.value)}>
                    <option value="">Any track</option>
                    {REFERENDUM_TRACKS.map(t => <option key={t.id} value={String(t.id)}>{t.name}</option>)}
                  </select>
                </div>
              </>
            )}

            {kind === 'tc-motion' && (
              <div className="field">
                <label className="field-label">Phases</label>
                <ChipSet options={TC_MOTION_PHASES} selected={motionPhases} label="Motion phases" disabled={pending}
                  onToggle={value => setMotionPhases(current => toggle(current, value))} />
                <div className="muted" style={{ fontSize: 11 }}>{motionPhases.length ? `${motionPhases.length} selected` : 'None selected — every phase.'}</div>
              </div>
            )}

            {/* One card for every security event — the chain's own safety
                actions and the Wormhole bridge's states in one chip set, so no
                event can arrive twice and none is missed by subscribing to the
                wrong half. Each number belongs to one event, so it appears only
                while that event is watched — and an empty set watches
                everything, both of them included. */}
            {kind === 'safety' && (
              <>
                <div className="field">
                  <label className="field-label">Events</label>
                  <ChipSet options={SAFETY_KINDS} selected={safetyKinds} label="Security event kinds" disabled={pending}
                    onToggle={value => setSafetyKinds(current => toggle(current, value))} />
                  <div className="muted" style={{ fontSize: 11 }}>{safetyKinds.length ? `${safetyKinds.length} selected` : 'None selected — every security event.'}</div>
                </div>
                {(!safetyKinds.length || safetyKinds.includes('deficit')) && (
                  <div className="field">
                    <label htmlFor="alert-safety-deficit">Deficit over (USD)</label>
                    <input {...noAutofill} id="alert-safety-deficit" type="number" min={0}
                      placeholder={String(SAFETY_DEFICIT_DEFAULT_USD)}
                      value={values.deficitUsd ?? ''} disabled={pending} onChange={e => set('deficitUsd', e.target.value)} />
                    {/* Custody runs a few units either way by design, so a floor
                        is what separates the seeded noise from supply that has
                        genuinely lost its backing. */}
                    <div className="muted" style={{ fontSize: 11 }}>
                      How much bridged supply may go unbacked before this alerts.
                    </div>
                  </div>
                )}
                {(!safetyKinds.length || safetyKinds.includes('fuse')) && (
                  <div className="field">
                    <label htmlFor="alert-safety-fuse">Fuse threshold (%)</label>
                    <input {...noAutofill} id="alert-safety-fuse" type="number" min={0} max={100}
                      placeholder={String(SAFETY_FUSE_DEFAULT_PCT)}
                      value={values.fusePct ?? ''} disabled={pending} onChange={e => set('fusePct', e.target.value)} />
                    {/* Below the limit rather than at it: past the fuse a
                        transfer is held for a whole window, so the alert is
                        worth having while there is still headroom to use. */}
                    <div className="muted" style={{ fontSize: 11 }}>
                      How much of a bridge rate limit may be spent before this alerts. The other events have no threshold.
                    </div>
                  </div>
                )}
              </>
            )}

            {(kind === 'extrinsic' || kind === 'event') && (
              <>
                {/* Nobody knows a pallet.Call name by heart, so both fields offer
                    the names the data actually holds — and both still take a typed
                    one, for a name too new for the catalogue's window. Choosing
                    another pallet drops the call chosen inside the old one. */}
                <div className="field">
                  <label htmlFor="alert-section">Pallet</label>
                  <Combo inputId="alert-section" value={values.section ?? ''} freeText options={pallets}
                    placeholder="Pick a pallet" label="Pallet"
                    onChange={v => setValues(current => ({ ...current, section: v, method: '' }))} />
                </div>
                <div className="field">
                  <label htmlFor="alert-method">{kind === 'event' ? 'Event' : 'Call'}</label>
                  <Combo inputId="alert-method" value={values.method ?? ''} freeText options={methods}
                    placeholder={values.section ? 'Any in this pallet' : 'Optional — any'}
                    label={kind === 'event' ? 'Event' : 'Call'}
                    onChange={v => set('method', v)} />
                </div>
              </>
            )}

            {kind === 'extrinsic' && (
              <>
                <div className="field">
                  <label htmlFor="alert-success">Outcome</label>
                  <select id="alert-success" value={values.success ?? ''} disabled={pending} onChange={e => set('success', e.target.value)}>
                    <option value="">Any outcome</option>
                    <option value="yes">Successful only</option>
                    <option value="no">Failed only</option>
                  </select>
                </div>
                {/* The same typeahead the account-activity target uses, narrowed to
                    accounts: a signer is one address, so a tag row here would offer
                    something this parameter cannot express. */}
                <div className="field">
                  <label htmlFor="alert-signer" className="field-label">Signer</label>
                  <AlertTargetPicker inputId="alert-signer" value={signerTarget} addressOnly
                    onChange={setSignerTarget} onTextChange={t => set('signer', t)} disabled={pending} />
                  <div className="muted" style={{ fontSize: 11 }}>Optional — any signer when empty.</div>
                </div>
              </>
            )}

            <div className="field">
              <label htmlFor="alert-name">Name</label>
              <input {...noAutofill} id="alert-name" placeholder="Optional — how it reads in your list" maxLength={64}
                value={name} disabled={pending} onChange={e => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="alert-cooldown">Frequency</label>
              <select id="alert-cooldown" value={String(cooldownS)} disabled={pending} onChange={e => setCooldownS(Number(e.target.value))}>
                {COOLDOWN_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn primary" onClick={() => void submit()} disabled={pending}>
              {submitLabel ?? (editRule ? 'Save changes' : preset ? 'Save alert' : 'Create alert')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
