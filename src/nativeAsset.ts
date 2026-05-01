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
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return null
}

function firstNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value) && typeof value[0] === 'number' && Number.isFinite(value[0])) {
    return value[0]
  }
  return null
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
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('system_properties timed out'))
    }, RPC_TIMEOUT_MS)

    const cleanup = () => clearTimeout(timer)

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'system_properties',
        params: [],
      }))
    })

    socket.addEventListener('message', (event) => {
      cleanup()
      try {
        const json = JSON.parse(String(event.data)) as JsonRpcSuccess
        if (json.id !== 1) return
        socket.close()
        if (json.error) {
          reject(new Error(`system_properties failed: ${json.error.message}`))
          return
        }
        resolve(json.result)
      } catch (error) {
        socket.close()
        reject(error)
      }
    })

    socket.addEventListener('error', () => {
      cleanup()
      reject(new Error('WebSocket request failed'))
    })

    socket.addEventListener('close', () => {
      cleanup()
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
  }
}
