import { useEffect } from 'react'
import { useAssetColor } from '../utils/iconColor'
import { HOLLAR_ASSET_ID } from '../components/revenueColors'
import type { AssetRef } from '../types'

// HOLLAR interest wears HOLLAR's own colour — the app-wide resolved asset
// colour every other HOLLAR surface uses (useAssetColor: the icon sample after
// the session's collision resolution). The revenue colour map is static CSS
// (`var(--rv-hollar)`), so the surfaces that draw it call this to publish the
// resolved value on <html>; until it lands the stylesheet's fallback applies.
const HOLLAR: AssetRef = { assetId: HOLLAR_ASSET_ID, iconAssetId: HOLLAR_ASSET_ID, symbol: 'HOLLAR', name: 'HOLLAR', decimals: 18, parachainId: null }

export function useRevenueHollarColor(): void {
  const color = useAssetColor(HOLLAR)
  useEffect(() => {
    document.documentElement.style.setProperty('--rv-hollar', color)
  }, [color])
}
