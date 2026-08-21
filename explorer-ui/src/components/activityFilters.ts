import type { AssetFilterItem } from '../types'
import { ACTIVITY_ACTIONS } from './ui'
import { tokenFilterOptions, type ComboOption, type FilterField } from './Filters'

const DATE_FIELDS: FilterField[] = [
  { kind: 'date', key: 'from', title: 'From date' },
  { kind: 'date', key: 'to', title: 'To date' },
]

// Whether the explorer can put a name to the account a row is BY — a system tag
// ("Treasury", "Kraken"), an on-chain identity, a profile name, or a verified
// contract's name. Named separates the actors a reader can recognise from the
// bare addresses; unnamed is how you find everyone else.
const IDENTITY_FIELD: FilterField = {
  kind: 'select',
  key: 'identity',
  options: [
    { value: '', label: 'Any account' },
    { value: 'named', label: 'Named accounts' },
    { value: 'unnamed', label: 'Unnamed accounts' },
  ],
}

export function activityFilterFields(type: string, assets: AssetFilterItem[], includeToken = true): FilterField[] {
  const actions = ACTIVITY_ACTIONS[type]
  return [
    ...(actions ? [{
      kind: 'select' as const,
      key: 'action',
      options: [{ value: '', label: 'All actions' }, ...actions.map(action => ({ value: action.v, label: action.label }))],
    }] : []),
    ...(includeToken ? [{ kind: 'combo' as const, key: 'token', placeholder: 'All tokens', width: 150, options: tokenFilterOptions(assets) }] : []),
    IDENTITY_FIELD,
    ...DATE_FIELDS,
    { kind: 'number', key: 'min', placeholder: '$ from' },
    // What the PROTOCOL earned on the row's extrinsic, which is a different question
    // from the row's own value: a $13.7k liquidation earned $458 while a $13.7k
    // stablecoin swap earns cents. Always USD — there is no token denomination to
    // pick — so it deliberately ignores the unit toggle.
    { kind: 'number', key: 'minRevenue', placeholder: '$ revenue from' },
  ]
}

// The call/event name fields are combos over the indexed name catalogue
// (/explorer/filter-names) rather than blind text boxes — the names are neither
// guessable nor memorable, and the list is what makes them discoverable. They stay
// free-text: the filter matches partially and case-insensitively (so "omnipool"
// filters a whole pallet), and a name too new for the catalogue's window must
// still be typeable. With no catalogue yet the field is simply a text box with a
// dropdown that has nothing in it.
export function nameFilterOptions(names: readonly string[]): ComboOption[] {
  return names.map(name => ({ value: name, label: name }))
}

/* ── the same catalogue, split for a two-field form ───────────────────────
 *
 * An alert matcher stores the pallet and the call/event name as two parameters,
 * so its form asks for them separately: the pallets present in the data, then
 * the names inside the chosen one. Both are derived from the SAME
 * `pallet.Name` catalogue the filter boxes use — one list, one source of truth,
 * and a name offered here is one the evaluator's matcher can match.
 */

const splitName = (full: string): [string, string] => {
  const dot = full.indexOf('.')
  return dot < 0 ? [full, ''] : [full.slice(0, dot), full.slice(dot + 1)]
}

// `noun` names what the count counts, so a row reads "Omnipool — 12 calls"
// rather than an unlabelled number.
export function palletOptions(names: readonly string[], noun = 'name'): ComboOption[] {
  const counts = new Map<string, number>()
  for (const full of names) {
    const [pallet] = splitName(full)
    if (pallet) counts.set(pallet, (counts.get(pallet) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pallet, count]) => ({ value: pallet, label: pallet, sub: `${count} ${noun}${count === 1 ? '' : 's'}` }))
}

// The names inside one pallet. Matched case-insensitively, because a pallet typed
// by hand ("omnipool") names the same pallet the catalogue spells "Omnipool" —
// exactly as the server matches it.
export function nameOptionsInPallet(names: readonly string[], pallet: string): ComboOption[] {
  const want = pallet.trim().toLowerCase()
  if (!want) return []
  const inside = new Set<string>()
  for (const full of names) {
    const [p, name] = splitName(full)
    if (name && p.toLowerCase() === want) inside.add(name)
  }
  return [...inside].sort((a, b) => a.localeCompare(b)).map(name => ({ value: name, label: name }))
}

export function extrinsicFilterFields(includeOrigin = false, calls: readonly string[] = []): FilterField[] {
  return [
    { kind: 'combo', key: 'call', placeholder: 'Call name', width: 210, freeText: true, options: nameFilterOptions(calls) },
    ...(includeOrigin ? [{
      kind: 'select' as const,
      key: 'origin',
      options: [
        { value: '', label: 'All origins' },
        { value: 'signed', label: 'Signed' },
        { value: 'proxy', label: 'Via proxy' },
        { value: 'multisig', label: 'Multisig' },
      ],
    }] : []),
    {
      kind: 'select',
      key: 'result',
      options: [
        { value: '', label: 'All results' },
        { value: 'success', label: 'Success' },
        { value: 'failed', label: 'Failed' },
      ],
    },
    ...DATE_FIELDS,
  ]
}

export function eventFilterFields(events: readonly string[] = []): FilterField[] {
  return [
    { kind: 'combo', key: 'event', placeholder: 'Event name', width: 230, freeText: true, options: nameFilterOptions(events) },
    ...DATE_FIELDS,
  ]
}
