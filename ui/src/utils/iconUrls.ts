const ICON_CDN = 'https://cdn.jsdelivr.net/gh/galacticcouncil/intergalactic-asset-metadata@master/v2'

export function assetIconUrl(assetId: number, ext: 'svg' | 'png' = 'svg'): string {
  return `${ICON_CDN}/polkadot/2034/assets/${assetId}/icon.${ext}`
}

export function chainIconUrl(parachainId: number): string {
  return `${ICON_CDN}/polkadot/${parachainId}/icon.svg`
}

// Composite icon: half HOLLAR + half underlying asset
// [leftAssetId, rightAssetId]
export const COMPOSITE_ICONS: Record<number, [number, number]> = {
  1110: [222, 22],   // HUSDC = HOLLAR + USDC
  1111: [222, 10],   // HUSDT = HOLLAR + USDT
  1112: [222, 1112], // HUSDS = HOLLAR + USDS (no icon yet, fallback)
  1113: [222, 1000625], // HUSDe = HOLLAR + sUSDe
}
