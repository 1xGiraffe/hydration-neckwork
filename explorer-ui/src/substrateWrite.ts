import { DedotClient, WsProvider } from 'dedot'
import { decodeAddress, u8aToHex } from 'dedot/utils'
import { gasPriceWithMargin, gasWithMargin, watchSubmittedWrite } from './contractWrite'
import type { SubmitResult, WriteStage } from './contractWrite'

// The Substrate half of the contract Write tab: build, sign and watch an
// EVM.call extrinsic through dedot, plus the unsigned dispatch_permit submission
// the EVM-wallet path (permitWrite.ts) hands over once its permit is signed.
// This module is the single import point for dedot and loads as its own lazy
// chunk (vite.config.ts manualChunks) only when a write actually needs a chain
// connection — the base bundle stays SDK-free. dedot fetches metadata at
// runtime, so runtime upgrades never break pinned call indices.

export const SUBSTRATE_WS_URL = (import.meta.env.VITE_SUBSTRATE_WS_URL as string | undefined) || 'wss://hydration-rpc.neckwork.net'

// The H160 a substrate signer writes as: the first 20 bytes of its
// AccountId32 — exactly what the runtime's EnsureAddressTruncated accepts as
// the `source` of an EVM.call from that origin.
export function deriveEvmSource(address: string): string {
  return u8aToHex(decodeAddress(address).slice(0, 20))
}

// The ten EVM.call arguments in declaration order (spec §7.5): gas_limit is
// the eth_estimateGas answer plus margin, max_fee_per_gas the eth_gasPrice
// answer plus the same margin (a ceiling the moving base fee cannot outrun —
// see gasPriceWithMargin); max_priority_fee_per_gas and nonce stay None
// (undefined is dedot's Option::None), which is also what keeps the charged
// price at the block's base fee, access_list empty. authorization_list is the
// EIP-7702 list the pallet added as a tenth field — a Vec, not an Option, so it
// must be an empty array; passing undefined makes dedot reject the call outright.
export function buildEvmCallArgs(input: { source: string; target: string; data: string; valueWei: bigint; gasEstimate: bigint; gasPriceWei: bigint }) {
  return [
    input.source,
    input.target,
    input.data,
    input.valueWei,
    gasWithMargin(input.gasEstimate),
    gasPriceWithMargin(input.gasPriceWei),
    undefined,
    undefined,
    [],
    [],
  ] as const
}

// The slice of a connected dedot client the write paths use — injectable so the
// lifecycle is testable without a chain.
export interface EvmCallClient {
  tx: {
    evm: {
      call: (...args: unknown[]) => {
        signAndSend(address: string, options: { signer?: unknown }, callback: (result: SubmitResult) => void): Promise<unknown>
      }
    }
    multiTransactionPayment: {
      dispatchPermit: (...args: unknown[]) => {
        // A submittable with no signature attached encodes as a bare (unsigned)
        // extrinsic, and send() streams the same status/events shape
        // signAndSend does.
        send(callback: (result: SubmitResult) => void): Promise<unknown>
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

// Submit a signed CallPermit as an unsigned MultiTransactionPayment.dispatch_permit
// and stream the watch results. Nobody signs the extrinsic: the pallet's
// validate_unsigned checks the permit signature and dry-runs the dispatch in the
// pool, and the fee is charged to the permit's own `from` account in its
// configured fee currency.
export async function submitPermitUnsigned(
  args: readonly unknown[],
  onResult: (result: SubmitResult) => void,
  getClient: () => Promise<EvmCallClient> = () => getSubstrateClient() as unknown as Promise<EvmCallClient>,
): Promise<unknown> {
  const client = await getClient()
  try {
    return await client.tx.multiTransactionPayment.dispatchPermit(...args).send(onResult)
  } catch (err) {
    throw new Error(await describePermitRejection(err))
  }
}

// The pool rejects an unsigned dispatch_permit as InvalidTransaction::Custom(n),
// where n is the index of the pallet error validate_unsigned hit — the useful
// part ("EvmPermitExpired", "EvmPermitInvalid", …) that dedot's message drops.
// Resolved against live metadata, so a reordered error enum cannot mislabel it.
export async function describePermitRejection(err: unknown): Promise<string> {
  const message = err instanceof Error ? err.message : String(err)
  const code = customRejectionCode(err)
  if (code == null) return message
  try {
    const client = await getSubstrateClient()
    const pallet = client.metadata.latest.pallets.find(p => p.name === 'MultiTransactionPayment')
    const errorTypeId = pallet?.error?.typeId
    const type = errorTypeId == null ? undefined : client.metadata.latest.types[errorTypeId]
    const members = type?.typeDef.type === 'Enum' ? type.typeDef.value.members : undefined
    const name = members?.find(m => m.index === code)?.name
    if (name) return `The chain rejected the permit: ${name}`
  } catch {
    // fall through to the raw message — a metadata miss must not hide the error
  }
  return `${message} (pallet error ${code})`
}

// dedot's InvalidTxError carries the runtime's validateTransaction Result on
// `data`; the Custom payload sits at a variant-dependent depth inside its `err`,
// so search for it rather than assuming one shape.
export function customRejectionCode(err: unknown): number | null {
  const data = (err as { data?: { err?: unknown } }).data
  const validation = data?.err ?? data
  const seen = new Set<unknown>()
  const walk = (node: unknown, insideCustom: boolean): number | null => {
    if (node == null || typeof node !== 'object' || seen.has(node)) return null
    seen.add(node)
    const record = node as { type?: unknown; value?: unknown }
    const isCustom = insideCustom || record.type === 'Custom'
    if (isCustom && typeof record.value === 'number') return record.value
    return walk(record.value, isCustom)
  }
  return walk(validation, false)
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
// also returned.
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
  // EVM.call always emits an EVM outcome event, so an included extrinsic without
  // one is not a silent failure here the way a stale permit is.
  return watchSubmittedWrite({
    start: onResult => submittable.signAndSend(opts.address, { signer: opts.signer }, onResult),
    evmTx,
    rpc: { call: opts.rpc.call },
    decodeRevert: opts.decodeRevert,
    unknownIs: 'success',
    emit,
    current: () => stage,
  })
}

// Re-exported so existing importers keep their entry point while the shared
// lifecycle lives in the SDK-free module.
export { interpretEvmCallEvents } from './contractWrite'
export type { SubmitResult } from './contractWrite'
