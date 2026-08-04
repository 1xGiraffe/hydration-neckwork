import type { Eip1193Provider } from './wallets'
import { gasWithMargin, watchSubmittedWrite } from './contractWrite'
import type { SubmitResult, WriteStage } from './contractWrite'

// The EVM-wallet write flow: a Moonbeam CallPermit signed with
// eth_signTypedData_v4, dispatched by anyone as an unsigned
// MultiTransactionPayment.dispatch_permit. This is the only path an EVM wallet
// takes on the Write tab, because eth_sendTransaction cannot work here: the
// wallet gates sending on eth_getBalance, which on Hydration reports the WETH
// balance, while the fee is actually charged in the account's configured fee
// currency (MultiTransactionPayment.AccountCurrencyMap — HDX for most accounts).
// Signing typed data has no balance check, so the write goes through with no
// WETH at all.
//
// Deliberately dedot-free: the permit is pure construction plus one provider
// call, and submission is injected by the caller from the lazy dedot chunk
// (substrateWrite.ts) so this module never pulls an SDK into the EVM path.

// The CallPermit precompile — EIP-712 verifying contract and nonce source.
export const CALL_PERMIT_ADDRESS = '0x000000000000000000000000000000000000080a'

// keccak("nonces(address)")[0..4] — the permit nonce, which is NOT the account
// nonce: dispatch_permit deliberately leaves the account nonce untouched.
const NONCES_SELECTOR = '0x7ecebe00'

export function permitNonceCall(owner: string): { to: string; data: string } {
  return { to: CALL_PERMIT_ADDRESS, data: NONCES_SELECTOR + owner.toLowerCase().replace(/^0x/, '').padStart(64, '0') }
}

export function parsePermitNonce(raw: string): bigint {
  const hex = raw.trim()
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(hex)) throw new Error(`the CallPermit precompile answered ${hex || 'nothing'} for nonces()`)
  return BigInt(hex)
}

// EIP-712 payload the runtime reconstructs verbatim in validate_permit; every
// field name and type here is load-bearing (pallet_evm_precompile_call_permit).
export interface PermitFields {
  chainId: number
  from: string
  to: string
  valueWei: bigint
  data: string
  gasLimit: bigint
  nonce: bigint
  deadline: bigint
}

export function permitTypedData(fields: PermitFields): string {
  return JSON.stringify({
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      CallPermit: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'gaslimit', type: 'uint64' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'CallPermit',
    domain: {
      name: 'Call Permit Precompile',
      version: '1',
      chainId: fields.chainId,
      verifyingContract: CALL_PERMIT_ADDRESS,
    },
    message: {
      from: fields.from,
      to: fields.to,
      value: fields.valueWei.toString(),
      data: fields.data,
      gaslimit: Number(fields.gasLimit),
      nonce: fields.nonce.toString(),
      deadline: fields.deadline.toString(),
    },
  })
}

// A wallet returns the 65-byte signature as one hex string. Wallets differ on
// the recovery id: 0/1 (raw) and 27/28 (Ethereum) both occur, and the runtime's
// secp256k1_ecdsa_recover wants the Ethereum form.
export function splitSignature(signature: string): { v: number; r: string; s: string } {
  const hex = signature.trim().replace(/^0x/, '')
  if (hex.length !== 130) throw new Error(`the wallet returned a ${hex.length / 2}-byte signature, expected 65`)
  const raw = Number.parseInt(hex.slice(128), 16)
  const v = raw < 27 ? raw + 27 : raw
  if (v !== 27 && v !== 28) throw new Error(`the wallet returned recovery id ${raw}, which is neither 0/1 nor 27/28`)
  return { v, r: `0x${hex.slice(0, 64)}`, s: `0x${hex.slice(64, 128)}` }
}

// The nine dispatch_permit arguments in declaration order. No gas price: the
// pallet prices the dispatch itself, so this path cannot fail GasPriceTooLow.
export function buildDispatchPermitArgs(
  fields: PermitFields,
  sig: { v: number; r: string; s: string },
): readonly unknown[] {
  return [
    fields.from,
    fields.to,
    fields.valueWei,
    fields.data,
    fields.gasLimit,
    fields.deadline,
    sig.v,
    sig.r,
    sig.s,
  ] as const
}

// How long a signed permit stays dispatchable. Matches hydration-ui; the
// unsigned extrinsic's own longevity is 64 blocks, so this bounds how long a
// permit the user abandoned mid-flow could still be replayed by someone who saw
// it — until the permit nonce moves on.
export const PERMIT_DEADLINE_SECONDS = 3600n

export interface PermitWriteRpc {
  estimateGas(tx: { from?: string; to: string; data: string; value?: string }): Promise<bigint>
  call(tx: { from?: string; to: string; data: string; value?: string }, block: string): Promise<string>
  blockTimestamp(): Promise<bigint>
}

export interface PermitWriteOptions {
  provider: Eip1193Provider
  chainId: number
  from: string
  to: string
  data: string
  valueWei: bigint
  rpc: PermitWriteRpc
  // Submits the built args as an unsigned extrinsic and streams dedot's watch
  // results. Injected so this module stays SDK-free and testable.
  submit: (args: readonly unknown[], onResult: (result: SubmitResult) => void) => Promise<unknown>
  decodeRevert: (data: string) => string | null
  onStage: (stage: WriteStage) => void
  // How long to wait for the dispatch to be accepted before giving up. Bounded
  // because the WSS provider reconnects indefinitely: without this, an
  // unreachable node leaves the row sitting at "Confirm in your wallet…" after
  // the user has already signed, with nothing to act on.
  submitTimeoutMs?: number
}

const SUBMIT_TIMEOUT_MS = 30_000

function withSubmitTimeout(submission: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Drop the subscription if it ever does arrive — nothing is watching it.
      void submission.then(unsub => { if (typeof unsub === 'function') (unsub as () => void)() }).catch(() => {})
      reject(new Error('Could not reach the chain to dispatch the permit — the signature is still valid, so retrying costs nothing'))
    }, ms)
  })
  return Promise.race([submission, timeout]).finally(() => clearTimeout(timer))
}

// Drive one permit write end to end: price, read the permit nonce, sign, then
// dispatch unsigned. Never throws — every outcome is a WriteStage, and the last
// emitted stage is also returned.
export async function runPermitWrite(opts: PermitWriteOptions): Promise<WriteStage> {
  let stage: WriteStage = { phase: 'preparing' }
  const emit = (next: WriteStage) => { stage = next; opts.onStage(next) }
  emit(stage)

  const evmTx: { from: string; to: string; data: string; value?: string } = { from: opts.from, to: opts.to, data: opts.data }
  if (opts.valueWei > 0n) evmTx.value = `0x${opts.valueWei.toString(16)}`

  let args: readonly unknown[]
  try {
    const [gasEstimate, nonceRaw, timestamp] = await Promise.all([
      opts.rpc.estimateGas(evmTx),
      opts.rpc.call(permitNonceCall(opts.from), 'latest'),
      opts.rpc.blockTimestamp(),
    ])
    const fields: PermitFields = {
      chainId: opts.chainId,
      from: opts.from,
      to: opts.to,
      valueWei: opts.valueWei,
      data: opts.data,
      gasLimit: gasWithMargin(gasEstimate),
      nonce: parsePermitNonce(nonceRaw),
      deadline: timestamp + PERMIT_DEADLINE_SECONDS,
    }
    emit({ phase: 'wallet-pending' })
    const signature = await opts.provider.request({
      method: 'eth_signTypedData_v4',
      params: [opts.from, permitTypedData(fields)],
    }) as string
    args = buildDispatchPermitArgs(fields, splitSignature(signature))
  } catch (err) {
    emit({ phase: 'failed', error: err instanceof Error ? err.message : String(err) })
    return stage
  }

  // The pallet validates the permit in the pool AND dry-runs the dispatch, so a
  // bad permit is rejected at submission. It can still go stale afterwards
  // (deadline passed, nonce consumed elsewhere), and that branch returns Ok
  // without running any EVM call — hence unknownIs: 'failed', never a silent
  // success.
  return watchSubmittedWrite({
    start: onResult => withSubmitTimeout(opts.submit(args, onResult), opts.submitTimeoutMs ?? SUBMIT_TIMEOUT_MS),
    evmTx,
    rpc: { call: opts.rpc.call },
    decodeRevert: opts.decodeRevert,
    unknownIs: 'failed',
    unknownError: 'The chain accepted the extrinsic but ran no EVM call — the permit was no longer valid',
    emit,
    current: () => stage,
  })
}
