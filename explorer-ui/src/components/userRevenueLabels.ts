// Reader-facing names for User Revenue's custody paths and causes (`via`, see
// api services/userRevenueStreams.ts). A custody path is `<kind>:<id>` segments
// joined by '>'; an unattributed amount's leaf names WHY no user holds it.

const CAUSE_LABEL: Record<string, string> = {
  'omnipool-hub-channel': 'Omnipool hub channel — the part of a sub-pool inflow no position captures',
  'omnipool-protocol-shares': 'Omnipool protocol shares',
  omnipool: 'Positions held in the Omnipool',
  sovereign: "Other chains' sovereign accounts (sibling, child, the relay's Parent) — custody for another chain, not a user",
  'bridge-custody': 'Bridge custody accounts (Snowbridge, the Wormhole relay) — users’ bridged funds in transit, not a user',
  'incentives-unclaimable': 'Lending rewards accrued to a custody contract (a pool, vault or aToken) that none of its claimants can claim',
  'catchup-spread': "Yield that accrued while the token's rate sat flat, spread over that stretch",
  'voting-unrecorded': 'GIGAHDX voting rewards not yet recorded per voter',
  'mm-before-b0': 'Hydrated pool lending income before the money-market anchor (B0)',
  'mm-index-unknown': 'Lending income on an aToken contract while its reserve’s index is not yet known (before its first indexed update)',
  'v3-pool-surplus': 'Uniswap v3 pool contracts’ aToken interest (owned by no position)',
  'owner-unknown': 'Positions whose owner no indexed record names',
  rounding: 'Integer rounding remainders',
  'gamma-vault-fee': 'Gamma vault fee to the Treasury',
  direct: "Protocol accounts' own holdings",
}

// `custody:<id>` remainders: what a custody's resolver could not hand to any claimant.
const CUSTODY_LABEL: Record<string, string> = {
  'atoken-remainder': 'Lending interest no aToken holder’s share covers (no indexed holder claim, or rounding)',
  omnipool: 'Omnipool custody remainder — what no position’s share covers',
  'gamma-vault': 'Gamma vault custody remainder — what no vault share covers',
  lbp: 'LBP custody remainder',
}

const KIND_LABEL: Record<string, string> = {
  atoken: 'aToken',
  stableswap: 'stableswap pool',
  xyk: 'XYK pool',
  'gamma-vault': 'Gamma vault',
  custody: 'custody',
}

// Inside a path the long cause sentences would crowd the row: short names.
const PATH_SHORT: Record<string, string> = {
  omnipool: 'Omnipool',
  'omnipool-protocol-shares': 'Omnipool protocol shares',
  'omnipool-hub-channel': 'Omnipool hub channel',
  'catchup-spread': 'rate catch-up spread over its flat stretch',
  sovereign: "another chain's sovereign account",
  'bridge-custody': 'bridge custody',
  'incentives-unclaimable': 'unclaimable custody rewards',
  'custody:atoken-remainder': 'aToken interest remainder',
}

// `external-rate:<source>`: a token's accrual before its first on-chain rate, read from its issuer's published
// rate (api services/userRevenueTokens.ts EXTERNAL_RATES) — sourced, not measured on Hydration.
const EXTERNAL_RATE_LABEL: Record<string, { long: string; short: string }> = {
  'hastra-nav': {
    long: "Accrual before Hydration had an on-chain rate for the token, at its issuer's NAV (Hastra's Solana vault), anchored to Hydration's first rate",
    short: "issuer's NAV (Hastra, Solana) before Hydration's first rate",
  },
}
const externalRateLabel = (seg: string, form: 'long' | 'short'): string | null => {
  if (!seg.startsWith('external-rate:')) return null
  const src = seg.slice('external-rate:'.length)
  return EXTERNAL_RATE_LABEL[src]?.[form] ?? `external rate (${src.replace(/[-_]/g, ' ')}) before Hydration's first rate`
}

/** One custody segment or cause as text. */
function segmentLabel(seg: string): string {
  if (CAUSE_LABEL[seg]) return CAUSE_LABEL[seg]
  const ext = externalRateLabel(seg, 'long')
  if (ext) return ext
  if (seg.startsWith('unmeasured:')) return `Unmeasured: ${seg.slice(11).replace(/[-_]/g, ' ')}`
  const [kind, ...rest] = seg.split(':')
  const id = rest.join(':')
  if (kind === 'custody') return CUSTODY_LABEL[id] ?? `${id.replace(/-/g, ' ')} custody remainder`
  const k = KIND_LABEL[kind] ?? kind
  if (!id) return k
  return /^0x[0-9a-f]{40}$/i.test(id) ? `${k} ${id.slice(0, 6)}…${id.slice(-4)}` : `${k} #${id}`
}

/** A cause (the leaf of an unattributed or protocol `via`) as a reader names it. */
export const userRevenueCauseLabel = (via: string): string => segmentLabel(via || 'direct')

/** A custody path ('' = held directly) as "via aToken #1001 › Omnipool". */
export function userRevenueViaLabel(via: string): string {
  if (!via) return ''
  return via.split('>').map(seg => PATH_SHORT[seg] ?? externalRateLabel(seg, 'short') ?? segmentLabel(seg)).join(' › ')
}

/**
 * How far the published fold trails the clock, stated once it trails by more
 * than the fold's normal hour-and-a-cycle: User Revenue has no raw tail, so a
 * lagging fold is said out loud rather than shown as a quiet hour.
 */
export function userRevenueLagNote(publishedThrough: string | null | undefined, nowMs = Date.now()): string {
  if (!publishedThrough) return ''
  const behindH = Math.floor((nowMs - Date.parse(publishedThrough)) / 3_600_000)
  if (behindH < 2) return ''
  return behindH < 48 ? ` · ${behindH} h behind the chain` : ` · ${Math.floor(behindH / 24)} days behind the chain`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "breakdowns: UTC days from 5 Sep through 18:00" — the sections' own window, stated once beside the range tabs. */
export function breakdownWindowNote(fromDay: string | null, accountThrough: string | null, accountComplete?: boolean): string | null {
  if (!fromDay || !accountThrough) return null
  const [y, m, d] = fromDay.split('-').map(Number)
  const thisYear = accountThrough.slice(0, 4) === String(y)
  const from = `${d} ${MONTHS[m - 1]}${thisYear ? '' : ` ${y}`}`
  return `breakdowns: UTC days from ${from} through ${accountThrough.slice(11, 16)}${accountComplete === false ? ' · some months not published yet' : ''}`
}
