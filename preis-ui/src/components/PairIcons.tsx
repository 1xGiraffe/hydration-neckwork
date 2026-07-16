import React from 'react'
import AssetIcon from './AssetIcon'
import type { Asset } from '../types'

interface PairIconsProps {
  base: Asset
  quote: Asset
  isUsdPair: boolean
  size?: number
}

function PairIconsInner({ base, quote, isUsdPair, size = 24 }: PairIconsProps) {
  if (isUsdPair) {
    return (
      <AssetIcon
        assetId={base.assetId}
        symbol={base.symbol}
        size={size}
        parachainId={base.parachainId}
        origin={base.origin}
      />
    )
  }

  const offset = Math.round(size * 0.58)
  const containerWidth = size + offset

  return (
    <div style={{ position: 'relative', width: containerWidth, height: size, flexShrink: 0 }}>
      {/* Quote icon — behind (lower zIndex), shifted right */}
      <div style={{ position: 'absolute', left: offset, top: 0, zIndex: 1 }}>
        <AssetIcon
          assetId={quote.assetId}
          symbol={quote.symbol}
          size={size}
          parachainId={quote.parachainId}
          origin={quote.origin}
        />
      </div>
      {/* Base icon — front (higher zIndex), at left */}
      <div style={{ position: 'absolute', left: 0, top: 0, zIndex: 2 }}>
        <AssetIcon
          assetId={base.assetId}
          symbol={base.symbol}
          size={size}
          parachainId={base.parachainId}
          origin={base.origin}
        />
      </div>
    </div>
  )
}

export default React.memo(PairIconsInner)
