import type { Metadata } from '@subsquid/substrate-runtime/lib/metadata'
import type { RuntimeErrorNameRow } from '../db/schema.js'

// Enumerate every pallet Error variant from V14+ runtime metadata as flat rows.
// The Module DispatchError carries (pallet index, error byte); this maps those
// numbers to their pallet + variant names and doc string. Pre-V14 metadata (not
// present in Hydration's indexed range) has no portable type registry — skipped.
export function extractRuntimeErrorNames(metadata: Metadata, specVersion: number): RuntimeErrorNameRow[] {
  if (metadata.__kind !== 'V14') return []
  const md = metadata.value
  const typeById = new Map(md.lookup.types.map(t => [t.id, t.type]))
  const rows: RuntimeErrorNameRow[] = []
  for (const pallet of md.pallets) {
    if (!pallet.errors) continue
    const enumType = typeById.get(pallet.errors.type)
    if (!enumType || enumType.def.__kind !== 'Variant') continue
    for (const variant of enumType.def.value.variants) {
      rows.push({
        spec_version: specVersion,
        pallet_index: pallet.index,
        error_index: variant.index,
        pallet_name: pallet.name,
        error_name: variant.name,
        docs: variant.docs.join(' ').trim(),
      })
    }
  }
  return rows
}
