import { cached } from './cache.ts'
import { SUBSTRATE_RPC_URL } from './substrateRpc.ts'

// Gas accounting for one EVM transaction.
//
// Gas used and the effective gas price are not indexed and not derivable from
// indexed rows: `Ethereum.transact` carries only a gas LIMIT, `Ethereum.Executed`
// carries no gas at all, and there is no TransactionPayment.TransactionFeePaid
// event on these extrinsics (the fee is taken through the EVM's own path). So the
// two numbers come from the chain's own receipt.
//
// One targeted call per EVM extrinsic a reader actually opens, cached for an hour:
// a receipt is immutable once its block exists, so a second look never re-asks.
// Receipt logs are ignored — the explorer renders EVM logs from indexed EVM.Log
// rows, which is the better source; the receipt answers gas only.
const RPC_TIMEOUT_MS = 8_000

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
  try {
    const res = await fetch(SUBSTRATE_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    if (!res.ok) return null
    const body = await res.json() as { result?: T; error?: unknown }
    return body.error != null ? null : (body.result ?? null)
  } catch { return null } finally { clearTimeout(timer) }
}

// Exact integers as decimal strings. The node answers in hex quantities, and gas
// prices are wei-scale values that must not be routed through a JS number.
function quantity(value: unknown): string | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) return null
  return BigInt(value).toString()
}

export interface EvmReceipt {
  gasUsed: string
  // Absent on a node that does not report it; the page then falls back to the
  // transaction's own ceiling and says so, rather than showing a made-up price.
  effectiveGasPrice: string | null
}

interface RawReceipt { gasUsed?: unknown; effectiveGasPrice?: unknown }

// Null rather than an error when the node cannot answer: the gas rows simply do
// not appear, instead of a zero standing in for a number nobody has.
export async function evmTransactionReceipt(txHash: string): Promise<EvmReceipt | null> {
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) return null
  return cached(`explorer:evm-receipt:${txHash}`, 3_600_000, async () => {
    const receipt = await rpc<RawReceipt>('eth_getTransactionReceipt', [txHash])
    if (receipt == null || typeof receipt !== 'object') return null
    const gasUsed = quantity(receipt.gasUsed)
    if (gasUsed == null) return null
    return { gasUsed, effectiveGasPrice: quantity(receipt.effectiveGasPrice) }
  })
}
