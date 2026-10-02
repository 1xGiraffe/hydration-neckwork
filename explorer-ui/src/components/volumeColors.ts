// One colour and one label per trading venue, shared by every volume chart,
// legend, share bar and table so a venue reads as the same thing everywhere.
// Colours are theme tokens (--vol-*, global.css), taken from the validated
// categorical reference palette and checked with the dataviz palette validator in
// BOTH themes, in the stack order below: adjacent pairs clear ΔE 8 under
// deutan/protan/tritan simulation and 15 for normal vision (light: worst CVD 9.1,
// dark: 8.4). Reordering VENUE_ORDER re-opens that check.

export type Venue = 'omnipool' | 'stableswap' | 'xyk' | 'otc' | 'uniswapv3' | 'hsm' | 'lbp'

/** Stacking/legend order, bottom-up, fixed and never cycled. */
export const VENUE_ORDER: Venue[] = ['omnipool', 'stableswap', 'xyk', 'otc', 'uniswapv3', 'hsm', 'lbp']

export const VENUE_LABEL: Record<Venue, string> = {
  omnipool: 'Omnipool',
  stableswap: 'Stableswap',
  xyk: 'XYK',
  otc: 'OTC',
  uniswapv3: 'Uniswap v3',
  hsm: 'HSM',
  lbp: 'LBP',
}

export const VENUE_COLOR: Record<Venue, string> = {
  omnipool: 'var(--vol-omnipool)',
  stableswap: 'var(--vol-stableswap)',
  xyk: 'var(--vol-xyk)',
  otc: 'var(--vol-otc)',
  uniswapv3: 'var(--vol-uniswapv3)',
  hsm: 'var(--vol-hsm)',
  lbp: 'var(--vol-lbp)',
}

export function isVenue(v: string): v is Venue {
  return (VENUE_ORDER as string[]).includes(v)
}
export const venueLabel = (v: string): string => (isVenue(v) ? VENUE_LABEL[v] : v)
export const venueColor = (v: string): string => (isVenue(v) ? VENUE_COLOR[v] : 'var(--chart-neutral)')
