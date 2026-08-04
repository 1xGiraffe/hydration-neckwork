import { SUBSTRATE_RPC_URL } from './substrateRpc.ts'

// Client for Blockscout's `smart-contract-verifier` microservice, which does the
// actual compile-and-compare. We only ever use its standard-json route: it takes
// bytecode plus a solc standard-json input and is completely chain-agnostic, so
// it works for Hydration without knowing anything about chain 222222.
//
// Deliberately NOT used: the service's own sourcify route. That one is a thin
// HTTP client for sourcify.dev, and sourcify.dev does not know chain 222222, so
// it answers `400 unsupported_chain`. There is no local metadata-based
// verification anywhere in blockscout-rs — compile-and-compare is the only path.
export const VERIFIER_URL = process.env.SMART_CONTRACT_VERIFIER_URL?.trim() || 'http://smart-contract-verifier:8050'

// Compiling a large project is slow, and the service holds the connection for
// the whole compile. Generous, but bounded: forge gives up polling after ~2min.
const VERIFY_TIMEOUT_MS = 100_000

export type MatchType = 'FULL' | 'PARTIAL'

export type VerifySuccess = {
  ok: true
  matchType: MatchType
  contractName: string
  fileName: string
  abi: string
  compilerVersion: string
  compilerSettings: string
  constructorArguments: string
  sourceFiles: Record<string, string>
}

export type VerifyFailure = {
  ok: false
  // Sourcify-flavoured code so the route layer can pass it straight through.
  code: 'no_match' | 'compiler_error' | 'bad_request' | 'verifier_unavailable'
  message: string
}

export type VerifyResult = VerifySuccess | VerifyFailure

// A verification failure is HTTP 200 with `status: "FAILURE"` — only transport
// and request-shape problems are 4xx. Branching on the HTTP code alone would
// report every bytecode mismatch as a success.
export async function verifyStandardJson(input: {
  bytecode: string
  compilerVersion: string
  stdJsonInput: unknown
}): Promise<VerifyResult> {
  const body = JSON.stringify({
    bytecode: input.bytecode,
    // We hold deployed (runtime) bytecode from eth_getCode. CREATION_INPUT would
    // additionally require the constructor args appended, which we do not have.
    bytecodeType: 'DEPLOYED_BYTECODE',
    // Forwarded verbatim: the service accepts the version with or without a
    // leading `v`, so forge's bare `0.8.10+commit.…` needs no normalisation.
    compilerVersion: input.compilerVersion,
    input: JSON.stringify(input.stdJsonInput),
  })

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), VERIFY_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${VERIFIER_URL}/api/v2/verifier/solidity/sources:verify-standard-json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body,
    })
  } catch (err) {
    // The service replies to an oversized body before consuming it, which
    // surfaces here as a broken pipe rather than a status code.
    const msg = err instanceof Error ? err.message : String(err)
    const broken = /EPIPE|ECONNRESET|socket hang up/i.test(msg)
    return {
      ok: false,
      code: broken ? 'bad_request' : 'verifier_unavailable',
      message: broken ? 'Submitted payload was rejected as too large by the verifier' : `Verifier unreachable: ${msg}`,
    }
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, code: 'verifier_unavailable', message: `Verifier returned non-JSON (HTTP ${res.status})` }
  }

  // Request-level problems use a different shape entirely: `{code, message}`
  // with no `status` field.
  const envelope = parsed as { status?: string; message?: string; source?: Record<string, unknown> | null; code?: number }
  if (!res.ok) {
    return { ok: false, code: 'bad_request', message: envelope.message || `Verifier rejected the request (HTTP ${res.status})` }
  }

  if (envelope.status !== 'SUCCESS' || !envelope.source) {
    const message = envelope.message || 'No contract could be verified with provided data'
    return {
      ok: false,
      code: /compilation error/i.test(message) ? 'compiler_error' : 'no_match',
      message,
    }
  }

  const src = envelope.source
  const matchType = src.matchType === 'FULL' ? 'FULL' : 'PARTIAL'
  return {
    ok: true,
    matchType,
    contractName: String(src.contractName ?? ''),
    fileName: String(src.fileName ?? ''),
    // `abi` and `compilerSettings` arrive already JSON-encoded as strings —
    // store them as-is.
    abi: typeof src.abi === 'string' ? src.abi : JSON.stringify(src.abi ?? []),
    compilerVersion: String(src.compilerVersion ?? ''),
    compilerSettings: typeof src.compilerSettings === 'string' ? src.compilerSettings : JSON.stringify(src.compilerSettings ?? {}),
    constructorArguments: typeof src.constructorArguments === 'string' ? src.constructorArguments : '',
    sourceFiles: isStringMap(src.sourceFiles) ? src.sourceFiles : {},
  }
}

function isStringMap(v: unknown): v is Record<string, string> {
  return !!v && typeof v === 'object' && Object.values(v).every(x => typeof x === 'string')
}

// Deployed bytecode for an address, fetched once on the submit (write) path and
// then cached in `contract_verifications` — the read paths must never call this.
// Returns null when the address has no code, and '0x00' is treated as no code:
// Hydration's per-asset ERC-20 precompiles return exactly that one byte, so a
// bare `code !== '0x'` test would classify nearly every asset as a contract.
export async function fetchDeployedBytecode(address: string): Promise<string | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8_000)
  try {
    const res = await fetch(SUBSTRATE_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { result?: unknown }
    const code = typeof json.result === 'string' ? json.result : null
    if (!code || !/^0x[0-9a-f]*$/i.test(code)) return null
    return isEmptyCode(code) ? null : code
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function isEmptyCode(code: string): boolean {
  const body = code.slice(2)
  return body.length === 0 || /^0+$/.test(body)
}

// Release compiler versions the verifier can fetch, newest first, for the
// browser verify-form's version picker. Nightlies are dropped: they cannot
// have produced a deployed mainnet contract anyone needs to verify here, and
// they triple the list. Empty on failure — the form falls back to free text.
export async function listCompilerVersions(): Promise<string[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8_000)
  try {
    const res = await fetch(`${VERIFIER_URL}/api/v2/verifier/solidity/versions`, { signal: ctrl.signal })
    if (!res.ok) return []
    const json = (await res.json()) as { compilerVersions?: unknown }
    if (!Array.isArray(json.compilerVersions)) return []
    return json.compilerVersions
      .filter((v): v is string => typeof v === 'string' && !v.includes('nightly'))
      .sort((a, b) => {
        const parse = (v: string) => v.replace(/^v/, '').split('+')[0].split('.').map(Number)
        const [a1, a2, a3] = parse(a), [b1, b2, b3] = parse(b)
        return b1 - a1 || b2 - a2 || b3 - a3
      })
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}
