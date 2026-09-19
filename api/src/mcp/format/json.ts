/**
 * The text budget, applied to a STRUCTURED record.
 *
 * `format: "json"` is answered by serializing a tool's record into the one text
 * block the MCP reply carries, and that block is capped. A document cut at the
 * cap parses as NOTHING — the caller asked for JSON and receives a string that
 * `JSON.parse` rejects, which is worse than a short answer because the failure
 * looks like a server fault rather than a size limit.
 *
 * So the shrinking happens here, before serialization, and it removes WHOLE
 * RECORDS: the longest arrays lose their tails first, then whole top-level
 * sections, and every loss is named in a `truncatedForTextBudget` field inside
 * the document itself. A caller can therefore detect the trimming by reading a
 * field rather than by noticing that a table looks short.
 */

/** The single field a caller reads to learn the answer was shortened. */
export const JSON_TRUNCATION_KEY = 'truncatedForTextBudget'

export interface JsonTruncation {
  truncated: true
  /** How much of the untrimmed document did not fit, in characters. */
  originalChars: number
  budgetChars: number
  /** Arrays whose tail was dropped, by dotted path. */
  droppedRecords: { path: string; kept: number; dropped: number }[]
  /** Top-level sections removed whole, once trimming arrays was not enough. */
  droppedSections: string[]
  advice: string
}

const serialize = (value: unknown): string => JSON.stringify(value, null, 2) ?? 'null'

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Every array in the document, deepest value first is irrelevant — size is. */
function arrays(root: unknown): { path: string; array: unknown[] }[] {
  const found: { path: string; array: unknown[] }[] = []
  const seen = new Set<unknown>()
  const walk = (node: unknown, path: string): void => {
    if (node == null || typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      if (node.length > 0) found.push({ path: path || '$', array: node })
      for (let i = 0; i < node.length; i += 1) walk(node[i], `${path}[${i}]`)
      return
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      walk(value, path ? `${path}.${key}` : key)
    }
  }
  walk(root, '')
  return found
}

function wrap(value: unknown, truncation: JsonTruncation | null): unknown {
  if (!truncation) return value
  if (isPlainObject(value)) return { ...value, [JSON_TRUNCATION_KEY]: truncation }
  return { value, [JSON_TRUNCATION_KEY]: truncation }
}

/**
 * The record a tool will hand back for `format: "json"`, shortened until its
 * serialization fits `maxChars`.
 *
 * The input is never mutated: upstream bodies live in the response cache and are
 * shared between calls, so the trimming works on a copy. A document that already
 * fits is returned untouched, which is the normal case.
 */
export function fitJson(value: unknown, maxChars: number): unknown {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return value
  const originalChars = serialize(value).length
  if (originalChars <= maxChars) return value

  // A structural copy, so trimming cannot reach the shared upstream cache. This
  // also drops `undefined` members exactly as the final serialization would.
  let clone: unknown
  try {
    clone = JSON.parse(JSON.stringify(value ?? null))
  } catch {
    // A circular or non-serializable record cannot be trimmed; say so rather
    // than handing back something that will not parse either.
    return {
      [JSON_TRUNCATION_KEY]: {
        truncated: true,
        originalChars,
        budgetChars: maxChars,
        droppedRecords: [],
        droppedSections: [],
        advice: 'This record could not be serialized, so nothing structured is returned. Ask for `format: "markdown"`.',
      } satisfies JsonTruncation,
    }
  }

  const droppedByPath = new Map<string, { kept: number; dropped: number }>()
  const droppedSections: string[] = []
  const truncation = (): JsonTruncation => ({
    truncated: true,
    originalChars,
    budgetChars: maxChars,
    droppedRecords: [...droppedByPath.entries()].map(([path, v]) => ({ path, ...v })),
    droppedSections,
    advice: 'Whole records were dropped to keep this reply inside the server\'s text budget. Ask for a smaller `limit`, fewer `include` sections, or a narrower window; `format: "markdown"` renders more rows in the same space.',
  })
  const fits = (): boolean => serialize(wrap(clone, truncation())).length <= maxChars

  // Longest array first: one pass over a 200 KB document is cheap next to the
  // serialization it is about to save, and cutting the biggest list first gets
  // under the budget in the fewest cuts.
  for (let guard = 0; guard < 64 && !fits(); guard += 1) {
    const candidates = arrays(clone).map(a => ({ ...a, size: serialize(a.array).length }))
    if (!candidates.length) break
    const biggest = candidates.reduce((a, b) => (b.size > a.size ? b : a))
    const full = serialize(wrap(clone, truncation())).length
    // How much this array costs IN CONTEXT, measured rather than estimated: a
    // nested array serializes wider inside the document than on its own (every
    // line carries the enclosing indentation), and estimating from the standalone
    // size overshoots enough to empty a list that only needed shortening.
    const removed = biggest.array.splice(0, biggest.array.length)
    const withoutIt = serialize(wrap(clone, truncation())).length
    biggest.array.push(...removed)
    const perElement = Math.max(1, (full - withoutIt) / removed.length)
    const dropCount = Math.max(1, Math.min(biggest.array.length, Math.ceil((full - maxChars) / perElement)))
    const kept = biggest.array.length - dropCount
    biggest.array.length = kept
    const previous = droppedByPath.get(biggest.path)
    droppedByPath.set(biggest.path, { kept, dropped: (previous?.dropped ?? 0) + dropCount })
  }

  // Arrays alone were not enough (a few very long strings, or a deep object with
  // no lists). Drop whole top-level sections, largest first, naming each.
  if (!fits() && isPlainObject(clone)) {
    const record = clone as Record<string, unknown>
    for (let guard = 0; guard < 64 && !fits(); guard += 1) {
      const keys = Object.keys(record).filter(k => k !== JSON_TRUNCATION_KEY)
      if (!keys.length) break
      const biggest = keys
        .map(k => ({ k, size: serialize(record[k]).length }))
        .reduce((a, b) => (b.size > a.size ? b : a))
      delete record[biggest.k]
      droppedSections.push(biggest.k)
    }
  }

  if (!fits()) {
    // Nothing structured survives the budget. The marker alone is small, always
    // parses, and tells the caller exactly what happened.
    return { [JSON_TRUNCATION_KEY]: truncation() }
  }
  return wrap(clone, truncation())
}
