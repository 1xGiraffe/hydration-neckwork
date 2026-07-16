const RPC_TIMEOUT_MS = 15_000

interface JsonRpcResponse {
  result?: unknown
  error?: unknown
}

function isHttpUrl(url: string): boolean {
  return /^https?:/i.test(url)
}

async function requestResult(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  })
  if (!response.ok) return null

  const payload = await response.json() as JsonRpcResponse
  return payload.error == null ? payload.result : null
}

export function parseRpcBlockNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) return null

  try {
    const block = BigInt(value)
    return block <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(block) : null
  } catch {
    return null
  }
}

/** Resolve the current best block from an HTTP(S) Substrate RPC endpoint. */
export async function fetchChainHead(rpcUrl: string): Promise<number | null> {
  if (!isHttpUrl(rpcUrl)) return null

  try {
    const header = await requestResult(rpcUrl, 'chain_getHeader', []) as { number?: unknown } | null
    return parseRpcBlockNumber(header?.number)
  } catch {
    return null
  }
}

/** Resolve the current finalized block from an HTTP(S) Substrate RPC endpoint. */
export async function fetchFinalizedHead(rpcUrl: string): Promise<number | null> {
  if (!isHttpUrl(rpcUrl)) return null

  try {
    const hash = await requestResult(rpcUrl, 'chain_getFinalizedHead', [])
    if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) return null

    const header = await requestResult(rpcUrl, 'chain_getHeader', [hash]) as { number?: unknown } | null
    return parseRpcBlockNumber(header?.number)
  } catch {
    return null
  }
}
