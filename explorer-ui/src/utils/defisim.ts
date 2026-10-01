export function defisimAccountTarget(account: { accountId: string; address: string } | null, fallback?: string | null): string | undefined {
  if (!account) return fallback ?? undefined
  // DefiSim expects an H160 for EVM accounts; substrate accounts use the raw
  // AccountId32 understood by its chain RPC layer.
  return /^0x[0-9a-f]{40}$/i.test(account.address) ? account.address : account.accountId
}

const DEFISIM_ORIGIN = 'https://defisim.neckwork.net'

// The explorer's market keys → DefiSim's market ids. DefiSim simulates each
// isolated market on its own, so a link names the market it is about; without
// one DefiSim opens whichever market holds the largest collateral.
const DEFISIM_MARKET: Record<string, string> = {
  core: 'HYDRATION_MAIN',
  gigahdx: 'HYDRATION_GIGAHDX',
  bil: 'HYDRATION_BIL',
}

/** Whether DefiSim can simulate this market (it knows the market's id). */
export const defisimSupportsMarket = (marketKey: string): boolean => marketKey in DEFISIM_MARKET

/** DefiSim deep link for an account, opened on one market when given. */
export function defisimUrl(address: string, marketKey?: string): string {
  const market = marketKey ? DEFISIM_MARKET[marketKey] : undefined
  return `${DEFISIM_ORIGIN}/?address=${encodeURIComponent(address)}${market ? `&market=${market}` : ''}`
}
