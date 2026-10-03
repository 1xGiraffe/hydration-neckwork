import type { LpShareWrapper, PoolYield } from '../../types'
import { useYields } from '../../hooks/usePositions'
import { YieldHover } from './YieldHover'
import { POOL_APR_NOTE, poolAprRows, poolHeadline, rewardIcons, wrappedPoolAprNote, type PoolFamily } from './liquidityModel'

// A pool's APR as every pool surface shows it — the positions' Liquidity tab,
// the pool pages, the Omnipool table, the liquidity list and an asset's
// Liquidity tab — so the figure, its breakdown and its wording are one. Like the
// Hydration UI's pool APR it is the whole rate: fees, the lending and own yield
// of the pool's legs, and every live farm at full loyalty (the total is what
// GET /explorer/yields states; farms are inside it, listed per reward asset).

/** A pool rate with its breakdown on hover: `label` titles the card ("GDOT · pool APR"). */
export function PoolAprHover({ y, wrapper, label, emptyText, omnipoolAsset }: {
  y: PoolYield | null
  wrapper?: LpShareWrapper
  label: string
  emptyText?: string
  /** Set for an Omnipool asset's rate, so its breakdown names the parts the Hydration app states differently. */
  omnipoolAsset?: { assetId: number; symbol: string }
}) {
  return (
    <YieldHover total={y?.totalAprPct ?? null} rows={poolAprRows(y, omnipoolAsset)} icons={rewardIcons(y)} title={`${label} · pool APR`}
      note={wrapper ? wrappedPoolAprNote(wrapper.asset.symbol) : POOL_APR_NOTE} emptyText={emptyText} />
  )
}

/** The pool rate of one venue key (an Omnipool asset id, a stableswap/XYK share id, a v3 pool address), read from the shared yields query. */
export function PoolApr({ family, poolKey, label, symbol }: { family: PoolFamily; poolKey: string; label: string; symbol?: string }) {
  const yields = useYields()
  const h = poolHeadline(yields.data, { family, key: family === 'uniswapV3' ? poolKey.toLowerCase() : poolKey })
  const omnipoolAsset = family === 'omnipool' && symbol ? { assetId: Number(poolKey), symbol } : undefined
  return <PoolAprHover y={h.yield} wrapper={h.wrapper} label={label} emptyText={yields.isPending ? '…' : '—'} omnipoolAsset={omnipoolAsset} />
}
