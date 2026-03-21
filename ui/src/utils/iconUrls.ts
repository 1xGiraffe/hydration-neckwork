const ICON_CDN = 'https://cdn.jsdelivr.net/gh/galacticcouncil/intergalactic-asset-metadata@master/v2'

export function assetIconUrl(assetId: number, ext: 'svg' | 'png' = 'svg'): string {
  return `${ICON_CDN}/polkadot/2034/assets/${assetId}/icon.${ext}`
}

export function chainIconUrl(parachainId: number): string {
  return `${ICON_CDN}/polkadot/${parachainId}/icon.svg`
}
