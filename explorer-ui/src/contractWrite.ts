import type { Eip1193Provider } from './wallets'
import { EVM_RPC_URL } from './evmRpc'

// The EVM-wallet write flow for the contract tab: Hydration chain add/switch
// parameters, the tx lifecycle driver, and the pure value/gas helpers. All of
// it is exercised through injected interfaces (EIP-1193 provider + a receipt
// RPC), so tests script every wallet behavior without a browser. Deliberately
// viem-free: calldata arrives pre-encoded and revert decoding is passed in by
// the caller from the lazy codec chunk.

export const HYDRATION_CHAIN_ID_HEX = '0x3640e'   // chain id 222222
export const HYDRATION_CHAIN_ID = 222222          // the EIP-712 domain wants it as a number

// wallet_addEthereumChain parameters (spec §7.5). The explorer origin is the
// caller's window.location.origin — the same self-reference the verify panel
// uses for its CLI commands.
export function hydrationChainParams(explorerOrigin: string) {
  return {
    chainId: HYDRATION_CHAIN_ID_HEX,
    chainName: 'Hydration',
    nativeCurrency: { name: 'WETH', symbol: 'WETH', decimals: 18 },
    rpcUrls: [EVM_RPC_URL],
    blockExplorerUrls: [explorerOrigin],
  }
}

// Put the wallet on Hydration before sending: try the cheap switch first, and
// only offer the full chain definition when the wallet answers 4902 ("chain
// not added", EIP-3085). A user rejection (4001) propagates — never re-prompt
// a declined request with a bigger one.
export async function ensureHydrationChain(provider: Eip1193Provider, explorerOrigin: string): Promise<void> {
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: HYDRATION_CHAIN_ID_HEX }] })
  } catch (err) {
    const code = (err as { code?: number }).code
    const message = err instanceof Error ? err.message : String(err)
    const unknownChain = code === 4902 || /unrecognized chain|not been added/i.test(message)
    if (!unknownChain) throw err
    await provider.request({ method: 'wallet_addEthereumChain', params: [hydrationChainParams(explorerOrigin)] })
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: HYDRATION_CHAIN_ID_HEX }] })
  }
}

// 25% headroom over eth_estimateGas, integer math (spec §7.5: estimate + margin).
export function gasWithMargin(estimate: bigint): bigint {
  return estimate + estimate / 4n
}

// The same headroom over eth_gasPrice, for a max_fee_per_gas the EVM pallet
// still accepts a few blocks later: Hydration's base fee is recomputed every
// block from the congestion multiplier and the ETH-HDX oracle, so the price we
// just read is routinely below the one the call is judged against — and the
// pallet answers GasPriceTooLow rather than charging less. Headroom is free: it
// is a ceiling, and with max_priority_fee_per_gas unset the pallet charges the
// block's base fee and refunds the rest of the pre-deposit.
export function gasPriceWithMargin(price: bigint): bigint {
  return price + price / 4n
}

// A payable function's value field: decimal WETH → wei, string math only (18
// fractional digits exceed double precision). Empty means zero — the field is
// optional. Throws with a user-facing message, surfaced next to the field.
export function parseWethValue(raw: string): bigint {
  const t = raw.trim()
  if (!t) return 0n
  const m = /^(\d+)(?:\.(\d*))?$/.exec(t)
  if (!m) throw new Error('value expects a WETH amount like 0.25')
  const fraction = m[2] ?? ''
  if (fraction.length > 18) throw new Error('WETH has 18 decimals — the fraction is too precise')
  return BigInt(m[1]) * 10n ** 18n + BigInt(fraction.padEnd(18, '0') || '0')
}

// The write lifecycle as the UI renders it, shared by the EVM-wallet and
// Substrate (EVM.call via dedot) paths: preparing (substrate only — chain
// connection + fee lookups) → wallet-pending (confirmation open in the
// wallet) → submitted (tx hash known) → in-block → success | reverted; failed
// covers everything before a hash exists (wallet rejection, transport). A
// receipt that never lands within the poll budget leaves the final state at
// submitted — the hash keeps the tx findable. `txIndex` is known only on the
// substrate path (dedot's watch reports it) and upgrades the block link to an
// extrinsic link.
export type WriteStage =
  | { phase: 'idle' }
  | { phase: 'preparing' }
  | { phase: 'wallet-pending' }
  | { phase: 'submitted'; txHash: string }
  | { phase: 'in-block'; txHash: string; blockHeight: number; txIndex?: number }
  | { phase: 'success'; txHash: string; blockHeight: number; txIndex?: number }
  | { phase: 'reverted'; txHash: string; blockHeight: number; txIndex?: number; reason: string | null }
  | { phase: 'failed'; error: string }

// One watched submission as dedot reports it, narrowed to what the lifecycle
// reads. Declared here rather than in substrateWrite.ts so the permit path can
// share the state machine below without importing the dedot chunk.
export interface SubmitResult {
  status: { type: string; value?: { blockHash?: string; blockNumber?: number; txIndex?: number; error?: string } }
  txHash: string
  events: readonly { event: { pallet: string; palletEvent: string | { name: string } } }[]
  dispatchError?: unknown
}

// An extrinsic succeeding says nothing about the EVM execution inside it — the
// pallet reports that through EVM.Executed / EVM.ExecutedFailed in the same
// extrinsic.
export function interpretEvmCallEvents(events: SubmitResult['events']): 'success' | 'reverted' | 'unknown' {
  for (const record of events) {
    if (record.event.pallet !== 'EVM') continue
    const name = typeof record.event.palletEvent === 'string' ? record.event.palletEvent : record.event.palletEvent.name
    if (name === 'Executed') return 'success'
    if (name === 'ExecutedFailed') return 'reverted'
  }
  return 'unknown'
}

export interface WatchOptions {
  start: (onResult: (result: SubmitResult) => void) => Promise<unknown>
  evmTx: { from?: string; to: string; data: string; value?: string }
  rpc: { call(tx: { from?: string; to: string; data: string; value?: string }, block: string): Promise<string> }
  decodeRevert: (data: string) => string | null
  // What an included extrinsic with no EVM outcome event means. EVM.call always
  // emits one, so 'success' is right there; dispatch_permit can return Ok having
  // run nothing when the permit went stale, where the honest answer is 'failed'.
  unknownIs: 'success' | 'failed'
  unknownError?: string
  emit: (stage: WriteStage) => void
  current: () => WriteStage
}

// The shared substrate-submission lifecycle: watch one extrinsic, translate
// dedot's status stream into WriteStages, and unsubscribe on the first terminal
// state. Finality is not waited for (the explorer's own feed shows it).
export async function watchSubmittedWrite(opts: WatchOptions): Promise<WriteStage> {
  await new Promise<void>(resolve => {
    let submitted = false
    let settled = false
    const settle = (next: WriteStage) => {
      if (settled) return
      settled = true
      opts.emit(next)
      // Drop the watch once terminal — the unsub handle arrives via the submit
      // promise, which may resolve after the first callbacks.
      void unsubPromise.then(unsub => { if (typeof unsub === 'function') (unsub as () => void)() }).catch(() => {})
      resolve()
    }
    const onResult = (result: SubmitResult) => {
      if (settled) return
      const { status } = result
      if (!submitted && (status.type === 'Validated' || status.type === 'Broadcasting')) {
        submitted = true
        opts.emit({ phase: 'submitted', txHash: result.txHash })
        return
      }
      if (status.type === 'BestChainBlockIncluded' || status.type === 'Finalized') {
        const blockHeight = status.value?.blockNumber ?? 0
        const txIndex = status.value?.txIndex
        opts.emit({ phase: 'in-block', txHash: result.txHash, blockHeight, txIndex })
        if (result.dispatchError) {
          settle({ phase: 'failed', error: 'The extrinsic failed on chain' })
          return
        }
        const outcome = interpretEvmCallEvents(result.events)
        if (outcome === 'reverted') {
          void revertAtBlock(opts, blockHeight).then(reason => {
            settle({ phase: 'reverted', txHash: result.txHash, blockHeight, txIndex, reason })
          })
          return
        }
        if (outcome === 'unknown' && opts.unknownIs === 'failed') {
          settle({ phase: 'failed', error: opts.unknownError ?? 'The extrinsic ran no EVM call' })
          return
        }
        settle({ phase: 'success', txHash: result.txHash, blockHeight, txIndex })
        return
      }
      if (status.type === 'Invalid' || status.type === 'Drop') {
        settle({ phase: 'failed', error: status.value?.error ?? 'The transaction was rejected by the node' })
      }
    }
    const unsubPromise = Promise.resolve()
      .then(() => opts.start(onResult))
      .catch(err => {
        settle({ phase: 'failed', error: err instanceof Error ? err.message : String(err) })
      })
  })
  return opts.current()
}

// Best-effort revert recovery: replay the call at the block that included it and
// decode the node's revert payload.
async function revertAtBlock(opts: WatchOptions, blockHeight: number): Promise<string | null> {
  try {
    await opts.rpc.call(opts.evmTx, `0x${blockHeight.toString(16)}`)
    return null
  } catch (err) {
    const data = (err as { data?: string }).data
    return typeof data === 'string' ? opts.decodeRevert(data) : null
  }
}

export interface EvmWriteRpc {
  getTransactionReceipt(hash: string): Promise<{ status: string; blockNumber: string; transactionHash: string } | null>
  call(tx: { from?: string; to: string; data: string; value?: string }, block: string): Promise<string>
}

export interface EvmWriteOptions {
  provider: Eip1193Provider
  from: string
  to: string
  data: string
  valueWei: bigint
  explorerOrigin: string
  rpc: EvmWriteRpc
  decodeRevert: (data: string) => string | null
  onStage: (stage: WriteStage) => void
  pollMs?: number
  maxPolls?: number
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// Drive one EVM-wallet write end to end. Never throws — every outcome is a
// WriteStage, and the last emitted stage is also returned.
export async function runEvmWrite(opts: EvmWriteOptions): Promise<WriteStage> {
  const { provider, rpc, onStage, pollMs = 3_000, maxPolls = 60 } = opts
  let stage: WriteStage = { phase: 'wallet-pending' }
  const emit = (next: WriteStage) => { stage = next; onStage(next) }
  emit(stage)

  let txHash: string
  try {
    await ensureHydrationChain(provider, opts.explorerOrigin)
    const tx: { from: string; to: string; data: string; value?: string } = { from: opts.from, to: opts.to, data: opts.data }
    if (opts.valueWei > 0n) tx.value = `0x${opts.valueWei.toString(16)}`
    txHash = await provider.request({ method: 'eth_sendTransaction', params: [tx] }) as string
  } catch (err) {
    emit({ phase: 'failed', error: err instanceof Error ? err.message : String(err) })
    return stage
  }
  emit({ phase: 'submitted', txHash })

  for (let i = 0; i < maxPolls; i++) {
    if (i > 0 || pollMs === 0) await sleep(pollMs)
    let receipt: Awaited<ReturnType<EvmWriteRpc['getTransactionReceipt']>>
    try {
      receipt = await rpc.getTransactionReceipt(txHash)
    } catch {
      continue   // a flaky poll is not a failed transaction
    }
    if (!receipt) continue
    const blockHeight = Number.parseInt(receipt.blockNumber, 16)
    emit({ phase: 'in-block', txHash, blockHeight })
    if (receipt.status === '0x0') {
      emit({ phase: 'reverted', txHash, blockHeight, reason: await revertReason(opts, receipt.blockNumber) })
    } else {
      emit({ phase: 'success', txHash, blockHeight })
    }
    return stage
  }
  return stage
}

// A mined-but-failed tx's receipt carries no revert data; replaying the same
// call at the receipt's block recovers it (best-effort — a state change since
// that block's snapshot can change the answer, so null falls back to a plain
// "reverted" in the UI).
async function revertReason(opts: EvmWriteOptions, blockNumber: string): Promise<string | null> {
  try {
    const tx: { from: string; to: string; data: string; value?: string } = { from: opts.from, to: opts.to, data: opts.data }
    if (opts.valueWei > 0n) tx.value = `0x${opts.valueWei.toString(16)}`
    await opts.rpc.call(tx, blockNumber)
    return null
  } catch (err) {
    const data = (err as { data?: string }).data
    return typeof data === 'string' ? opts.decodeRevert(data) : null
  }
}
