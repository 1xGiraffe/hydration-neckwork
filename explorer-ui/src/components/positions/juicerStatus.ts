import type { JuicerRequestStatus } from '../../types'

// A Juicer withdrawal request's state as the Juicer page and the Strategies tab both word it.
export const JUICER_STATUS_LABEL: Record<JuicerRequestStatus, string> = {
  cooldown: 'Cooldown', queued: 'Queued', settling: 'Settling', claimable: 'Claim ready', claimed: 'Claimed',
}
export const JUICER_STATUS_TONE: Record<JuicerRequestStatus, string> = {
  cooldown: 'pending', queued: 'pending', settling: 'finalized', claimable: 'ok', claimed: '',
}
export const pctText = (v: number | null | undefined): string => v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(2)}%`
