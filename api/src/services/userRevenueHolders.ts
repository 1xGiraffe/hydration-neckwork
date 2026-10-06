// Which User Revenue holder class an account (or a directory row of accounts)
// belongs to, for a SURFACE that has to say whether a figure is about a user at
// all. The fold (userRevenueWindow.ts) classes every fact it books; an account
// it books nothing for still needs an answer, because "$0 earned" on the
// Treasury, a pallet pot or a pool reads as a user who earned nothing rather
// than as an account User Revenue does not describe.
//
// The answer is the fold's own: the custodies first (a pool's account is a
// pallet account, but a pool row is a pool), then `holderClassOf` (other chains'
// treasuries, bridge custodies, sovereigns, pallet and tagged protocol
// accounts). The custodies are what its registry passes through or books as
// unattributed — the Omnipool, stableswap and XYK pool accounts, the
// money market's contracts (aTokens pass their income to suppliers; debt tokens
// and pool proxies hold none), Uniswap v3 pools and vaults, LBP pools and the
// redemption escrows (a token contract holding its units under redemption
// requests passes their accrual to the requesters). A
// custody is classed `unattributed`: what it earns belongs to its claimants, and
// whatever it keeps is booked unattributed under a named `via`.
//
// Read only by the explorer's directory enrichment, cached: every source is a
// small registry except the stableswap fee-leg scan (~0.1 s), and all of them
// move with pool creation, not per block.

import type { ClickHouseClient } from '../db/client.ts'
import { inChunkedSql } from '../db/queryParams.ts'
import { cachedSwr } from './cache.ts'
import { loadProtocolHolders, userRevenueRows as rows } from './userRevenueFold.ts'
import { loadStableswapPools, loadXykPools, OMNIPOOL_ACCOUNT } from './userRevenueLp.ts'
import { loadMmContracts } from './userRevenueMm.ts'
import { REDEMPTION_ESCROWS } from './userRevenueTokens.ts'
import {
  MODL_ETH_MAPPED_PREFIX, MODL_PREFIX, PARA_SOVEREIGN_PREFIX, PARENT_SOVEREIGN_ACCOUNT, PROTOCOL_FIXED_ACCOUNTS, SIBLING_SOVEREIGN_PREFIX,
  ethMappedAccount, holderClassOf, type HolderClass, type HolderSets,
} from './userRevenueStreams.ts'

export interface HolderClassifier {
  classOf(account: string): HolderClass
}

const CLASSIFIER_FRESH_MS = 30 * 60_000
const CLASSIFIER_STALE_MS = 6 * 3_600_000

/**
 * Pure: a classifier over the fold's holder sets and a custody set (lowercase).
 * A custody is checked FIRST: the Omnipool's and the pools' accounts are pallet
 * (`modl`) accounts, and a pool row reads as a pool (its income belongs to its
 * claimants), never as the protocol's balance sheet.
 */
export function holderClassifier(sets: ReadonlySet<string> | HolderSets, custody: ReadonlySet<string>): HolderClassifier {
  return {
    classOf(account: string): HolderClass {
      const a = account.toLowerCase()
      if (custody.has(a)) return 'unattributed'
      return holderClassOf(a, sets)
    },
  }
}

/**
 * A directory row's class from its accounts: `user` as soon as one account is a
 * user (a tag mixing a user with a pot is still about a user), else `protocol`
 * when any account is the protocol's, else `unattributed`. Undefined for a row
 * with no accounts.
 */
export function rowHolderClass(accounts: readonly string[], classifier: HolderClassifier): HolderClass | undefined {
  if (!accounts.length) return undefined
  let protocol = false
  for (const a of accounts) {
    const cls = classifier.classOf(a)
    if (cls === 'user') return 'user'
    if (cls === 'protocol') protocol = true
  }
  return protocol ? 'protocol' : 'unattributed'
}

/** The classifier's inputs: the fold's tag sets and the custody set (lowercase). */
export interface HolderClassInputs { sets: HolderSets; custody: Set<string> }

export async function loadHolderClassifier(client: ClickHouseClient): Promise<HolderClassifier> {
  const { sets, custody } = await loadHolderClassInputs(client)
  return holderClassifier(sets, custody)
}

/**
 * The same rule as SQL over an account expression, for a ranking that must tier
 * non-user rows apart: 1 when the account is a `user`, else 0. Bind the returned
 * params (`urUser_<i>`, `urNonUser_<i>`) with the query.
 *
 * The non-user set grows with every pool, vault and tagged pot (877 accounts,
 * ~64 KiB encoded in October 2026 — half the server's per-parameter ceiling), so
 * both sets travel as byte-bounded chunks (inChunkedSql) rather than one
 * parameter each; the rule itself stays defined here, once.
 */
export async function holderIsUserSql(client: ClickHouseClient, expr: string): Promise<{ sql: string; params: Record<string, string[]>; urUser: string[]; urNonUser: string[] }> {
  const { sets, custody } = await loadHolderClassInputs(client)
  const nonUser = new Set<string>([...custody, ...sets.protocol, ...(sets.custody ?? []), ...PROTOCOL_FIXED_ACCOUNTS])
  for (const u of sets.user ?? []) nonUser.delete(u)
  const a = `lower(${expr})`
  const prefixes = [MODL_PREFIX, MODL_ETH_MAPPED_PREFIX, SIBLING_SOVEREIGN_PREFIX, PARA_SOVEREIGN_PREFIX].map(p => `startsWith(${a}, '${p}')`).join(' OR ')
  const urUser = [...(sets.user ?? [])].filter(u => !custody.has(u)).sort()
  const urNonUser = [...nonUser].sort()
  const isUser = inChunkedSql(a, 'urUser', urUser)
  const isNonUser = inChunkedSql(a, 'urNonUser', urNonUser)
  return {
    // Custodies and tags first (a pool account is a modl account; a foreign treasury may sit on a sovereign prefix).
    sql: `toUInt8(NOT ${isNonUser.sql} AND (${isUser.sql} OR NOT (${prefixes} OR ${a} = '${PARENT_SOVEREIGN_ACCOUNT}')))`,
    params: { ...isUser.params, ...isNonUser.params },
    urUser,
    urNonUser,
  }
}

async function loadHolderClassInputs(client: ClickHouseClient): Promise<HolderClassInputs> {
  return cachedSwr('user-revenue:holder-class-inputs', CLASSIFIER_FRESH_MS, CLASSIFIER_STALE_MS, async () => {
    const [protocol, contracts, ssPools, xykPools, v3Pools, v3Vaults, lbp] = await Promise.all([
      loadProtocolHolders(client),
      loadMmContracts(client),
      loadStableswapPools(client),
      loadXykPools(client),
      rows<{ a: string }>(client, 'SELECT DISTINCT lower(pool_address) AS a FROM price_data.uniswap_v3_pools FINAL', {}, 'ur:holders-v3-pools'),
      rows<{ a: string }>(client, 'SELECT DISTINCT lower(vault_address) AS a FROM price_data.uniswap_v3_vaults FINAL', {}, 'ur:holders-v3-vaults'),
      rows<{ a: string }>(client, "SELECT DISTINCT lower(account_id) AS a FROM price_data.account_tags FINAL WHERE deleted = 0 AND label_id = 'lbp-pools'", {}, 'ur:holders-lbp'),
    ])
    const custody = new Set<string>([OMNIPOOL_ACCOUNT])
    for (const p of ssPools) custody.add(p.account)
    for (const p of xykPools) custody.add(p.account)
    for (const c of contracts) {
      custody.add(ethMappedAccount(c.contract))
      if (c.pool) custody.add(ethMappedAccount(c.pool))
    }
    for (const { a } of v3Pools) custody.add(ethMappedAccount(a))
    for (const { a } of v3Vaults) custody.add(ethMappedAccount(a))
    for (const { a } of lbp) custody.add(a)
    for (const e of REDEMPTION_ESCROWS) custody.add(ethMappedAccount(e.contract))
    return { sets: { protocol: protocol.set, user: protocol.user, custody: protocol.custody }, custody }
  })
}
