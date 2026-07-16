import { memo, useState } from 'react'
import { assetIconCandidates, assetIconUrl, chainIconUrl, originChainIconUrl, COMPOSITE_ICONS } from '../utils/iconUrls'
import type { AssetOrigin } from '../types'

interface AssetIconProps {
  assetId: number
  symbol: string
  size?: number
  parachainId?: number | null
  origin?: AssetOrigin | null
}

function symbolToColor(symbol: string): string {
  const hue = symbol.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360
  return `hsl(${hue}, 55%, 45%)`
}

function HalfIcon({ assetId, side, size }: { assetId: number; side: 'left' | 'right'; size: number }) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const [triedPng, setTriedPng] = useState(false)

  if (error) return null

  const clipPath = side === 'left'
    ? 'inset(0 50% 0 0)'
    : 'inset(0 0 0 50%)'

  return (
    <img
      src={assetIconUrl(assetId, triedPng ? 'png' : 'svg')}
      alt=""
      width={size}
      height={size}
      onLoad={() => setLoaded(true)}
      onError={() => {
        if (!triedPng) { setTriedPng(true); setLoaded(false) }
        else setError(true)
      }}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: size,
        height: size,
        borderRadius: '50%',
        objectFit: 'cover',
        clipPath,
        opacity: loaded ? 1 : 0,
      }}
    />
  )
}

function AssetIconInner({ assetId, symbol, size = 24, parachainId, origin }: AssetIconProps) {
  const [imgLoaded, setImgLoaded] = useState(false)
  const [candidateIndex, setCandidateIndex] = useState(0)
  const [badgeError, setBadgeError] = useState(false)
  const composite = COMPOSITE_ICONS[assetId]
  const candidates = assetIconCandidates(assetId, origin)
  const imgError = candidateIndex >= candidates.length
  const badgeUrl = origin ? originChainIconUrl(origin) : parachainId != null ? chainIconUrl(parachainId) : null

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      {/* Letter fallback — only shown while icon hasn't loaded */}
      {!imgLoaded && !composite && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: size,
          height: size,
          borderRadius: '50%',
          background: symbolToColor(symbol),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: size * 0.42,
          fontWeight: 700,
          color: '#fff',
          userSelect: 'none',
        }}>
          {symbol.slice(0, 2)}
        </div>
      )}

      {/* Composite icon (half + half) or regular icon */}
      {composite ? (
        <>
          <HalfIcon assetId={composite[0]} side="left" size={size} />
          <HalfIcon assetId={composite[1]} side="right" size={size} />
        </>
      ) : !imgError && (
        <img
          src={candidates[candidateIndex]}
          alt={symbol}
          width={size}
          height={size}
          onLoad={() => setImgLoaded(true)}
          onError={() => {
            setCandidateIndex(index => index + 1)
            setImgLoaded(false)
          }}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: size,
            height: size,
            borderRadius: '50%',
            objectFit: 'cover',
          }}
        />
      )}

      {/* Origin badge */}
      {badgeUrl && !badgeError && (
        <img
          src={badgeUrl}
          alt=""
          width={12}
          height={12}
          onError={() => setBadgeError(true)}
          style={{
            position: 'absolute',
            bottom: -1,
            right: -1,
            width: 12,
            height: 12,
            borderRadius: '50%',
            border: '1px solid #030816',
            background: '#030816',
            objectFit: 'cover',
          }}
        />
      )}
    </div>
  )
}

function AssetIconKeyed(props: AssetIconProps) {
  return <AssetIconInner key={`${props.assetId}:${props.parachainId ?? ''}:${props.origin?.ecosystem ?? ''}:${props.origin?.chainId ?? ''}:${props.origin?.assetId ?? ''}`} {...props} />
}

const AssetIcon = memo(AssetIconKeyed)
export default AssetIcon
