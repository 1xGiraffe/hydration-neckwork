import type { Route } from '../router'
import { paths } from '../router'
import { DATA_API_URL, PREIS_URL } from '../surfaces'

// Navigation: direct links plus dropdown groups. A group's trigger navigates
// to its primary page (Chain → Blocks, Assets → Assets) while hovering/focusing
// reveals the rest; `menuItems` orders the dropdown independently of the
// trigger/highlight `items`. Every route is still reachable so deep links /
// bookmarks keep working.
// `external` marks a destination outside this app: `to` is then an absolute URL
// rather than a route, it can never be the active entry, and it is rendered as
// a real anchor that opens in a new window and says so first.
export type NavItem = { to: string; label: string; match: Route['name'][]; external?: true }
export type NavGroup = { label: string; items: NavItem[]; menuItems?: NavItem[] }
const IT = {
  activity: { to: paths.activity(), label: 'Activity', match: ['activity'] } as NavItem,
  accounts: { to: paths.accounts(), label: 'Accounts', match: ['accounts', 'account', 'lists', 'list'] } as NavItem,
  // The tag routes moved off `accounts` and onto their own entry: the group below
  // still highlights for either, and inside the menu only the entry a reader is
  // actually on lights up.
  tags: { to: paths.tags(), label: 'Tags', match: ['tags', 'tags-hydration', 'tag'] } as NavItem,
  assets: { to: paths.assets(), label: 'Assets', match: ['assets', 'asset', 'holders'] } as NavItem,
  // Pools live under Liquidity, so a pool or the Omnipool highlights there.
  liquidity: { to: paths.liquidity(), label: 'Liquidity', match: ['liquidity', 'pool', 'omnipool'] } as NavItem,
  hdx: { to: paths.hdx(), label: 'HDX', match: ['hdx'] } as NavItem,
  hollar: { to: paths.hollar(), label: 'HOLLAR', match: ['hollar'] } as NavItem,
  // /ice (ICE dashboard) is deliberately URL-only until the venue has live activity — no nav entry yet.
  volume: { to: paths.volume(), label: 'Volume', match: ['volume'] } as NavItem,
  oracles: { to: paths.oracles(), label: 'Oracles', match: ['oracles', 'oracle'] } as NavItem,
  // The overview alone: inside the Revenue menu only the page a reader is on
  // lights up, while the group's trigger highlights for all three.
  revenue: { to: paths.revenue(), label: 'Revenue', match: ['revenue'] } as NavItem,
  revenueUsers: { to: paths.revenueUsers(), label: 'User Revenue', match: ['revenueUsers'] } as NavItem,
  revenueProtocol: { to: paths.revenueProtocol(), label: 'Protocol Revenue', match: ['revenueProtocol'] } as NavItem,
  blocks: { to: paths.blocks(), label: 'Blocks', match: ['blocks', 'block'] } as NavItem,
  extrinsics: { to: paths.extrinsics(), label: 'Extrinsics', match: ['extrinsics', 'extrinsic'] } as NavItem,
  events: { to: paths.events(), label: 'Events', match: ['events', 'event'] } as NavItem,
  contracts: { to: paths.contracts(), label: 'Contracts', match: ['contracts'] } as NavItem,
  security: { to: paths.security(), label: 'Security', match: ['security'] } as NavItem,
  governance: { to: paths.governance(), label: 'Governance', match: ['governance', 'referendum'] } as NavItem,
  // Getting started with the MCP server. It sits in the Chain menu because
  // that is where this app already keeps the destinations that are about the
  // explorer itself rather than about one entity.
  mcp: { to: paths.mcp(), label: 'MCP', match: ['mcp'] } as NavItem,
  // The Data API's own docs portal, for the same reason MCP sits here: it is
  // about the explorer rather than about one entity. Its own host, so it leaves
  // the Explorer and the entry says so.
  dataApi: { to: `${DATA_API_URL}/docs`, label: 'Data API', match: [], external: true } as NavItem,
  // Preis charts the same pairs the Assets list prices, which is why it sits in
  // the Assets menu — but it is a separate app on its own host, so it leaves
  // the Explorer and the entry says so. Labelled for what it IS to a reader
  // rather than for the app's name, which means nothing from this side.
  preis: { to: PREIS_URL, label: 'Charts', match: [], external: true } as NavItem,
}
// Liquidity, Volume and Oracles live under Assets at every width; the trigger navigates
// to Assets so the menu lists only the destinations it is not. Security leads the Chain menu (it is the
// entry a returning operator wants first) while the trigger keeps Blocks.
const ASSETS_GROUP: NavGroup = { label: 'Assets', items: [IT.assets, IT.liquidity, IT.volume, IT.oracles], menuItems: [IT.liquidity, IT.volume, IT.oracles, IT.preis] }
// Same shape as Assets: the trigger still goes to Accounts (items[0]), and the
// menu lists only the destination the trigger is not. Tags used to be reachable
// only from a link on the accounts page itself, which is a place you have to
// already be in order to leave.
const ACCOUNTS_GROUP: NavGroup = { label: 'Accounts', items: [IT.accounts, IT.tags], menuItems: [IT.tags] }
// Same shape again: the trigger goes to the /revenue overview (items[0]) and
// the menu lists the two breakdown pages it is not.
const REVENUE_GROUP: NavGroup = { label: 'Revenue', items: [IT.revenue, IT.revenueUsers, IT.revenueProtocol], menuItems: [IT.revenueUsers, IT.revenueProtocol] }
const CHAIN_GROUP: NavGroup = {
  label: 'Chain',
  items: [IT.blocks, IT.extrinsics, IT.events, IT.contracts, IT.security, IT.governance, IT.dataApi, IT.mcp],
  menuItems: [IT.security, IT.governance, IT.blocks, IT.extrinsics, IT.events, IT.contracts, IT.dataApi, IT.mcp],
}
// Mid-width fold (861–1119px, CSS-gated): HDX/HOLLAR and the Assets and
// Revenue groups collapse into this single wider Assets dropdown so the topbar
// search keeps a usable width. Direct links carry .nav-fold and hide in that
// window; the permanent Assets and Revenue groups carry .nav-unfold-group and
// hide there too; this group is hidden everywhere else.
export const FOLDABLE = new Set(['HDX', 'HOLLAR'])
const ASSETS_FOLD_GROUP: NavGroup = {
  label: 'Assets',
  items: [IT.assets, IT.liquidity, IT.volume, IT.oracles, IT.hdx, IT.hollar, IT.revenue, IT.revenueUsers, IT.revenueProtocol],
  menuItems: [IT.liquidity, IT.volume, IT.oracles, IT.hdx, IT.hollar, IT.revenue, IT.revenueUsers, IT.revenueProtocol, IT.preis],
}
// The desktop nav in visual order; the drawer keeps every destination flat.
export const NAV_ENTRIES: Array<{ kind: 'link'; item: NavItem } | { kind: 'group'; group: NavGroup; fold?: 'only' | 'hidden' }> = [
  { kind: 'link', item: IT.activity },
  { kind: 'group', group: ACCOUNTS_GROUP },
  { kind: 'group', group: ASSETS_GROUP, fold: 'hidden' },
  { kind: 'link', item: IT.hdx },
  { kind: 'link', item: IT.hollar },
  { kind: 'group', group: REVENUE_GROUP, fold: 'hidden' },
  { kind: 'group', group: ASSETS_FOLD_GROUP, fold: 'only' },
  { kind: 'group', group: CHAIN_GROUP },
]
export const DRAWER_LINKS: NavItem[] = [IT.activity, IT.accounts, IT.tags, IT.assets, IT.liquidity, IT.volume, IT.oracles, IT.preis, IT.hdx, IT.hollar, IT.revenue, IT.revenueUsers, IT.revenueProtocol]
export const DRAWER_GROUPS: NavGroup[] = [CHAIN_GROUP]
/** The nav's destination lists, for tests (rendering the bar needs a document). */
export const NAV_CONFIG = { ASSETS_GROUP, ASSETS_FOLD_GROUP, REVENUE_GROUP, DRAWER_LINKS, NAV_ENTRIES }
