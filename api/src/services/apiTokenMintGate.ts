import { accountValuePriceHeadTime, getAddress, withAccountValuePrices, type AddressDetail } from './explorerService.ts'

// The Data API token mint gate. Every account gets its own Data API budget, so
// minting needs the account to hold more than DATA_API_MIN_MINT_USD (default
// $1) — otherwise fresh, empty accounts would multiply the budget for free. An
// on-chain identity, a referendum vote or an HDX amount count for nothing here;
// only what the account holds, in USD at current prices. The check runs at
// mint time only: a token already minted is never re-checked on use.
//
// The value is the explorer account page's "Value" headline, from the same
// function (getAddress, summary form, as the hover card reads it): every
// wallet balance, free and reserved (ERC-20 pots and money-market supplied
// aTokens folded in), Omnipool / Stableswap / XYK / Uniswap v3 LP positions,
// and claimable farm and money-market rewards, across the account's related
// forms (its EVM binding and truncated-H160 pot) — minus money-market debt, as
// the page nets it. An asset without a current price counts as $0.
//
// It fails closed: if the value cannot be read (a ClickHouse error, no price
// generation loaded, or prices older than MINT_PRICE_MAX_AGE_S) the mint is
// refused as retryable rather than allowed.

export const DEFAULT_MIN_MINT_USD = 1
export const MINT_PRICE_MAX_AGE_S = 30 * 60

/** Valuation could not be computed now; the caller refuses the mint as retryable. */
export class MintValuationUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MintValuationUnavailable'
  }
}

/**
 * DATA_API_MIN_MINT_USD: a finite, non-negative USD amount; unset or empty is
 * the default. A malformed value stops the start, like ADMIN_ACCOUNT_IDS — a
 * typo must not silently open or close the gate.
 */
export function parseMinMintUsd(value: string | undefined): number {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return DEFAULT_MIN_MINT_USD
  const parsed = Number(trimmed)
  if (!/^\d+(\.\d+)?$/.test(trimmed) || !Number.isFinite(parsed)) {
    throw new Error(`DATA_API_MIN_MINT_USD must be a non-negative USD amount, received ${JSON.stringify(value)}`)
  }
  return parsed
}

/** The account page's net value: gross holdings minus every non-custody market's debt (explorer-ui moneyMarketDebtUsd). */
export function netAccountValueUsd(detail: Pick<AddressDetail, 'portfolioUsd' | 'moneyMarket'>): number {
  const debt = detail.moneyMarket.reduce((total, market) => total + (market.custody ? 0 : Number(market.totalDebtBase) / 1e8), 0)
  return detail.portfolioUsd - debt
}

/** The account's current value in USD, or MintValuationUnavailable. */
export async function mintHoldingsUsd(accountId: string, nowMs = Date.now()): Promise<number> {
  // One price generation for the freshness check and the valuation alike.
  return withAccountValuePrices(async () => {
    const headTime = await accountValuePriceHeadTime()
    if (headTime == null) throw new MintValuationUnavailable('no price generation loaded')
    if (nowMs / 1000 - headTime > MINT_PRICE_MAX_AGE_S) throw new MintValuationUnavailable('prices are stale')
    const detail = await getAddress(accountId, { summary: true })
    if (!detail) throw new MintValuationUnavailable('account not resolvable')
    const usd = netAccountValueUsd(detail)
    if (!Number.isFinite(usd)) throw new MintValuationUnavailable('value not finite')
    return usd
  })
}
