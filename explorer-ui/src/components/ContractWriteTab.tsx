import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/explorer'
import { useContractAbi } from '../hooks/useExplorerData'
import { Link, paths, setQuery } from '../router'
import { AddrPill, F, ShortAddr } from './ui'
import { writeFunctions, functionSignature, type AbiFunctionItem } from '../abiShape'
import { ethCallAt, ethEstimateGas, ethGasPrice, ethGetTransactionReceipt, EvmRpcError } from '../evmRpc'
import { parseWethValue, runEvmWrite } from '../contractWrite'
import type { WriteStage } from '../contractWrite'
import { restoreContractWallet, setContractWallet, useContractWallet } from '../contractWallet'
import type { ContractWalletConnection } from '../contractWallet'
import { ContractWalletDialog } from './ContractWalletDialog'
import type { ContractInfo } from '../types'

// The contract tab's Write sub-tab (?contract=write): nonpayable/payable
// functions with typed inputs, driven by a wallet connection of its own
// (contractWallet.ts — never the login session). Every write shows its cost
// before it can be sent: the estimate runs continuously against the connected
// account, and a reverting estimate disables Write with the decoded reason.

const neutralBadge = { color: 'var(--neutral)', background: 'color-mix(in srgb, var(--neutral) 14%, transparent)' } as const

export function ContractWriteView({ address, contract }: { address: string; contract: ContractInfo }) {
  const verified = contract.verification?.status === 'verified' && contract.verification.abiPresent !== false
  const abi = useContractAbi(address, verified)
  const wallet = useContractWallet()
  const [dialogOpen, setDialogOpen] = useState(false)
  // Reconnect a wallet remembered in this browser tab, silently (eth_accounts
  // only) — a no-op when nothing is remembered or something is connected.
  useEffect(() => { void restoreContractWallet() }, [])

  if (!verified) {
    return (
      <div className="id-card">
        <div className="id-card-head">Write</div>
        <div className="id-card-note">
          Writing needs a verified ABI — <button type="button" className="hint-link" onClick={() => setQuery({ contract: null })}>verify this contract</button> first.
        </div>
      </div>
    )
  }
  if (!abi.data) return <div className="id-card"><div className="id-card-note">Loading ABI…</div></div>
  const fns = writeFunctions(abi.data.abi)
  return (
    <>
      <WalletBar wallet={wallet} contract={contract} onConnect={() => setDialogOpen(true)} />
      {!fns.length && <div className="id-card"><div className="id-card-note">The verified ABI has no state-changing functions.</div></div>}
      {fns.map((fn, i) => <WriteFnRow key={`${fn.name}-${i}`} index={i + 1} fn={fn} address={address} wallet={wallet} />)}
      <ContractWalletDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  )
}

// The safety summary above the function list: who is writing to what. The
// connected account renders as a real pill when the ref resolves (identity,
// tag, emoji — same as anywhere else), degrading to the raw address.
function WalletBar({ wallet, contract, onConnect }: { wallet: ContractWalletConnection | null; contract: ContractInfo; onConnect: () => void }) {
  const refQuery = useQuery({
    queryKey: ['contract-wallet-ref', wallet?.address ?? null],
    queryFn: ({ signal }) => api.accountRefs([wallet!.address], signal),
    enabled: !!wallet,
    staleTime: 300_000,
    retry: false,
  })
  const ref = refQuery.data?.[0] ?? null
  return (
    <div className="id-card">
      {wallet ? (
        <div className="write-bar">
          <span className="write-as">
            You are writing to <AddrPill account={contract.account} /> as{' '}
            {ref
              ? <AddrPill account={ref} />
              : <span className="mono"><ShortAddr addr={wallet.address} /></span>}
          </span>
          <span className="muted" style={{ fontSize: 12 }}>via {wallet.walletName}</span>
          <button type="button" className="btn sm" onClick={() => setContractWallet(null)}>Disconnect</button>
        </div>
      ) : (
        <div className="write-bar">
          <span className="muted">Writing uses a wallet connection of its own — separate from the explorer login, only for this tab.</span>
          <button type="button" className="btn primary sm" onClick={onConnect}>Connect wallet</button>
        </div>
      )}
    </div>
  )
}

// What the continuous estimate knows about the write as currently typed.
type Estimate =
  | { kind: 'invalid'; error: string }
  | { kind: 'revert'; reason: string }
  | { kind: 'gas'; gas: bigint }

function WriteFnRow({ index, fn, address, wallet }: { index: number; fn: AbiFunctionItem; address: string; wallet: ContractWalletConnection | null }) {
  const [expanded, setExpanded] = useState(false)
  const [raws, setRaws] = useState<string[]>(() => fn.inputs.map(() => ''))
  const [valueRaw, setValueRaw] = useState('')
  // The estimate is stored with the inputs it was computed for, so a result
  // that lands after the form changed can never gate (or ungate) the wrong
  // write — anything but an exact key match renders as still estimating.
  const [estimated, setEstimated] = useState<{ key: string; value: Estimate } | null>(null)
  const [stage, setStage] = useState<WriteStage>({ phase: 'idle' })
  const payable = fn.stateMutability === 'payable'
  const busy = stage.phase === 'preparing' || stage.phase === 'wallet-pending' || stage.phase === 'submitted' || stage.phase === 'in-block'
  const argsComplete = fn.inputs.every((_, i) => (raws[i] ?? '').trim() !== '')
  const estimateKey = JSON.stringify([raws, valueRaw, wallet?.evmFrom ?? null])
  const estimate: Estimate | null = expanded && wallet && argsComplete && estimated?.key === estimateKey ? estimated.value : null

  // Estimate continuously (debounced) once the row is open, a wallet is
  // connected and every argument has a value — the §7.5 safety affordance:
  // cost visible before Write, Write disabled while the estimate reverts.
  useEffect(() => {
    if (!expanded || !wallet || !argsComplete) return
    let cancelled = false
    const timer = setTimeout(async () => {
      let value: Estimate
      try {
        const codec = await import('../abiCodec')
        const args = codec.parseArgs(fn, raws)
        const data = codec.encodeCall(fn, args)
        const valueWei = payable ? parseWethValue(valueRaw) : 0n
        const gas = await ethEstimateGas({ from: wallet.evmFrom, to: address, data, ...(valueWei > 0n ? { value: `0x${valueWei.toString(16)}` } : {}) })
        value = { kind: 'gas', gas }
      } catch (err) {
        if (err instanceof EvmRpcError) {
          const codec = await import('../abiCodec')
          const reason = err.data ? codec.decodeRevert(err.data) : null
          value = { kind: 'revert', reason: reason ?? err.message }
        } else {
          value = { kind: 'invalid', error: err instanceof Error ? err.message : String(err) }
        }
      }
      if (!cancelled) setEstimated({ key: estimateKey, value })
    }, 400)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [expanded, wallet, argsComplete, estimateKey, raws, valueRaw, fn, address, payable])

  async function write() {
    if (!wallet || estimate?.kind !== 'gas' || busy) return
    const codec = await import('../abiCodec')
    let data: `0x${string}`
    let valueWei: bigint
    try {
      data = codec.encodeCall(fn, codec.parseArgs(fn, raws))
      valueWei = payable ? parseWethValue(valueRaw) : 0n
    } catch (err) {
      setEstimated({ key: estimateKey, value: { kind: 'invalid', error: err instanceof Error ? err.message : String(err) } })
      return
    }
    if (wallet.kind === 'substrate') {
      const sub = await import('../substrateWrite')
      await sub.runSubstrateWrite({
        address: wallet.address, signer: wallet.signer,
        source: wallet.evmFrom, to: address, data, valueWei,
        rpc: { estimateGas: ethEstimateGas, gasPrice: ethGasPrice, call: ethCallAt },
        decodeRevert: codec.decodeRevert,
        onStage: setStage,
      })
      return
    }
    if (!wallet.provider) return
    await runEvmWrite({
      provider: wallet.provider,
      from: wallet.evmFrom, to: address, data, valueWei,
      explorerOrigin: window.location.origin,
      rpc: { getTransactionReceipt: ethGetTransactionReceipt, call: ethCallAt },
      decodeRevert: codec.decodeRevert,
      onStage: setStage,
    })
  }

  return (
    <div className="id-card fn-row">
      <button type="button" className="fn-head" onClick={() => setExpanded(v => !v)} aria-expanded={expanded}>
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
              <input
                className="input"
                placeholder={input.type}
                value={raws[i] ?? ''}
                onChange={e => setRaws(prev => prev.map((v, j) => (j === i ? e.target.value : v)))}
              />
            </div>
          ))}
          {payable && (
            <div className="field">
              <label>value <span className="muted">(WETH, optional)</span></label>
              <input className="input" placeholder="0" value={valueRaw} onChange={e => setValueRaw(e.target.value)} />
            </div>
          )}
          {!wallet && <div className="fn-hint">Connect a wallet above to write.</div>}
          {wallet && argsComplete && !estimate && <div className="fn-hint">Estimating gas…</div>}
          {estimate?.kind === 'gas' && (
            <div className="fn-hint">
              Estimated gas: <span className="mono">{F.int(Number(estimate.gas))}</span>
            </div>
          )}
          {estimate?.kind === 'revert' && <div className="dialog-error">Write would revert: {estimate.reason}</div>}
          {estimate?.kind === 'invalid' && <div className="dialog-error">{estimate.error}</div>}
          <div>
            <button
              type="button"
              className="btn primary sm"
              disabled={!wallet || estimate?.kind !== 'gas' || busy}
              title={!wallet ? 'Connect a wallet first' : estimate?.kind === 'revert' ? 'The write would revert' : estimate?.kind !== 'gas' ? 'Fill the arguments first' : undefined}
              onClick={() => { void write() }}
            >
              {busy ? 'Writing…' : 'Write'}
            </button>
          </div>
          <WriteStageLine stage={stage} />
        </div>
      )}
    </div>
  )
}

// The lifecycle line under the Write button. "In block" links the extrinsic
// page when the watch reported an index (substrate path), the block page
// otherwise (EVM path — the eth tx hash is not a substrate extrinsic id).
function BlockRef({ blockHeight, txIndex }: { blockHeight: number; txIndex?: number }) {
  return txIndex != null
    ? <Link className="hash" to={paths.extrinsicAt(blockHeight, txIndex)}>{F.int(blockHeight)}-{txIndex}</Link>
    : <Link className="hash" to={paths.block(blockHeight)}>{F.int(blockHeight)}</Link>
}

function WriteStageLine({ stage }: { stage: WriteStage }) {
  if (stage.phase === 'idle') return null
  if (stage.phase === 'preparing') return <div className="fn-hint">Preparing the transaction…</div>
  if (stage.phase === 'wallet-pending') return <div className="fn-hint">Confirm in your wallet…</div>
  if (stage.phase === 'submitted' || stage.phase === 'in-block') {
    return (
      <div className="fn-hint">
        Submitted — waiting for the block · <span className="mono wrap-anywhere" style={{ fontSize: 11 }}>{stage.txHash}</span>
      </div>
    )
  }
  if (stage.phase === 'success') {
    return (
      <div>
        <span className="badge ok">✓ Success</span>{' '}
        <span className="muted" style={{ fontSize: 13 }}>in block <BlockRef blockHeight={stage.blockHeight} txIndex={stage.txIndex} /></span>
      </div>
    )
  }
  if (stage.phase === 'reverted') {
    return (
      <div className="dialog-error">
        Reverted{stage.reason ? `: ${stage.reason}` : ''} — in block <BlockRef blockHeight={stage.blockHeight} txIndex={stage.txIndex} />
      </div>
    )
  }
  return <div className="dialog-error">{stage.error}</div>
}
