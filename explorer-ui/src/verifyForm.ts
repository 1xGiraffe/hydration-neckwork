// Pure validation for the browser verify form (ContractTab's verify panel).
// Kept out of the component file so the checks stay unit-testable and the
// component module keeps fast-refresh.

// The standard-JSON the compiler consumed: {language, sources}. The returned
// shape carries the parsed value so the submit sends exactly what was validated.
export function validateStandardJson(text: string): { ok: true; value: { language: string; sources: Record<string, unknown> } } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'Not valid JSON — export the compiler standard-json input (forge: build_info, hardhat: artifacts/build-info)' }
  }
  const v = parsed as { language?: unknown; sources?: unknown }
  if (typeof v?.language !== 'string' || !v.language) return { ok: false, error: 'Standard JSON needs a "language" field (e.g. "Solidity")' }
  if (!v.sources || typeof v.sources !== 'object' || Array.isArray(v.sources) || !Object.keys(v.sources).length) {
    return { ok: false, error: 'Standard JSON needs a non-empty "sources" map' }
  }
  return { ok: true, value: v as { language: string; sources: Record<string, unknown> } }
}

export function validateContractIdentifier(identifier: string): string | null {
  const t = identifier.trim()
  if (!t || !t.includes(':') || t.startsWith(':') || t.endsWith(':')) {
    return 'Use the path:ContractName form, e.g. src/MyToken.sol:MyToken'
  }
  return null
}
