import type { OmniwatchVolumeDetails } from '../types'

/**
 * What a candle's volume and its accounts' figures disagree by, when it matters.
 *
 * A candle's volume is POOL volume; the accounts are what each account traded
 * (the api's volume-details, `candle*` fields; the rule is src/blocks/
 * icePotSettlement.ts). Two things separate them, in opposite directions:
 * - volume no account is booked for — an ICE solution's route hop through an
 *   asset none of its intent owners traded, the fee processor's conversions — is
 *   in the candle and in no account: UNATTRIBUTED;
 * - the part of an ICE intent matched peer-to-peer against another intent never
 *   touches a pool, so it is in its owner's figures and in no candle: MATCHED.
 * The figure is the candle's total minus the accounts' principal total, so the
 * two net out within one candle: an `unattributed` result is at least that much
 * volume without an account, a `matched` one at least that much matched volume.
 *
 * Material means at least $1 and 1% of the larger side, judged on USD; on an
 * unpriced asset (no USD either side) on the native amounts, at 1%. Below that it
 * is rounding and price-row noise, and the inspection says nothing.
 */
export interface VolumeReconciliation {
  kind: 'unattributed' | 'matched'
  /** Absolute USD difference. */
  usd: number
  /** Absolute difference in the base asset's raw units, as an exact decimal string. */
  native: string
}

const MIN_USD = 1
const MIN_SHARE = 0.01

function rawToBigInt(raw: string | undefined): bigint | null {
  return raw != null && /^-?\d+$/.test(raw) ? BigInt(raw) : null
}

export function reconcileCandleVolume(details: OmniwatchVolumeDetails): VolumeReconciliation | null {
  if (details.candleVolumeTotal == null || details.candleNativeVolumeTotal == null) return null
  const candleNative = rawToBigInt(details.candleNativeVolumeTotal)
  const accountsNative = rawToBigInt(details.nativeVolumeTotal)
  if (candleNative == null || accountsNative == null) return null
  const usdDiff = details.candleVolumeTotal - details.volumeTotal
  const nativeDiff = candleNative - accountsNative
  const absNative = nativeDiff < 0n ? -nativeDiff : nativeDiff
  const largerUsd = Math.max(details.candleVolumeTotal, details.volumeTotal)
  let sign: number
  if (largerUsd > 0) {
    if (Math.abs(usdDiff) < Math.max(MIN_USD, MIN_SHARE * largerUsd)) return null
    sign = Math.sign(usdDiff)
  } else {
    const largerNative = candleNative > accountsNative ? candleNative : accountsNative
    if (absNative === 0n || absNative * 100n < largerNative) return null
    sign = nativeDiff > 0n ? 1 : -1
  }
  return { kind: sign > 0 ? 'unattributed' : 'matched', usd: Math.abs(usdDiff), native: absNative.toString() }
}
