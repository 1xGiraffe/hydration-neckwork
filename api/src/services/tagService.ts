import type { ClickHouseClient } from '../db/client.ts'
import { normalizeAddress } from './addressIdentity.ts'
import { accountIcon } from './omniwatchIdentity.ts'
import { blake2AsU8a } from '@polkadot/util-crypto'
import { u8aToHex } from '@polkadot/util'

// Address tags. The whole tag set is user-curated and small, so it lives in
// memory (refreshed on every edit) for O(1) display resolution, and is also
// joined directly in ClickHouse for aggregate grouping (Holders).
export interface Tag {
  tagId: string
  name: string
  color: string
  note: string
  icon: string      // explicit icon URL/emoji, or '' to derive from first member
  members: string[] // normalized account_ids
}
export interface AccountTag { tagId: string; name: string; color: string; icon: string }

let client: ClickHouseClient
const byAccount = new Map<string, AccountTag>()
const byTag = new Map<string, Tag>()

export function initTagService(c: ClickHouseClient): void { client = c }

// A tag's display icon: explicit icon if set, else the first member's icon via
// the SAME derivation the member pills use (accountIcon) — a custom image icon
// (e.g. a Discord emoji) wins over the fallback emoji char, so the group shows
// exactly what its first member shows (e.g. Treasury → 🏦, Polkadot Treasury →
// the members' custom Polkadot icon).
function iconFor(tag: Tag): string {
  if (tag.icon) return tag.icon
  const first = tag.members[0]
  if (!first) return '🏷️'
  const icon = accountIcon(first)
  return icon.emojiUrl || icon.emoji
}

export async function loadTags(): Promise<void> {
  const res = await client.query({
    query: `
      SELECT label_id, label_name, color, note, icon, account_id
      FROM price_data.account_tags FINAL
      WHERE deleted = 0
      ORDER BY label_id, account_id`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ label_id: string; label_name: string; color: string; note: string; icon: string; account_id: string }>()
  byAccount.clear()
  byTag.clear()
  for (const r of rows) {
    let tag = byTag.get(r.label_id)
    if (!tag) {
      tag = { tagId: r.label_id, name: r.label_name, color: r.color, note: r.note, icon: r.icon, members: [] }
      byTag.set(r.label_id, tag)
    }
    tag.members.push(r.account_id)
  }
  // Resolve each tag's display icon once members are known, then index accounts.
  for (const tag of byTag.values()) {
    const icon = iconFor(tag)
    tag.icon = icon
    for (const accountId of tag.members) {
      byAccount.set(accountId, { tagId: tag.tagId, name: tag.name, color: tag.color, icon })
    }
  }
  byH160 = truncatedH160Index([...byTag.values()])
}

export function tagForAccount(accountId: string): AccountTag | null {
  return byAccount.get(accountId) ?? null
}

// ERC-20/aToken balances of NATIVE accounts are recorded EVM-side under
// H160 = first 20 bytes of the AccountId32 (runtime truncation). blake2-derived
// accounts (stableswap pools, …) can't be reconstructed from the H160 alone, so
// this reverse index over the tagged accounts resolves such aliases back to the
// real account. ETH-prefixed members are skipped — their truncation is a
// genuine EVM address, not an alias.
export function truncatedH160Index(tags: Tag[]): Map<string, string> {
  const idx = new Map<string, string>()
  for (const tag of tags) {
    for (const accountId of tag.members) {
      if (!/^0x[0-9a-f]{64}$/i.test(accountId) || accountId.toLowerCase().startsWith('0x45544800')) continue
      idx.set('0x' + accountId.slice(2, 42).toLowerCase(), accountId)
    }
  }
  return idx
}

let byH160 = new Map<string, string>()
export function taggedAccountByH160(h160: string): string | null {
  return byH160.get(h160.toLowerCase()) ?? null
}
// All (h160 → owner) truncation pairs — for SQL-side remapping of ETH-prefixed
// rows in grouped rankings (accounts directory, holders).
export function taggedTruncationPairs(): [string, string][] {
  return [...byH160.entries()]
}
// AMM pool accounts (XYK pair + stableswap accounts) — derived, non-modl ids
// whose transfer legs are pool plumbing behind trade/liquidity rows.
export function ammPoolAccounts(): Set<string> {
  const out = new Set<string>()
  for (const tagId of ['xyk-pools', 'stableswap-pools']) {
    for (const m of byTag.get(tagId)?.members ?? []) out.add(m.toLowerCase())
  }
  return out
}
export function getTag(tagId: string): Tag | null {
  return byTag.get(tagId) ?? null
}
export function allTags(): Tag[] {
  return [...byTag.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// The HDX token icon (asset 0 on the Galactic Council asset-metadata CDN), used by
// the fee tags so they render the HDX logo.
const HDX_ICON = 'https://cdn.jsdelivr.net/gh/galacticcouncil/intergalactic-asset-metadata@master/v2/polkadot/2034/assets/0/icon.svg'
// The HOLLAR token icon (asset 222 on the same CDN), used by the HOLLAR tags.
const HOLLAR_ICON = 'https://cdn.jsdelivr.net/gh/galacticcouncil/intergalactic-asset-metadata@master/v2/polkadot/2034/assets/222/icon.svg'

// Tags are a fixed, code-defined set — there is no create/edit/delete API. This is
// the canonical definition; an empty `icon` derives the avatar from the first
// member's omniwatch emoji (e.g. Treasury → 🏦). seedDefaultTags() syncs this set
// into the database on every start, so a fresh database gets all of them and an
// existing one picks up additions.
export const DEFAULT_TAGS: { tagId: string; name: string; color: string; note: string; icon: string; addresses: string[] }[] = [
  {
    tagId: 'kraken', name: 'Kraken', color: '#7b6cf6', note: '', icon: '/tag-icons/kraken.jpg',
    addresses: [
      '14n8ferDrb3uorc5esxHgt2gePPFDTSn4qvxBywVEosejVFL',
      '12p8TxkyfmQBaSLooHA1NWRVjv7R8qgWfvKbVabEoH41L8jJ',
      '12xtAYsRUrmbniiWQqJtECiBQrMn8AypQcXhnQAc6RB6XkLW',
      '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ',
    ],
  },
  {
    tagId: 'polkadot-treasury', name: 'Polkadot Treasury', color: '#e6007a', note: 'Polkadot relay-chain treasury accounts', icon: '',
    addresses: [
      '12pPnA1aFic3ibBh9xMwssM1779vfrJBxqD4mDy8d18r4g95',
      '141gr5xsEbUwh3wyeANrTqWTEg92KcEzXxiNofVRvW66Dprt',
      '12cFn9YP36xQyEkvPGyjHQRS1WMNLdVFRs6k8KTTbpswYcus',
      '15UEyLQvUKMjxPi8NzighnsWfWHWy9jjerCyt4KoF5GuEK5k',
      '13JjZiX7QvmHCxwAmT92zugLE4yFNcjFFsbGirTaaYUp5xio',
    ],
  },
  {
    tagId: 'polkadot-fellowship', name: 'Polkadot Fellowship', color: '#e6007a', note: 'Polkadot Technical Fellowship account', icon: '',
    addresses: ['16VcQSRcMFy6ZHVjBvosKmo7FKqTb8ZATChDYo8ibutzLnos'],
  },
  {
    tagId: 'moonbeam-treasury', name: 'Moonbeam Treasury', color: '#53cbc9', note: 'Moonbeam treasury account', icon: '',
    addresses: ['13cKp89NgPL56sRoVRpBcjkGZPrk4Vf4tS6ePUD96XhAXozG'],
  },
  {
    // The Moonbeam-side bridge forwarding contract for inbound cross-chain assets
    // (e.g. Solana via Wormhole): the far leg arrives here, then hops to Hydration
    // over XCM, so our chain sees this contract as the origin rather than the real
    // sender. One contract fans out to 100+ Hydration recipients — labelling it
    // makes clear the transfer came through the Moonbeam/Wormhole bridge.
    tagId: 'moonbeam-wormhole', name: 'Moonbeam Wormhole', color: '#2ba69c', note: 'Moonbeam-side Wormhole bridge forwarding contract — inbound cross-chain assets (e.g. Solana → Wormhole → Moonbeam) arrive from here before the XCM hop to Hydration', icon: '🌉',
    addresses: ['0xf1db8c4bfbb3d6a97c9b669a2ffc0b70f41f3547'],
  },
  {
    tagId: 'treasury', name: 'Treasury', color: '', note: '', icon: '',
    // main pot + the py/trsry sub-account (suffix 0x08627411) observed on-chain
    addresses: ['13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB', modlAccountId('py/trsry', '08627411')],
  },
  // ---- pallet accounts (accounts with no extrinsics, decoded from their
  // "modl" + PalletId structure and matched to hydration-node constants) ----
  {
    tagId: 'omnipool', name: 'Omnipool', color: '#2b7de6', note: 'Omnipool pallet account — the AMM counterparty holding all Omnipool liquidity', icon: '',
    addresses: [modlAccountId('omnipool')],
  },
  {
    tagId: 'staking-pot', name: 'Staking Pot', color: 'var(--accent)', note: 'HDX staking pallet pot (PalletId staking#)', icon: '',
    addresses: [modlAccountId('staking#')],
  },
  {
    tagId: 'fee-processor', name: 'Fee Processor', color: 'var(--accent)', note: 'Collected transaction fees awaiting conversion/distribution (PalletId feeproc/)', icon: '',
    addresses: [modlAccountId('feeproc/')],
  },
  {
    tagId: 'gigahdx-pots', name: 'GIGAHDX Pots', color: 'var(--accent)', note: 'GIGAHDX staking pallet pots — the stHDX gigapot and reward pools', icon: '',
    addresses: [modlAccountId('gigahdx!'), modlAccountId('gigarwd!'), modlAccountId('gigarwd!', Buffer.from('alc', 'latin1').toString('hex'))],
  },
  {
    tagId: 'pallet-pots', name: 'Pallet Pots', color: '#6a7187', note: 'Assorted pallet accounts: router executor, liquidations, bonds, vesting, OTC settlements, currency reserve', icon: '⚙️',
    addresses: [modlAccountId('routerex'), modlAccountId('lqdation'), modlAccountId('pltbonds'), modlAccountId('py/vstng'), modlAccountId('otcsettl'), modlAccountId('curreser')],
  },
  {
    tagId: 'fee-staking-rewards', name: 'Fee (Staking Rewards)', color: 'var(--accent)', note: '', icon: HDX_ICON,
    addresses: ['13UVJyLkaPAE2HDTAaSadmwptPVwzY621KiKZ1ZrKYaXga2w'],
  },
  {
    tagId: 'fee-referrals', name: 'Fee (Referrals)', color: 'var(--accent)', note: '', icon: HDX_ICON,
    addresses: ['13UVJyLnyqpyNGDQwYM5WAYntAQ1paUYsH1hhiwjqRcREWYM'],
  },
  {
    tagId: 'hollar-stability-module', name: 'HOLLAR Stability Module', color: '#b3cf92', note: '', icon: HOLLAR_ICON,
    // EVM precompile (contract interface) + the py/hsmod substrate pallet pot
    // holding the module's aToken collateral — same module, two account forms.
    addresses: ['0x000000000000000000000000000000000000090a', modlAccountId('py/hsmod')],
  },
]

// Sync the code-defined tag set into the database: on a fresh database this
// creates every tag; on an existing one it inserts any tag or membership added
// to DEFAULT_TAGS since the last start. Idempotent — existing memberships are
// never rewritten. Called at startup after loadTags(); the only writer of
// price_data.account_tags.
// system-account derivations
// "modl" pallet account: 0x6d6f646c + the 8-byte PalletId + zero padding —
// the ids are compile-time constants in hydration-node (PalletId(*b"…")).
export function modlAccountId(palletId: string, sub = ''): string {
  const body = Buffer.from('modl' + palletId, 'latin1').toString('hex') + sub
  return ('0x' + body.padEnd(64, '0')).toLowerCase()
}
// Stableswap pool account: blake2-256("sts" + poolId LE u32) — the runtime's
// StableswapAccountIdConstructor (runtime/hydradx/src/assets.rs). Verified
// against on-chain balances for all 16 live pools.
export function stableswapPoolAccount(poolId: number): string {
  const buf = new Uint8Array(7)
  buf.set(Buffer.from('sts', 'latin1'), 0)
  new DataView(buf.buffer).setUint32(3, poolId, true)
  return u8aToHex(blake2AsU8a(buf, 256))
}

// Tags whose members are protocol PLUMBING (pools, pots, farm sub-accounts) —
// excluded from "economic actor" surfaces like the HDX top movers, unlike the
// Treasury/HSM/fee tags which represent deliberate actors.
export const SYSTEM_TAG_IDS = new Set(['money-market', 'omnipool', 'staking-pot', 'fee-processor', 'gigahdx-pots', 'pallet-pots', 'liquidity-mining', 'xyk-pools', 'stableswap-pools', 'sovereigns', 'moonbeam-wormhole'])

// Tagged module (modl) accounts that count as economic actors — the top-movers
// exception list: module plumbing stays hidden, the Treasury's DCA program shows.
export function economicModuleAccounts(tags: Tag[]): string[] {
  return tags.filter(t => !SYSTEM_TAG_IDS.has(t.tagId))
    .flatMap(t => t.members)
    .filter(m => m.startsWith('0x6d6f646c'))
}

// The money-market protocol accounts (aToken/vDebt/pool contracts) grouped
// under one label. Unlike DEFAULT_TAGS this set is DERIVED: members come from
// the indexed reserve map, so a newly listed reserve joins on the next sync —
// no code change needed.
export const MM_TAG = { tagId: 'money-market', name: 'Supply & Borrow', color: '#6aa5f8', note: 'Money-market reserve contracts (aTokens, debt tokens, pools) — inflows are supplies/repayments, outflows are withdrawals/borrows', icon: '🏦' }

// Membership rows for the MM tag: every distinct contract H160 from the reserve
// map, in the truncated-account form its on-chain activity is indexed under.
export function mmTagMemberRows(reserves: { atoken: string; vdebt: string; pool_proxy: string }[], existing: Set<string>): Record<string, unknown>[] {
  const ids = new Set<string>()
  for (const r of reserves) {
    for (const h160 of [r.atoken, r.vdebt, r.pool_proxy]) {
      if (/^0x[0-9a-fA-F]{40}$/.test(h160)) ids.add('0x45544800' + h160.slice(2).toLowerCase() + '0000000000000000')
    }
  }
  return [...ids].filter(id => !existing.has(id)).map(account_id => ({
    label_id: MM_TAG.tagId, label_name: MM_TAG.name, color: MM_TAG.color, note: MM_TAG.note, icon: MM_TAG.icon, account_id, deleted: 0,
  }))
}

export async function syncMoneyMarketTag(): Promise<void> {
  const res = await client.query({
    query: `SELECT DISTINCT atoken, vdebt, pool_proxy FROM price_data.atoken_reserve_map`,
    format: 'JSONEachRow',
  })
  const reserves = await res.json<{ atoken: string; vdebt: string; pool_proxy: string }>()
  const existing = new Set(byTag.get(MM_TAG.tagId)?.members ?? [])
  const rows = mmTagMemberRows(reserves, existing)
  if (!rows.length) return
  await client.insert({ table: 'price_data.account_tags', values: rows, format: 'JSONEachRow' })
  await loadTags()
  console.log(`[tags] synced ${rows.length} money-market reserve account(s) into "${MM_TAG.name}"`)
}

// Structural system-account families, derived from indexed data so they are
// recreated automatically after a from-scratch reindex and pick up new members
// (pools, farms, HRMP channels) on every sync:
//  - XYK pool accounts come with their XYK.PoolCreated event,
//  - Stableswap pool accounts are computed from Stableswap.PoolCreated ids,
//  - liquidity-mining pots and sibling-parachain sovereigns are recognizable
//    by their account-id structure alone (prefix scan over known balances).
const LM_PREFIXES = ['OmniWhLM', 'Omni//LM', 'XYK///LM', 'xykLMpID'].map(id => ('0x' + Buffer.from('modl' + id, 'latin1').toString('hex')).toLowerCase())
const STRUCTURAL_TAGS = [
  { tagId: 'xyk-pools', name: 'XYK Pool', color: '#86c4f5', note: 'XYK AMM pair account — holds the pool reserves', icon: '💧' },
  { tagId: 'stableswap-pools', name: 'Stableswap Pool', color: '#57a5ec', note: 'Stableswap pool account — holds the pool reserves', icon: '💧' },
  { tagId: 'liquidity-mining', name: 'Liquidity Mining', color: 'var(--accent)', note: 'Liquidity-mining pallet pots (global/yield farm sub-accounts)', icon: '🚜' },
  { tagId: 'sovereigns', name: 'Parachain Sovereign', color: '#e6007a', note: 'Sibling parachain sovereign account (sibl + para id) — holds assets on behalf of that chain', icon: '🛰️' },
] as const

export async function syncStructuralTags(): Promise<void> {
  const [xykRes, stableRes, prefixRes] = await Promise.all([
    client.query({
      query: `SELECT DISTINCT JSONExtractString(args_json, 'pool') AS acc FROM price_data.raw_events WHERE event_name = 'XYK.PoolCreated'`,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `SELECT DISTINCT JSONExtractInt(args_json, 'poolId') AS pool_id FROM price_data.raw_events WHERE event_name = 'Stableswap.PoolCreated'`,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `SELECT DISTINCT account_id FROM price_data.account_asset_latest_balances
              WHERE startsWith(account_id, '0x7369626c') OR startsWith(account_id, '0x6d6f646c')`,
      format: 'JSONEachRow',
    }),
  ])
  const xyk = (await xykRes.json<{ acc: string }>()).map(r => r.acc.toLowerCase()).filter(a => /^0x[0-9a-f]{64}$/.test(a))
  const stable = (await stableRes.json<{ pool_id: number }>()).filter(r => r.pool_id > 0).map(r => stableswapPoolAccount(r.pool_id))
  const prefixAccounts = (await prefixRes.json<{ account_id: string }>()).map(r => r.account_id.toLowerCase())
  const membersByTag: Record<string, string[]> = {
    'xyk-pools': xyk,
    'stableswap-pools': stable,
    'liquidity-mining': prefixAccounts.filter(a => LM_PREFIXES.some(p => a.startsWith(p))),
    'sovereigns': prefixAccounts.filter(a => a.startsWith('0x7369626c')),
  }
  const rows: Record<string, unknown>[] = []
  for (const def of STRUCTURAL_TAGS) {
    const existing = new Set(byTag.get(def.tagId)?.members ?? [])
    for (const account_id of new Set(membersByTag[def.tagId])) {
      if (existing.has(account_id) || byAccount.has(account_id)) continue // never steal an account from another tag
      rows.push({ label_id: def.tagId, label_name: def.name, color: def.color, note: def.note, icon: def.icon, account_id, deleted: 0 })
    }
  }
  if (!rows.length) return
  await client.insert({ table: 'price_data.account_tags', values: rows, format: 'JSONEachRow' })
  await loadTags()
  console.log(`[tags] synced ${rows.length} structural system account(s) (pools, LM pots, sovereigns)`)
}

let structuralTagRefreshTimer: ReturnType<typeof setInterval> | null = null
export function startStructuralTagRefresh(): void {
  if (structuralTagRefreshTimer) return
  structuralTagRefreshTimer = setInterval(() => { void syncStructuralTags().catch(() => {}) }, 60 * 60_000)
  structuralTagRefreshTimer.unref()
}

let mmTagRefreshTimer: ReturnType<typeof setInterval> | null = null
export function startMoneyMarketTagRefresh(): void {
  if (mmTagRefreshTimer) return
  // New reserves are rare; an hourly re-sync picks them up well before anyone
  // notices an unlabeled contract.
  mmTagRefreshTimer = setInterval(() => { void syncMoneyMarketTag().catch(() => {}) }, 60 * 60_000)
  mmTagRefreshTimer.unref()
}

export async function seedDefaultTags(): Promise<void> {
  const rows: Record<string, unknown>[] = []
  for (const def of DEFAULT_TAGS) {
    const existing = byTag.get(def.tagId)
    for (const address of def.addresses) {
      const n = normalizeAddress(address)
      if (!n?.accountId) {
        console.warn(`[tags] seed: could not resolve address ${address} for tag ${def.tagId}`)
        continue
      }
      if (existing?.members.includes(n.accountId)) continue
      rows.push({ label_id: def.tagId, label_name: def.name, color: def.color, note: def.note, icon: def.icon, account_id: n.accountId, deleted: 0 })
    }
  }
  if (!rows.length) return
  await client.insert({ table: 'price_data.account_tags', values: rows, format: 'JSONEachRow' })
  await loadTags()
  console.log(`[tags] synced ${rows.length} tag membership(s) from DEFAULT_TAGS`)
}

// A tag's color is canonical in code (DEFAULT_TAGS / STRUCTURAL_TAGS / MM_TAG) —
// there is no edit API. But membership rows are only ever INSERTED (seed and the
// structural/MM syncs skip accounts that already exist), so editing a color in
// code would otherwise never reach an already-seeded database: loadTags() reads
// color from the table, and the Accounts/Holders aggregates read it straight
// from SQL. Reconcile the stored color to the code definition with an in-place
// mutation. Idempotent — the `color != …` guard makes it a no-op once the table
// already matches, so it costs nothing on subsequent starts.
export async function reconcileTagColors(): Promise<void> {
  const want = new Map<string, string>()
  for (const d of DEFAULT_TAGS) want.set(d.tagId, d.color)
  for (const d of STRUCTURAL_TAGS) want.set(d.tagId, d.color)
  want.set(MM_TAG.tagId, MM_TAG.color)
  let changed = 0
  for (const [tagId, color] of want) {
    const tag = byTag.get(tagId)
    if (!tag || tag.color === color) continue
    await client.command({
      query: `ALTER TABLE price_data.account_tags UPDATE color = {color:String} WHERE label_id = {tagId:String} AND color != {color:String}`,
      query_params: { color, tagId },
      clickhouse_settings: { mutations_sync: '1' },
    })
    changed++
  }
  if (changed) {
    await loadTags()
    console.log(`[tags] reconciled color for ${changed} tag(s) from code definitions`)
  }
}
