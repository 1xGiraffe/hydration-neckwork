import { F } from '../components/ui'
import type { CloseAccountReason } from '../types'

export function closeAccountReasonText(reason: CloseAccountReason): string {
  if (reason.type === 'direct_transfers') {
    const transfers = `${F.int(reason.count)} direct transfer${reason.count === 1 ? '' : 's'}`
    const days = `${F.int(reason.days)} day${reason.days === 1 ? '' : 's'}`
    const value = reason.valueUsd == null ? '' : ` · ${F.usd(reason.valueUsd)}`
    return `${transfers}${value} across ${days}${reason.bidirectional ? ' · both directions' : ''}`
  }
  if (reason.type === 'near_signing') {
    return `Signed near each other on ${F.int(reason.days)} distinct day${reason.days === 1 ? '' : 's'}`
  }
  return `Shared ${reason.name} deposit address`
}
