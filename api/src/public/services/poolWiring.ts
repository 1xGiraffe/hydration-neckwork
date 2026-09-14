import type { ClickHouseClient } from '../../db/client.ts'
import { initPoolService } from '../../services/poolService.ts'

// The one sanctioned transitive coupling between the public API and the
// explorer's read models (AGENTS.md § Public API): `poolService` keeps its
// ClickHouse handle in module state, set once by whichever process uses it, and
// the public API is a separate process — so it wires the handle on first use
// rather than duplicating the pool composition model. The coupling stays
// NON-CLOBBERING on the other side: `initPoolService` installs an explorerService
// client only when none is set, and that guard is documented where it lives.
//
// This lives in its own leaf because several public surfaces need it (the pool
// routes, the CoinGecko facade, the platform and homepage stats). Two copies
// would carry two independent "already wired" flags over one module global, so
// each would re-wire what the other had just installed.

let wiredClient: ClickHouseClient | null = null

/** Point `poolService` at this client, unless it is already pointed at it. */
export function ensurePoolService(client: ClickHouseClient): void {
  if (wiredClient === client) return
  initPoolService(client)
  wiredClient = client
}
