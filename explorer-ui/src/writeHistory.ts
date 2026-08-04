import type { AbiFunctionItem } from './abiShape'

// Recently used argument values for contract writes, remembered per function
// signature and per field. Keyed by the signature rather than the contract on
// purpose: the same call on a second deployment (a redeployed proxy, another
// aToken) wants the same addresses and amounts offered, and a signature is what
// makes two functions the same call.
//
// localStorage rather than sessionStorage — the value of the list is that it
// survives the tab. It holds nothing but what the user typed into a public
// contract form, and never a wallet address the app chose for them.

const STORAGE_KEY = 'contract-write-inputs:v2'
// v1 keyed on types alone; its entries can never match a v2 key, so they are
// dropped rather than left to sit in the browser forever.
const LEGACY_STORAGE_KEYS = ['contract-write-inputs:v1']
const PER_FIELD_LIMIT = 8

// Function name, then each parameter as `type name` — deliberately NOT the
// runtime's canonical signature, which has no parameter names. Including them
// means `transfer(address to,uint256 amount)` and `transfer(address spender,
// uint256 value)` keep separate histories even though the same bytes would call
// either: identical types with different names are usually a different intent.
// The cost is the reverse case — two deployments that named the same parameter
// differently no longer share values.
export function historyKey(fn: AbiFunctionItem): string {
  const params = fn.inputs.map(input => (input.name ? `${input.type} ${input.name}` : input.type))
  return `${fn.name}(${params.join(',')})`
}

// Field identity within a signature: the argument's position, or the payable
// value box. Positional because names are optional in an ABI and can differ
// between two otherwise identical signatures.
export function fieldKey(index: number | 'value'): string {
  return String(index)
}

type Store = Record<string, Record<string, string[]>>

function read(): Store {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // Only keep the shape we wrote; a hand-edited or half-migrated entry is
    // dropped rather than trusted into the UI.
    const store: Store = {}
    for (const [signature, fields] of Object.entries(parsed as Record<string, unknown>)) {
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue
      const clean: Record<string, string[]> = {}
      for (const [field, values] of Object.entries(fields as Record<string, unknown>)) {
        if (!Array.isArray(values)) continue
        const strings = values.filter((v): v is string => typeof v === 'string' && v !== '')
        if (strings.length) clean[field] = strings.slice(0, PER_FIELD_LIMIT)
      }
      if (Object.keys(clean).length) store[signature] = clean
    }
    return store
  } catch {
    return {}   // private mode, quota, or corrupt JSON — history is never load-bearing
  }
}

function write(store: Store): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
    for (const key of LEGACY_STORAGE_KEYS) window.localStorage.removeItem(key)
  } catch {
    // A full or unavailable store must not fail the write the user asked for.
  }
}

export function fieldHistory(signature: string, field: string): string[] {
  return read()[signature]?.[field] ?? []
}

// Record what was typed, most recent first. Called when Write is pressed and not
// when the transaction lands: a write the user abandoned in the wallet still
// tells us the value was worth typing, and is the one they are most likely to
// come back to.
export function recordFieldValues(signature: string, values: Record<string, string>): void {
  const store = read()
  const fields = { ...store[signature] }
  for (const [field, raw] of Object.entries(values)) {
    const value = raw.trim()
    if (!value) continue
    fields[field] = [value, ...(fields[field] ?? []).filter(v => v !== value)].slice(0, PER_FIELD_LIMIT)
  }
  if (!Object.keys(fields).length) return
  write({ ...store, [signature]: fields })
}

export function removeFieldValue(signature: string, field: string, value: string): void {
  const store = read()
  const existing = store[signature]?.[field]
  if (!existing) return
  const remaining = existing.filter(v => v !== value)
  const fields = { ...store[signature] }
  if (remaining.length) fields[field] = remaining
  else delete fields[field]
  const next = { ...store }
  if (Object.keys(fields).length) next[signature] = fields
  else delete next[signature]
  write(next)
}

// What to offer for a field: everything remembered, narrowed by what has been
// typed so far. An exact match is dropped — offering the value already in the
// box is noise.
export function suggestionsFor(history: string[], typed: string): string[] {
  const query = typed.trim().toLowerCase()
  if (!query) return history
  return history.filter(value => value.toLowerCase() !== query && value.toLowerCase().includes(query))
}
