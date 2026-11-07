// The bond families the explorer has a page for — the api's bonds.ts BOND_FAMILIES,
// mirrored (the UI does not import the api; tests/bonds-page.test.tsx pins the routes).
// Every per-family surface derives from it: the route (/<key>-bonds), the nav entry,
// the app link.
export interface BondFamilyUi { key: string; title: string; appUrl: string | null }
export const BOND_FAMILIES_UI: readonly BondFamilyUi[] = [
  { key: 'hollar', title: 'HOLLAR Bonds', appUrl: 'https://app.hydration.net/strategies/hollar-bonds' },
]
export const bondFamilyUi = (key: string): BondFamilyUi | undefined => BOND_FAMILIES_UI.find(f => f.key === key)
