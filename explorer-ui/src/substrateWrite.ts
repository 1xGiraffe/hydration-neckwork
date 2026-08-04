import { DedotClient, WsProvider } from 'dedot'
import { decodeAddress, u8aToHex } from 'dedot/utils'
import { gasWithMargin } from './contractWrite'
import type { WriteStage } from './contractWrite'

// The Substrate half of the contract Write tab: build, sign and watch an
// EVM.call extrinsic through dedot. This module is the single import point
// for dedot and loads as its own lazy chunk (vite.config.ts manualChunks)
// only when a Substrate wallet connects on the tab — the base bundle stays
// SDK-free. dedot fetches metadata at runtime, so runtime upgrades never
// break pinned call indices.

export const SUBSTRATE_WS_URL = (import.meta.env.VITE_SUBSTRATE_WS_URL as string | undefined) || 'wss://hydration-rpc.neckwork.net'

// The H160 a substrate signer writes as: the first 20 bytes of its
// AccountId32 — exactly what the runtime's EnsureAddressTruncated accepts as
// the `source` of an EVM.call from that origin.
export function deriveEvmSource(address: string): string {
  return u8aToHex(decodeAddress(address).slice(0, 20))
}

// The nine EVM.call arguments in declaration order (spec §7.5): gas_limit is
// the eth_estimateGas answer plus margin, max_fee_per_gas the eth_gasPrice
// answer; max_priority_fee_per_gas and nonce stay None (undefined is dedot's
// Option::None), access_list empty.
export function buildEvmCallArgs(input: { source: string; target: string; data: string; valueWei: bigint; gasEstimate: bigint; gasPriceWei: bigint }) {
  return [
    input.source,
    input.target,
    input.data,
    input.valueWei,
    gasWithMargin(input.gasEstimate),
    input.gasPriceWei,
    undefined,
    undefined,
    [],
  ] as const
}

// EVM.call succeeding as an extrinsic says nothing about the EVM execution —
// the pallet reports that through EVM.Executed / EVM.ExecutedFailed events in
// the same extrinsic.
export function interpretEvmCallEvents(events: readonly { event: { pallet: string; palletEvent: string | { name: string } } }[]): 'success' | 'reverted' | 'unknown' {
  for (const record of events) {
    if (record.event.pallet !== 'EVM') continue
    const name = typeof record.event.palletEvent === 'string' ? record.event.palletEvent : record.event.palletEvent.name
    if (name === 'Executed') return 'success'
    if (name === 'ExecutedFailed') return 'reverted'
  }
  return 'unknown'
}

// The slice of a connected dedot client the write path uses — injectable so
// the lifecycle is testable without a chain.
export interface SubmitResult {
  status: { type: string; value?: { blockHash?: string; blockNumber?: number; txIndex?: number; error?: string } }
  txHash: string
  events: readonly { event: { pallet: string; palletEvent: string | { name: string } } }[]
  dispatchError?: unknown
}
export interface EvmCallClient {
  tx: {
    evm: {
      call: (...args: unknown[]) => {
        signAndSend(address: string, options: { signer?: unknown }, callback: (result: SubmitResult) => void): Promise<unknown>
      }
    }
  }
}

// One shared connection for the page's lifetime, established on first write.
// A failed connect clears the slot so the next attempt retries instead of
// caching the rejection.
let clientPromise: Promise<DedotClient> | null = null
export function getSubstrateClient(): Promise<DedotClient> {
  if (!clientPromise) {
    clientPromise = DedotClient.new(new WsProvider(SUBSTRATE_WS_URL)).catch(err => {
      clientPromise = null
      throw err
    })
  }
  return clientPromise
}

export interface SubstrateWriteOptions {
  // Injectable for tests; defaults to the shared WSS client. The cast is safe:
  // the untyped dedot client resolves pallet/call names dynamically from the
  // runtime metadata, and EvmCallClient is the slice this module touches.
  getClient?: () => Promise<EvmCallClient>
  address: string            // the signer's SS58 address, as the wallet injected it
  signer: unknown            // the extension's injected signer (signPayload)
  source: string             // deriveEvmSource(address)
  to: string
  data: string
  valueWei: bigint
  rpc: {
    estimateGas(tx: { from?: string; to: string; data: string; value?: string }): Promise<bigint>
    gasPrice(): Promise<bigint>
    call(tx: { from?: string; to: string; data: string; value?: string }, block: string): Promise<string>
  }
  decodeRevert: (data: string) => string | null
  onStage: (stage: WriteStage) => void
}

// Drive one EVM.call write end to end: connect, price, build, sign, watch.
// Never throws — every outcome is a WriteStage, and the last emitted stage is
// also returned. The watch unsubscribes on the first terminal state; finality
// is not waited for (the explorer's own feed shows it).
export async function runSubstrateWrite(opts: SubstrateWriteOptions): Promise<WriteStage> {
  let stage: WriteStage = { phase: 'preparing' }
  const emit = (next: WriteStage) => { stage = next; opts.onStage(next) }
  emit(stage)

  const evmTx: { from: string; to: string; data: string; value?: string } = { from: opts.source, to: opts.to, data: opts.data }
  if (opts.valueWei > 0n) evmTx.value = `0x${opts.valueWei.toString(16)}`

  let submittable: ReturnType<EvmCallClient['tx']['evm']['call']>
  try {
    const getClient = opts.getClient ?? (() => getSubstrateClient() as unknown as Promise<EvmCallClient>)
    const client = await getClient()
    const [gasEstimate, gasPriceWei] = await Promise.all([opts.rpc.estimateGas(evmTx), opts.rpc.gasPrice()])
    submittable = client.tx.evm.call(...buildEvmCallArgs({
      source: opts.source, target: opts.to, data: opts.data, valueWei: opts.valueWei, gasEstimate, gasPriceWei,
    }))
  } catch (err) {
    emit({ phase: 'failed', error: err instanceof Error ? err.message : String(err) })
    return stage
  }

  emit({ phase: 'wallet-pending' })
  await new Promise<void>(resolve => {
    let submitted = false
    let settled = false
    const settle = (next: WriteStage) => {
      if (settled) return
      settled = true
      emit(next)
      // Drop the watch once terminal — the unsub handle arrives via the
      // signAndSend promise, which may resolve after the first callbacks.
      void unsubPromise.then(unsub => { if (typeof unsub === 'function') (unsub as () => void)() }).catch(() => {})
      resolve()
    }
    const onResult = (result: SubmitResult) => {
      if (settled) return
      const { status } = result
      if (!submitted && (status.type === 'Validated' || status.type === 'Broadcasting')) {
        submitted = true
        emit({ phase: 'submitted', txHash: result.txHash })
        return
      }
      if (status.type === 'BestChainBlockIncluded' || status.type === 'Finalized') {
        const blockHeight = status.value?.blockNumber ?? 0
        const txIndex = status.value?.txIndex
        emit({ phase: 'in-block', txHash: result.txHash, blockHeight, txIndex })
        if (result.dispatchError) {
          settle({ phase: 'failed', error: 'The extrinsic failed on chain' })
          return
        }
        const outcome = interpretEvmCallEvents(result.events)
        if (outcome === 'reverted') {
          void revertReason(opts, evmTx, blockHeight).then(reason => {
            settle({ phase: 'reverted', txHash: result.txHash, blockHeight, txIndex, reason })
          })
        } else {
          settle({ phase: 'success', txHash: result.txHash, blockHeight, txIndex })
        }
        return
      }
      if (status.type === 'Invalid' || status.type === 'Drop') {
        settle({ phase: 'failed', error: status.value?.error ?? 'The transaction was rejected by the node' })
      }
    }
    const unsubPromise = Promise.resolve()
      .then(() => submittable.signAndSend(opts.address, { signer: opts.signer }, onResult))
      .catch(err => {
        settle({ phase: 'failed', error: err instanceof Error ? err.message : String(err) })
      })
  })
  return stage
}

// Same best-effort revert recovery as the EVM path: replay the call at the
// block that included it and decode the node's revert payload.
async function revertReason(opts: SubstrateWriteOptions, evmTx: { from?: string; to: string; data: string; value?: string }, blockHeight: number): Promise<string | null> {
  try {
    await opts.rpc.call(evmTx, `0x${blockHeight.toString(16)}`)
    return null
  } catch (err) {
    const data = (err as { data?: string }).data
    return typeof data === 'string' ? opts.decodeRevert(data) : null
  }
}
