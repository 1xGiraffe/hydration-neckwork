import { config } from './config.js'
import type { AssetRow } from './db/schema.ts'
import type { AssetMetadata } from './registry/types.ts'

export interface NativeAssetInfo {
  assetId: number
  symbol: string
  name: string
  decimals: number
}

const NATIVE_ASSET_ID = 0
const RPC_TIMEOUT_MS = 10_000

interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

function firstString(value: unknown): string | null {
  const candidate = typeof value === 'string'
    ? value
    : Array.isArray(value) && typeof value[0] === 'string'
      ? value[0]
      : null
  if (candidate == null || candidate.trim() === '') return null
  return candidate.trim()
}

function firstNumber(value: unknown): number | null {
  const candidate = typeof value === 'number'
    ? value
    : Array.isArray(value) && typeof value[0] === 'number'
      ? value[0]
      : null
  return candidate != null && Number.isSafeInteger(candidate) && candidate >= 0
    ? candidate
    : null
}

async function requestOverHttp(url: string): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'system_properties',
      params: [],
    }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }

  const json = await response.json() as JsonRpcSuccess
  if (json.error) {
    throw new Error(`system_properties failed: ${json.error.message}`)
  }

  return json.result
}

async function requestOverWebSocket(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    let settled = false
    const timer = setTimeout(() => {
      fail(new Error('system_properties timed out'))
    }, RPC_TIMEOUT_MS)

    const closeSocket = (): void => {
      if (socket.readyState >= WebSocket.CLOSING) return
      try {
        socket.close()
      } catch {
        // The original request result is more useful than a close failure.
      }
    }

    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      closeSocket()
      reject(error)
    }

    const succeed = (result: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      closeSocket()
      resolve(result)
    }

    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify({
          id: 1,
          jsonrpc: '2.0',
          method: 'system_properties',
          params: [],
        }))
      } catch (error) {
        fail(error)
      }
    })

    socket.addEventListener('message', (event) => {
      try {
        const json = JSON.parse(String(event.data)) as JsonRpcSuccess
        if (json.id !== 1) return
        if (json.error) {
          fail(new Error(`system_properties failed: ${json.error.message}`))
          return
        }
        succeed(json.result)
      } catch (error) {
        fail(error)
      }
    })

    socket.addEventListener('error', () => {
      fail(new Error('WebSocket request failed'))
    })

    socket.addEventListener('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('WebSocket closed before system_properties responded'))
    })
  })
}

export async function loadNativeAssetInfo(rpcUrl: string = config.RPC_URL): Promise<NativeAssetInfo | null> {
  try {
    const result = rpcUrl.startsWith('ws://') || rpcUrl.startsWith('wss://')
      ? await requestOverWebSocket(rpcUrl)
      : await requestOverHttp(rpcUrl)

    const properties = (result ?? {}) as {
      tokenSymbol?: unknown
      tokenDecimals?: unknown
    }

    const symbol = firstString(properties.tokenSymbol)
    const decimals = firstNumber(properties.tokenDecimals)

    if (symbol == null || decimals == null) {
      return null
    }

    return {
      assetId: NATIVE_ASSET_ID,
      symbol,
      // system_properties does not expose a long-form asset name
      name: symbol,
      decimals,
    }
  } catch (error) {
    console.warn('[NativeAsset] Failed to load chain properties:', error)
    return null
  }
}

export function nativeAssetInfoToMetadata(nativeAsset: NativeAssetInfo): AssetMetadata {
  return {
    assetId: nativeAsset.assetId,
    symbol: nativeAsset.symbol,
    name: nativeAsset.name,
    decimals: nativeAsset.decimals,
    assetType: 'Token',
  }
}

export function nativeAssetInfoToRow(nativeAsset: NativeAssetInfo): AssetRow {
  return {
    asset_id: nativeAsset.assetId,
    symbol: nativeAsset.symbol,
    name: nativeAsset.name,
    decimals: nativeAsset.decimals,
    parachain_id: null,
    origin_ecosystem: null,
    origin_chain_id: null,
    origin_asset_id: null,
  }
}
