import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../api/explorer'
import { useContractAbi, useContractSources, useCompilerVersions } from '../hooks/useExplorerData'
import { Link, paths, setQuery, useQueryValue } from '../router'
import { Copy, CopyTextButton, F, JsonView, noAutofill } from './ui'
import { Combo } from './Filters'
import { readFunctions, functionSignature, type AbiFunctionItem, type AbiParam } from '../abiShape'
import { validateStandardJson, validateContractIdentifier } from '../verifyForm'
import { ethCall, ethGetCode, EvmRpcError } from '../evmRpc'
import { ContractWriteView } from './ContractWriteTab'
import { ContractTransactionsView, ContractEventsView } from './ContractActivityTab'
import { SourceBrowser } from './SourceBrowser'
import { ProxyNoteCard, useProxyContract } from './ProxyNote'
import type { ContractInfo } from '../types'

// The account page's Contract tab (?view=contract): a Code sub-tab (verified
// source, ABI, bytecode, verify panel), a Read sub-tab (browser-side eth_call
// over the verified ABI) and a Write sub-tab (ContractWriteTab.tsx — its own
// wallet connection, never the login session). Deep-linkable via
// ?contract=code|read|write like every other tab here. The ABI codec (viem)
// loads as its own lazy chunk only when a query actually runs — see abiCodec.ts.

const neutralBadge = { color: 'var(--neutral)', background: 'color-mix(in srgb, var(--neutral) 14%, transparent)' } as const

export function ContractTab({ address, contract }: { address: string; contract: ContractInfo }) {
  const raw = useQueryValue('contract', 'code')
  const active = raw === 'read' || raw === 'write' || raw === 'txs' || raw === 'events' ? raw : 'code'
  // Every switch clears the activity views' own pager param, so a page deep in
  // Transactions never leaks into Events (or lingers on Code).
  const go = (key: string | null) => setQuery({ contract: key, cpage: null })
  return (
    <>
      <div className="tabs" style={{ marginTop: 16 }}>
        <button type="button" className={active === 'code' ? 'active' : ''} onClick={() => go(null)}>Code</button>
        <button type="button" className={active === 'read' ? 'active' : ''} onClick={() => go('read')}>Read</button>
        <button type="button" className={active === 'write' ? 'active' : ''} onClick={() => go('write')}>Write</button>
        <button type="button" className={active === 'txs' ? 'active' : ''} onClick={() => go('txs')}>Transactions</button>
        <button type="button" className={active === 'events' ? 'active' : ''} onClick={() => go('events')}>Events</button>
      </div>
      {active === 'code' && <ContractCodeView address={address} contract={contract} />}
      {active === 'read' && <ContractReadView address={address} contract={contract} />}
      {active === 'write' && <ContractWriteView address={address} contract={contract} />}
      {active === 'txs' && <ContractTransactionsView address={address} />}
      {active === 'events' && <ContractEventsView address={address} />}
    </>
  )
}

/* ============ Code sub-tab ============ */

export function ContractCodeView({ address, contract }: { address: string; contract: ContractInfo }) {
  const verified = contract.verification?.status === 'verified'
  const { proxy, implUnverified } = useProxyContract(address)
  const proxyCard = proxy ? <ProxyNoteCard proxy={proxy} implUnverified={implUnverified} /> : null
  // A detected proxy names its implementation first — the linked contract is
  // where the real source lives. Then, verified: what it is, its source, its
  // interface and finally the raw code. Unverified: the code first — it is all
  // there is — then how to verify.
  if (verified) {
    return (
      <>
        {proxyCard}
        <VerifiedCode address={address} contract={contract} />
        <BytecodeCard address={address} />
      </>
    )
  }
  return (
    <>
      {proxyCard}
      <BytecodeCard address={address} />
      <VerifyPanel address={address} />
    </>
  )
}

const MATCH_EXPLANATION: Record<string, string> = {
  exact_match: 'exact match — bytecode and metadata hash both matched',
  match: 'match — bytecode matched; the metadata hash differs (common with Foundry\'s bytecode_hash = "none")',
}

function sourceLabel(source?: string): string | null {
  if (source === 'import:blockscout') return 'imported from Blockscout'
  if (source === 'manual') return 'imported manually'
  return null
}

function VerifiedCode({ address, contract }: { address: string; contract: ContractInfo }) {
  const v = contract.verification!
  const sources = useContractSources(address)
  const abi = useContractAbi(address, v.abiPresent !== false)
  const files = sources.data?.files ?? []
  const compiler = sources.data?.compiler
  return (
    <>
      <div className="id-card">
        <div className="id-card-head">Verification</div>
        <div className="dl">
          {v.name && (<><div className="dt">Contract</div><div className="dd"><span className="mono">{v.name}</span></div></>)}
          <div className="dt">Match</div>
          <div className="dd proxy-dd">
            <span className="badge ok">✓ Verified</span>
            <span className="muted" style={{ fontSize: 12 }}>{MATCH_EXPLANATION[v.matchType ?? ''] ?? 'verified'}</span>
          </div>
          {v.supersededBytecode && (<>
            <div className="dt">Bytecode</div>
            <div className="dd"><span className="badge" style={neutralBadge} title="The code at this address changed after verification (CREATE2 redeploy) — the verified source describes the previous bytecode">superseded — code changed after verification</span></div>
          </>)}
          {sourceLabel(v.source) && (<><div className="dt">Source</div><div className="dd"><span className="muted">{sourceLabel(v.source)}</span></div></>)}
          {v.compilerVersion && (<><div className="dt">Compiler</div><div className="dd"><span className="mono">{v.compilerVersion}</span></div></>)}
          {compiler?.evmVersion && (<><div className="dt">EVM version</div><div className="dd"><span className="mono">{compiler.evmVersion}</span></div></>)}
          {compiler && (<>
            <div className="dt">Optimizer</div>
            <div className="dd"><span className="mono">{compiler.optimizerEnabled ? `enabled · ${F.int(compiler.optimizerRuns)} runs` : 'disabled'}</span></div>
          </>)}
          {compiler?.constructorArguments && compiler.constructorArguments !== '0x' && (<>
            <div className="dt">Constructor args</div>
            <div className="dd proxy-dd"><span className="mono wrap-anywhere" style={{ fontSize: 11 }}>{compiler.constructorArguments}</span> <Copy text={compiler.constructorArguments} /></div>
          </>)}
        </div>
      </div>

      {files.length > 0 && <SourceBrowser files={files} contractName={v.name} />}

      {abi.data && (
        <div className="id-card">
          <div className="id-card-head">ABI</div>
          <details className="abi-details">
            <summary>Show ABI ({Array.isArray(abi.data.abi) ? abi.data.abi.length : 0} entries)</summary>
            <JsonView value={abi.data.abi} />
          </details>
          <div className="id-card-foot"><CopyTextButton label="ABI" text={JSON.stringify(abi.data.abi)} /></div>
        </div>
      )}
    </>
  )
}

// Deployed bytecode, fetched in the browser via eth_getCode (render-on-fetch —
// no API storage or transit; the RPC is the same one the app uses for reads).
function BytecodeCard({ address }: { address: string }) {
  const { data, isError } = useQuery({
    queryKey: ['contract-bytecode', address],
    queryFn: () => ethGetCode(address),
    staleTime: 3_600_000,
    retry: false,
  })
  if (isError) return null
  if (!data) return null
  const truncated = data.length > 600 ? `${data.slice(0, 600)}…` : data
  return (
    <div className="id-card">
      <div className="id-card-head">Bytecode · {F.int(Math.max(0, (data.length - 2) / 2))} bytes</div>
      <pre className="json src-viewer" style={{ maxHeight: 160 }}>{truncated}</pre>
      <div className="id-card-foot"><CopyTextButton label="bytecode" text={data} /></div>
    </div>
  )
}

/* ============ verify panel ============ */

function VerifyPanel({ address }: { address: string }) {
  const queryClient = useQueryClient()
  const origin = typeof window === 'undefined' ? 'https://explorer.example' : window.location.origin
  const verifierUrl = `${origin}/api/`
  const forgeCmd = `forge verify-contract ${address} src/MyToken.sol:MyToken --verifier sourcify --verifier-url ${verifierUrl}`
  const hardhatCmd = `npx hardhat verify ${address}`
  const hardhatConfig = `sourcify: { enabled: true, apiUrl: "${origin}/api" }`

  const versions = useCompilerVersions()
  const versionOptions = (versions.data?.versions ?? []).map(v => ({ value: v, label: v }))

  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [stdJson, setStdJson] = useState<{ language: string; sources: Record<string, unknown> } | null>(null)
  const [identifier, setIdentifier] = useState('')
  const [version, setVersion] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const job = useQuery({
    queryKey: ['verify-job', jobId],
    queryFn: ({ signal }) => api.verifyPoll(jobId!, signal),
    enabled: !!jobId,
    refetchInterval: q => (q.state.data?.isJobCompleted ? false : 2500),
  })
  const completed = job.data?.isJobCompleted ? job.data : null
  const succeeded = !!completed?.contract.match

  // A fresh verification changes the address payload, the artifacts and the
  // directory row — drop them all so the page re-renders verified in place.
  useEffect(() => {
    if (!succeeded) return
    void queryClient.invalidateQueries({ queryKey: ['address'] })
    void queryClient.invalidateQueries({ queryKey: ['contract-abi', address] })
    void queryClient.invalidateQueries({ queryKey: ['contract-sources', address] })
    void queryClient.invalidateQueries({ queryKey: ['contracts'] })
  }, [succeeded, queryClient, address])

  async function onFile(file: File | undefined) {
    if (!file) return
    setError(null)
    setFileName(null)
    setStdJson(null)
    const text = await file.text().catch(() => null)
    const checked = text == null ? { ok: false as const, error: 'Could not read the file' } : validateStandardJson(text)
    if (!checked.ok) {
      setError(checked.error)
      return
    }
    setFileName(file.name)
    setStdJson(checked.value)
  }

  async function submit() {
    setError(null)
    if (!stdJson) return setError('Select the compiler standard-JSON input first')
    const identifierError = validateContractIdentifier(identifier)
    if (identifierError) return setError(identifierError)
    if (!version.trim()) return setError('Pick the compiler version the contract was built with')
    try {
      const { verificationId } = await api.verifySubmit(address, {
        stdJsonInput: stdJson,
        compilerVersion: version.trim(),
        contractIdentifier: identifier.trim(),
      })
      setJobId(verificationId)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Submission failed')
    }
  }

  return (
    <>
      <div className="id-card">
        <div className="id-card-head">Verify this contract</div>
        <div className="dl">
          <div className="dt">Foundry</div>
          <div className="dd dd-stack">
            <pre className="json cli-block">{forgeCmd}</pre>
            <div className="ext-link-row"><CopyTextButton label="forge command" text={forgeCmd} /></div>
          </div>
          <div className="dt">Hardhat</div>
          <div className="dd dd-stack">
            <pre className="json cli-block">{`// hardhat.config: ${hardhatConfig}\n${hardhatCmd}`}</pre>
            <div className="ext-link-row"><CopyTextButton label="hardhat command" text={hardhatCmd} /></div>
          </div>
        </div>
      </div>

      <div className="id-card">
        <div className="id-card-head">Or verify in the browser</div>
        {succeeded ? (
          <div className="id-card-body">
            <span className="badge ok">✓ Verified{completed?.contract.match === 'exact_match' ? ' (exact match)' : ' (match)'}</span>
          </div>
        ) : (
          <>
            <div className="id-card-body stack">
              <div className="field">
                <label>Compiler standard-JSON input</label>
                <div
                  className={`upload-zone${dragOver ? ' drag' : ''}`}
                  onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={e => { e.preventDefault(); setDragOver(false); void onFile(e.dataTransfer.files?.[0]) }}
                >
                  <input {...noAutofill} ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={e => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
                  <button type="button" className="btn sm" onClick={() => fileRef.current?.click()}>Choose file</button>
                  <span className="muted" style={{ fontSize: 12 }}>{fileName ?? 'or drop the standard JSON here (forge build-info input / hardhat build-info)'}</span>
                </div>
              </div>
              <div className="field">
                <label>Contract</label>
                <input {...noAutofill} className="input" placeholder="src/MyToken.sol:MyToken" value={identifier} onChange={e => setIdentifier(e.target.value)} />
              </div>
              <div className="field">
                <label>Compiler version</label>
                {versionOptions.length
                  ? <Combo value={version} placeholder="v0.8.19+commit.7dd6d404" label="Compiler version" width={260} options={versionOptions} onChange={setVersion} />
                  : <input {...noAutofill} className="input" placeholder="v0.8.19+commit.7dd6d404" value={version} onChange={e => setVersion(e.target.value)} />}
              </div>
              {error && <div className="dialog-error">{error}</div>}
              {completed?.error && <div className="dialog-error">{completed.error.message}</div>}
            </div>
            <div className="id-card-foot">
              {jobId && !completed
                ? <span className="muted">Verifying — compiling and comparing bytecode…</span>
                : <button type="button" className="btn primary" onClick={() => { void submit() }}>Verify</button>}
            </div>
          </>
        )}
      </div>
    </>
  )
}

/* ============ Read sub-tab ============ */

export function ContractReadView({ address, contract }: { address: string; contract: ContractInfo }) {
  const verified = contract.verification?.status === 'verified' && contract.verification.abiPresent !== false
  const abi = useContractAbi(address, verified)
  const { proxy, implAbi, implUnverified, resolving } = useProxyContract(address)
  if (resolving || (verified && !abi.data)) return <div className="id-card"><div className="id-card-note">Loading ABI…</div></div>
  if (!verified && !proxy) {
    return (
      <div className="id-card">
        <div className="id-card-head">Read</div>
        <div className="id-card-note">
          Reading needs a verified ABI — <button type="button" className="hint-link" onClick={() => setQuery({ contract: null })}>verify this contract</button> first.
        </div>
      </div>
    )
  }
  // A proxy's own ABI is a constructor and a fallback — the functions live in
  // the implementation, called here on the proxy address (that is what the
  // fallback does). Implementation first; the proxy's own functions, when its
  // ABI declares any, follow.
  const fns = [...readFunctions(implAbi?.abi), ...readFunctions(abi.data?.abi)]
  return (
    <>
      {proxy && <ProxyNoteCard proxy={proxy} implUnverified={implUnverified} />}
      {!fns.length && !implUnverified && <div className="id-card"><div className="id-card-note">The verified ABI has no view or pure functions.</div></div>}
      {fns.map((fn, i) => <ReadFnRow key={`${fn.name}-${i}`} index={i + 1} fn={fn} address={address} />)}
    </>
  )
}

type ReadResult = { outputs: { param: AbiParam; value: unknown }[] }

function ReadFnRow({ index, fn, address }: { index: number; fn: AbiFunctionItem; address: string }) {
  const [expanded, setExpanded] = useState(false)
  const [raws, setRaws] = useState<string[]>(() => fn.inputs.map(() => ''))
  const [result, setResult] = useState<ReadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function runQuery() {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const codec = await import('../abiCodec')
      const args = codec.parseArgs(fn, raws)
      const out = await ethCall(address, codec.encodeCall(fn, args))
      const decoded = codec.decodeResult(fn, out as `0x${string}`)
      const values = fn.outputs.length > 1 && Array.isArray(decoded) ? decoded : [decoded]
      setResult({ outputs: fn.outputs.map((param, i) => ({ param, value: values[i] })) })
    } catch (err) {
      if (err instanceof EvmRpcError && err.data) {
        const codec = await import('../abiCodec')
        const message = codec.decodeRevert(err.data)
        setError(message ? `Reverted: ${message}` : `Reverted with data ${err.data}`)
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusy(false)
    }
  }

  // Parameterless view functions answer instantly and cost nothing — query on
  // first expand rather than making the reader click twice.
  function toggle() {
    const next = !expanded
    setExpanded(next)
    if (next && !fn.inputs.length && !result && !error && !busy) void runQuery()
  }

  return (
    <div className="id-card fn-row">
      <button type="button" className="fn-head" onClick={toggle} aria-expanded={expanded}>
        <span className="mono muted">{index}.</span>
        <span className="mono fn-sig">{functionSignature(fn)}</span>
        <span className="pill-badge" style={neutralBadge}>{fn.stateMutability}</span>
        <span className="muted fn-caret">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="fn-body">
          {fn.inputs.map((input, i) => (
            <div className="field" key={`${input.name}-${i}`}>
              <label>{input.name || `arg ${i}`} <span className="muted">({input.type})</span></label>
              <input {...noAutofill}
                className="input"
                placeholder={input.type}
                value={raws[i] ?? ''}
                onChange={e => setRaws(prev => prev.map((v, j) => (j === i ? e.target.value : v)))}
              />
            </div>
          ))}
          {fn.inputs.length > 0 && (
            <div>
              <button type="button" className="btn primary sm" disabled={busy} onClick={() => { void runQuery() }}>{busy ? 'Querying…' : 'Query'}</button>
            </div>
          )}
          {busy && !fn.inputs.length && <div className="fn-hint">Querying…</div>}
          {error && <div className="dialog-error">{error}</div>}
          {result && (
            <div className="kv-params">
              {result.outputs.map((out, i) => (
                <div className="kv-row" key={i}>
                  <div className="kk">{out.param.name || `output ${i}`}<span className="ty">{out.param.type}</span></div>
                  <div className="vv"><ResultValue param={out.param} value={out.value} /></div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Typed result rendering: integers are a precision surface (exact string math,
// with a compact hint), addresses link to their account page, structures
// render recursively rather than as a JSON blob.
function ResultValue({ param, value }: { param: AbiParam; value: unknown }): React.ReactNode {
  if (typeof value === 'bigint') {
    const exact = F.preciseAmount(value.toString(), 0)
    const hint = value >= 1000n || value <= -1000n ? F.amount(value.toString(), 0) : null
    return <span className="mono">{exact}{hint && <span className="muted" style={{ marginLeft: 6 }}>≈ {hint}</span>}</span>
  }
  if (typeof value === 'boolean') return <span className="mono">{String(value)}</span>
  if (typeof value === 'string' && param.type === 'address') {
    return <span className="mono"><Link className="hash" to={paths.account(value.toLowerCase())}>{value.toLowerCase()}</Link> <Copy text={value.toLowerCase()} /></span>
  }
  if (typeof value === 'string' && param.type.startsWith('bytes')) {
    return <span className="mono wrap-anywhere">{value} <Copy text={value} /></span>
  }
  if (Array.isArray(value)) {
    const elemType = param.type.endsWith(']') ? param.type.replace(/\[\d*\]$/, '') : 'tuple'
    const components = param.type === 'tuple' || param.type.startsWith('tuple') ? param.components : undefined
    return (
      <div className="fn-nested">
        {value.map((v, i) => (
          <div key={i} className="fn-nested-row">
            <span className="muted mono" style={{ fontSize: 11 }}>{components?.[i]?.name || i}</span>{' '}
            <ResultValue param={components?.[i] ?? { type: elemType, components: param.components }} value={v} />
          </div>
        ))}
      </div>
    )
  }
  if (value && typeof value === 'object') {
    const components = param.components ?? []
    return (
      <div className="fn-nested">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <div key={k} className="fn-nested-row">
            <span className="muted mono" style={{ fontSize: 11 }}>{k}</span>{' '}
            <ResultValue param={components.find(c => c.name === k) ?? { type: 'string' }} value={v} />
          </div>
        ))}
      </div>
    )
  }
  return <span className="mono wrap-anywhere">{String(value)}</span>
}
