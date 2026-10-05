// The shape of each Wormhole NTT asset across its chains — which token it is on
// each peer chain, which of them hold custody — published by the backing
// snapshot and read by the explorer's activity rows and asset page. A transfer
// row can then say WHICH token it left from or arrives as (Robinhood's own
// WETH, not Ethereum's), and an asset page can list every lockbox, without a
// request-time chain read and without the explorer importing the monitor.
//
// A leaf on purpose: the backing monitor imports the explorer service, so the
// explorer service reading back through it would close an import cycle.

export type WormholeChainLayerRef = 'l1' | 'l2' | 'other'

export interface WormholeRemoteToken {
  /** Wormhole chain id of the peer chain. */
  chainId: number
  chainName: string
  /** In its chain's own notation (EVM address, Solana mint, Sui coin type). */
  address: string
  name: string | null
  symbol: string | null
  decimals: number | null
  /** `lockbox`: the real token is locked there; `spoke`: a representation is minted there. */
  role: 'lockbox' | 'spoke' | null
  /** The peer chain's own explorer page for the token, where one is known. */
  explorerUrl: string | null
  layer: WormholeChainLayerRef | null
  /** What custody on that chain additionally rests on; null for an L1. */
  riskNote: string | null
  /** The registry origin (or, without one, the derived primary). */
  primary: boolean
}

/**
 * One peer chain on the asset page. Every registered peer is listed, so the
 * lockbox count never drops while a token is still being read: `address` (and
 * with it the token's name, symbol and explorer link) is null until it is.
 */
export type WormholeBridgePeer = Omit<WormholeRemoteToken, 'address'> & { address: string | null }

export interface WormholeAssetBridge {
  assetId: number
  /** Hydration's own side: `lockbox` when its manager locks the token, `spoke` when it mints. */
  hydrationRole: 'lockbox' | 'spoke' | null
  primaryChainId: number
  primaryChainName: string
  /** Hydration's NttManager for the asset. */
  manager: string
  /** Every peer chain, primary first. */
  peers: WormholeBridgePeer[]
}

let bridges = new Map<number, WormholeAssetBridge>()

/** Replaces the whole set — each backing snapshot states it completely. */
export function setWormholeBridges(list: readonly WormholeAssetBridge[]): void {
  bridges = new Map(list.map(b => [b.assetId, b]))
}

/** The token `assetId` is on Wormhole chain `chainId`, or null when that is not one of its peers (or its token is not known yet). */
export function wormholeRemoteToken(assetId: number, chainId: number): WormholeRemoteToken | null {
  const peer = bridges.get(assetId)?.peers.find(p => p.chainId === chainId)
  return peer?.address != null ? { ...peer, address: peer.address } : null
}

/** The asset's bridge shape, or null for an asset that is not a Wormhole NTT asset (or before the first snapshot). */
export function wormholeAssetBridge(assetId: number): WormholeAssetBridge | null {
  return bridges.get(assetId) ?? null
}
