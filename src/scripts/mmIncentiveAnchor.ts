// The logic of the money-market incentive ANCHOR (captured by the anchors loop,
// anchorLoop.ts; manual modes snapshot-mm-incentive-anchors.ts), kept free of any
// connection so it can be exercised with fakes.
//
// The Aave v3 RewardsController's per-user accrual is restated from its logs as
// Σ Accrued.rewardsAccrued − Σ RewardsClaimed.amount, which is exact only from a
// point where the logs are complete: EVM-log coverage before the aToken anchor
// block B0 is partial, and a user's stored accrual at B0 is invisible to any log
// after it (measured: 0x28251ad7… lacks exactly 20399441641438 GDOT — the chain's
// accrual at B0 — while holding no incentivized aToken there). So the chain's own
// state at B0 is read and stored, the atoken_scaled_anchor way:
//
//   user, asset = ''  → getUserAccruedRewards(user, reward)
//   user, asset       → getUserAssetIndex(user, asset, reward)
//   '',   asset       → getRewardsData(asset, reward).index
//
// for every reward / programme that existed at B0. Never derived: each value is
// what the view returned at B0. A zero is not stored (a missing row reads as 0).
//
// Captured whole once and then TOPPED UP every cycle (incentiveKeysToRead), the
// aToken anchor's way: a candidate user the sources name since the last capture
// that has no row is read at B0. The candidate sources are log-fed and the logs
// before B0 are partial, so a user whose every pre-B0 log fell in a gap — measured
// at B0: 18 users, some holding an unclaimed accrual to this day — is named only
// once a source that does not share the gap (the Substrate legs of the registry
// asset over the aToken) is read, and is then anchored the cycle after — never
// left out for good.

import { blockTag, padAddress, parseUint, type AnchorMode, type EthCall, type EthCallRequest } from './atokenAnchor.js'

export const REWARDS_CONTROLLER = '0x7472a3d0891df2401d981a5954d07e364f05060f'

export const INCENTIVE_SEL = {
  getUserAccruedRewards: 'b022418c',
  getUserAssetIndex: '533f542a',
  getRewardsData: '7eff4ba8',
} as const

export const INCENTIVE_TOPIC = {
  accrued: '0x3303facd24627943a92e9dc87cfbb34b15c49b726eec3ad3487c16be9ab8efe8',
  rewardsClaimed: '0xc052130bc4ef84580db505783484b067ea8b71b3bca78a7e12db7aea8658f004',
  assetConfigUpdated: '0xac1777479f07f3e7c34da8402139d54027a6a260caaae168bdee825ca5580dc5',
} as const

export interface Programme { asset: string; reward: string }

export interface IncentiveAnchorRow {
  user_address: string
  asset_address: string
  reward_address: string
  value: string
  anchor_block: number
}

export type IncentiveAnchorKey = Pick<IncentiveAnchorRow, 'user_address' | 'asset_address' | 'reward_address'>

/** The read that states one anchor row. */
export function anchorCall(row: IncentiveAnchorKey, controller = REWARDS_CONTROLLER): EthCallRequest {
  const { user_address: user, asset_address: asset, reward_address: reward } = row
  if (user === '' && asset !== '') return { to: controller, data: `0x${INCENTIVE_SEL.getRewardsData}${padAddress(asset)}${padAddress(reward)}` }
  if (user !== '' && asset === '') return { to: controller, data: `0x${INCENTIVE_SEL.getUserAccruedRewards}${padAddress(user)}${padAddress(reward)}` }
  if (user !== '' && asset !== '') return { to: controller, data: `0x${INCENTIVE_SEL.getUserAssetIndex}${padAddress(user)}${padAddress(asset)}${padAddress(reward)}` }
  throw new Error('an anchor row names a user or an asset')
}

/** The stated value of a view's return: the first word (getRewardsData returns index first). */
export function anchorValue(hex: string): bigint | null {
  if (hex === '0x' || hex === '') return null
  return parseUint('0x' + hex.slice(2, 66))
}

/** Every key the anchor reads at B0: programme indexes, then per user one accrual per reward and one index per programme. */
export function anchorKeys(users: string[], programmes: Programme[]): IncentiveAnchorKey[] {
  const rewards = [...new Set(programmes.map(p => p.reward))].sort()
  const keys: IncentiveAnchorKey[] = []
  for (const p of programmes) keys.push({ user_address: '', asset_address: p.asset, reward_address: p.reward })
  for (const user of users) {
    for (const reward of rewards) keys.push({ user_address: user, asset_address: '', reward_address: reward })
    for (const p of programmes) keys.push({ user_address: user, asset_address: p.asset, reward_address: p.reward })
  }
  return keys
}

/** What the table already holds, at the grain a capture reads: users with any row, programmes (`${asset}|${reward}`) with an index row. */
export interface AnchoredIncentiveKeys { users: ReadonlySet<string>; programmes: ReadonlySet<string> }

export const NOTHING_ANCHORED: AnchoredIncentiveKeys = { users: new Set(), programmes: new Set() }

/**
 * The keys one cycle reads, normalised (lowercased, H160-shaped, deduplicated,
 * sorted). A full capture reads every key (anchorKeys); a top-up reads the
 * programme rows the table lacks and every key of each user the table holds NO row
 * for. The grain is the user, not the key: a capture reads a user's keys together
 * (one accrual per reward, one index per programme, and the programmes at B0 are
 * fixed once the controller's logs are in), so a user with any row was read whole.
 * A user with none either read zero everywhere — a post-B0 user, re-read at one
 * call per key, the aToken top-up's rule — or was never a candidate: one the
 * sources name since the last capture, which is what the top-up is for.
 */
export function incentiveKeysToRead(users: readonly string[], programmes: readonly Programme[], anchored: AnchoredIncentiveKeys, mode: AnchorMode): IncentiveAnchorKey[] {
  const normUsers = [...new Set(users.map(u => u.toLowerCase()))].filter(u => /^0x[0-9a-f]{40}$/.test(u)).sort()
  const keys = anchorKeys(normUsers, programmes.map(p => ({ asset: p.asset.toLowerCase(), reward: p.reward.toLowerCase() })))
  if (mode === 'full') return keys
  return keys.filter(k => (k.user_address === '' ? !anchored.programmes.has(`${k.asset_address}|${k.reward_address}`) : !anchored.users.has(k.user_address)))
}

/**
 * Read the given anchor keys at `anchorBlock` and keep the non-zero values. An
 * empty return (a reverted view) throws: the controller existed at B0 for every
 * programme passed in, so an empty answer is a failed read, not a zero.
 */
export async function readIncentiveAnchorKeys(keys: readonly IncentiveAnchorKey[], anchorBlock: number, ethCall: EthCall, controller = REWARDS_CONTROLLER): Promise<IncentiveAnchorRow[]> {
  if (!keys.length) return []
  const results = await ethCall(keys.map(k => anchorCall(k, controller)), blockTag(anchorBlock))
  const rows: IncentiveAnchorRow[] = []
  keys.forEach((key, i) => {
    const value = anchorValue(results[i])
    if (value == null) throw new Error(`[mm-incentive-anchor] empty return for ${key.user_address || "''"}/${key.asset_address || "''"}/${key.reward_address} at ${anchorBlock}`)
    if (value > 0n) rows.push({ ...key, value: value.toString(), anchor_block: anchorBlock })
  })
  return rows
}

/** A full capture: every anchor key of every user and programme, read at `anchorBlock`. */
export async function readIncentiveAnchor(users: string[], programmes: Programme[], anchorBlock: number, ethCall: EthCall, controller = REWARDS_CONTROLLER): Promise<IncentiveAnchorRow[]> {
  return readIncentiveAnchorKeys(incentiveKeysToRead(users, programmes, NOTHING_ANCHORED, 'full'), anchorBlock, ethCall, controller)
}

export interface IncentiveVerifyResult {
  checked: number
  matched: number
  mismatches: Array<{ user_address: string; asset_address: string; reward_address: string; anchor: string; chain: string | null; anchor_block: number }>
}

/** Re-read every stored row at its own anchor block and compare. */
export async function verifyIncentiveAnchor(rows: IncentiveAnchorRow[], ethCall: EthCall, controller = REWARDS_CONTROLLER): Promise<IncentiveVerifyResult> {
  const byBlock = new Map<number, IncentiveAnchorRow[]>()
  for (const r of rows) {
    const list = byBlock.get(Number(r.anchor_block)) ?? []
    list.push(r)
    byBlock.set(Number(r.anchor_block), list)
  }
  const mismatches: IncentiveVerifyResult['mismatches'] = []
  for (const [block, group] of byBlock) {
    const results = await ethCall(group.map(r => anchorCall(r, controller)), blockTag(block))
    group.forEach((row, i) => {
      const chain = anchorValue(results[i])
      if (chain == null || chain !== BigInt(row.value)) {
        mismatches.push({ user_address: row.user_address, asset_address: row.asset_address, reward_address: row.reward_address, anchor: String(row.value), chain: chain == null ? null : chain.toString(), anchor_block: block })
      }
    })
  }
  return { checked: rows.length, matched: rows.length - mismatches.length, mismatches }
}

/**
 * The lowest block the controller's logs must be indexed from before a first
 * capture: the backfill low-water, just below the controller's first log
 * (its Initialized/first AssetConfigUpdated at 7,346,897; first Accrued 7,347,162).
 * The candidate set is read from those logs, so capturing on a partial backfill
 * would anchor too few users; later cycles top the table up with the candidates
 * the sources name since (incentiveKeysToRead), but the full capture is the one
 * that reads them all at once.
 */
export const CONTROLLER_LOGS_FROM = 7_346_900
