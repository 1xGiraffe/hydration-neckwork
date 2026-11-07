// The bond families the explorer has a page for — the api's bonds.ts BOND_FAMILIES,
// mirrored (the UI does not import the api; tests/bonds-page.test.tsx pins the routes).
// Every per-family surface derives from it: the route (/<key>-bonds), the nav entry,
// the app link.
export interface BondFamilyUi {
  key: string; title: string; appUrl: string | null
  /** A family sold through LBPs: what they took — the page's copy before its dashboard arrives. */
  lbpPayment?: string
}
export const BOND_FAMILIES_UI: readonly BondFamilyUi[] = [
  { key: 'hollar', title: 'HOLLAR Bonds', appUrl: 'https://app.hydration.net/strategies/hollar-bonds' },
  // Sold for DOT through LBPs in 2023–2024; the app no longer lists them.
  { key: 'hdx', title: 'HDX Bonds', appUrl: null, lbpPayment: 'DOT' },
]
export const bondFamilyUi = (key: string): BondFamilyUi | undefined => BOND_FAMILIES_UI.find(f => f.key === key)
