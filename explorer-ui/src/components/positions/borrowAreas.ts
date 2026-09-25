import type { AccountMoneyMarket, MoneyMarketPosition } from '../../types'
import type { BorrowArea } from './BorrowTab'

// A tag's areas: one per member holding a position (moneyMarketByAccount, the
// API's per-member split), ordered as the API ranks them. Only when that split
// is absent does the tag-wide aggregate stand in, as a single area.
export function tagBorrowAreas(byAccount: AccountMoneyMarket[] | undefined, aggregate: MoneyMarketPosition[]): BorrowArea[] {
  if (byAccount?.length) return byAccount.map(e => ({ address: e.account.address, account: e.account, markets: e.markets, defisimAddress: e.account.address }))
  return aggregate.length ? [{ address: '', markets: aggregate }] : []
}
