// Tiny fetch-based JSON-RPC helpers for the browser-side EVM reads on the
// contract tab (bytecode display, Read-tab eth_call). Deliberately no client
// SDK: the codec lives in abiCodec.ts (viem, lazy) and the transport is this
// file — nothing else in the bundle needs a provider abstraction.
export const EVM_RPC_URL = (import.meta.env.VITE_EVM_RPC_URL as string | undefined) || 'https://hydration-rpc.neckwork.net'

// A failed call. `data` carries the node's revert payload (when it supplies
// one) so the caller can decode Error(string) into a message.
export class EvmRpcError extends Error {
  data?: string
  constructor(message: string, data?: string) {
    super(message)
    this.name = 'EvmRpcError'
    this.data = data
  }
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let response: Response
  try {
    response = await fetch(EVM_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  } catch (err) {
    throw new EvmRpcError(`RPC unreachable: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!response.ok) throw new EvmRpcError(`RPC answered HTTP ${response.status}`)
  const json = await response.json().catch(() => null) as { result?: T; error?: { message?: string; data?: unknown } } | null
  if (!json) throw new EvmRpcError('RPC returned non-JSON')
  if (json.error) {
    throw new EvmRpcError(json.error.message || 'RPC error', typeof json.error.data === 'string' ? json.error.data : undefined)
  }
  return json.result as T
}

export function ethCall(to: string, data: string): Promise<string> {
  return rpc<string>('eth_call', [{ to, data }, 'latest'])
}

export function ethGetCode(address: string): Promise<string> {
  return rpc<string>('eth_getCode', [address, 'latest'])
}

// --- write-tab helpers -------------------------------------------------------

// A tx object as eth_estimateGas / eth_call take it. `value` is hex wei.
export interface EthTx { from?: string; to: string; data: string; value?: string }

export interface EthReceipt { status: string; blockNumber: string; transactionHash: string }

// Replay a full tx (with from/value) at a specific block — recovers the revert
// data of a mined-but-failed write from its receipt's block.
export function ethCallAt(tx: EthTx, block: string): Promise<string> {
  return rpc<string>('eth_call', [tx, block])
}

export async function ethEstimateGas(tx: EthTx): Promise<bigint> {
  return BigInt(await rpc<string>('eth_estimateGas', [tx]))
}

export async function ethGasPrice(): Promise<bigint> {
  return BigInt(await rpc<string>('eth_gasPrice', []))
}

export function ethGetTransactionReceipt(txHash: string): Promise<EthReceipt | null> {
  return rpc<EthReceipt | null>('eth_getTransactionReceipt', [txHash])
}

// The chain's own clock, for a CallPermit deadline the runtime will accept: it
// compares the deadline against the block timestamp in seconds, so the browser's
// clock (and its skew) must not be the source.
export async function ethBlockTimestamp(): Promise<bigint> {
  const block = await rpc<{ timestamp: string } | null>('eth_getBlockByNumber', ['latest', false])
  if (!block?.timestamp) throw new EvmRpcError('the node returned no latest block')
  return BigInt(block.timestamp)
}
