import type { ToolDefinition } from './toolTypes.ts'
import { searchTools } from './tools/search.ts'
import { inspectEntityTools } from './tools/inspectEntity.ts'
import { activityTools } from './tools/activity.ts'
import { accountTools } from './tools/account.ts'
import { assetTools } from './tools/assets.ts'
import { poolTools } from './tools/pools.ts'
import { moneyMarketTools } from './tools/moneyMarket.ts'
import { governanceTools } from './tools/governance.ts'
import { networkTools } from './tools/network.ts'
import { protocolTools } from './tools/protocol.ts'

// The registered surface, in the order a client sees it. The order is the order
// an agent should reach for them: the two entry points that answer "what is
// this?", then the feed, then the per-entity readings, then the protocol-wide
// dashboards. A new tool is added to its module and to EXPECTED_TOOL_NAMES in
// the same change — nowhere else.
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  ...searchTools,
  ...inspectEntityTools,
  ...activityTools,
  ...accountTools,
  ...assetTools,
  ...poolTools,
  ...moneyMarketTools,
  ...governanceTools,
  ...networkTools,
  ...protocolTools,
]

// The thirteen names the design pins (spec § 3), in registration order. It is
// the contract a client codes against, so it is declared here rather than
// derived from whatever happens to be registered.
export const EXPECTED_TOOL_NAMES: readonly string[] = [
  'search',
  'inspect_entity',
  'get_activity',
  'get_account',
  'get_account_history',
  'list_accounts',
  'list_assets',
  'get_asset',
  'get_pools',
  'get_money_market',
  'get_governance',
  'get_network_status',
  'get_protocol_stats',
]
