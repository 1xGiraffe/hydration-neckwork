import type { AssetOrigin } from '../types'

const ICON_CDN = 'https://cdn.jsdelivr.net/gh/galacticcouncil/intergalactic-asset-metadata@master/v2'

export function assetIconUrl(assetId: number, ext: 'svg' | 'png' = 'svg'): string {
  return `${ICON_CDN}/polkadot/2034/assets/${assetId}/icon.${ext}`
}

export function chainIconUrl(parachainId: number): string {
  return `${ICON_CDN}/polkadot/${parachainId}/icon.svg`
}

export function originChainIconUrl(origin: AssetOrigin): string {
  return `${ICON_CDN}/${origin.ecosystem}/${origin.chainId}/icon.svg`
}

export function assetIconCandidates(assetId: number, origin?: AssetOrigin | null): string[] {
  const local = [assetIconUrl(assetId), assetIconUrl(assetId, 'png')]
  if (!origin?.assetId) return local
  const key = origin.ecosystem === 'ethereum' ? origin.assetId.toLowerCase() : origin.assetId
  const originIcons = [
    `${ICON_CDN}/${origin.ecosystem}/${origin.chainId}/assets/${key}/icon.svg`,
    `${ICON_CDN}/${origin.ecosystem}/${origin.chainId}/assets/${key}/icon.png`,
  ]
  // Hydration has curated local icons for parachain assets. Ethereum-native
  // assets such as 1000766 do not, so prefer their canonical ERC-20 metadata.
  return origin.ecosystem === 'ethereum' ? [...originIcons, ...local] : [...local, ...originIcons]
}

// Composite icon: half HOLLAR + half underlying asset
// [leftAssetId, rightAssetId]
export const COMPOSITE_ICONS: Record<number, [number, number]> = {
  1110: [222, 22],   // HUSDC = HOLLAR + USDC
  1111: [222, 10],   // HUSDT = HOLLAR + USDT
  1112: [222, 1112], // HUSDS = HOLLAR + USDS (no icon yet, fallback)
  1113: [222, 1000625], // HUSDe = HOLLAR + sUSDe
  4444: [222, 44],      // HEURC = HOLLAR + EURC
}
