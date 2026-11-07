import type { BilRequestStatus } from '../../types'
import { paths } from '../../router'

// A BIL redemption request's state as the BIL page and the Strategies tab both word it.
export const BIL_STATUS_LABEL: Record<BilRequestStatus, string> = {
  queued: 'In queue', 'partly-settled': 'Partly settled', claimable: 'Claim ready', claimed: 'Claimed', cancelled: 'Cancelled',
}
export const BIL_STATUS_TONE: Record<BilRequestStatus, string> = {
  queued: 'pending', 'partly-settled': 'finalized', claimable: 'ok', claimed: '', cancelled: '',
}

/** A redemption request's row on the BIL page (the page turns to the request's page, then scrolls to it). */
export const bilRequestHref = (requestId: number): string => `${paths.bil()}#bil-request-${requestId}`
