import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { splitSqlStatements } from '../src/db/schemaBootstrap.ts'

// The RewardsController's logs are stored undecoded, so the incentive models decode
// topics/data in SQL. These pins hold the event identities (keccak topic0s), the word
// offsets and the replacement keys that make a replayed range rewrite the same rows.
const statementsOf = (file: string) =>
  splitSqlStatements(readFileSync(new URL(`../../clickhouse/schema/${file}`, import.meta.url), 'utf8'))
    .map(s => s.replace(/^[ \t]*--.*$/gm, '').trim())
const tables = statementsOf('001_tables.sql')
const views = statementsOf('003_materialized_views.sql')
const one = (list: string[], prefix: string) => {
  const found = list.filter(s => s.startsWith(prefix))
  expect(found, prefix).toHaveLength(1)
  return found[0]
}
const mv = (name: string) => one(views, `CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.${name} `)
const table = (name: string) => one(tables, `CREATE TABLE IF NOT EXISTS price_data.${name} `)

const CONTROLLER = "contract_address = '0x7472a3d0891df2401d981a5954d07e364f05060f'"
const ACCRUED = "topic0 = '0x3303facd24627943a92e9dc87cfbb34b15c49b726eec3ad3487c16be9ab8efe8'"
const CLAIMED = "topic0 = '0xc052130bc4ef84580db505783484b067ea8b71b3bca78a7e12db7aea8658f004'"
const CONFIG = "topic0 = '0xac1777479f07f3e7c34da8402139d54027a6a260caaae168bdee825ca5580dc5'"
const word = (i: number) => `reinterpretAsUInt256(reverse(unhex(substring(data, ${3 + 64 * i}, 64))))`
const topicAddr = (k: number) => `lower(concat('0x', substring(topics[${k}], 27, 40)))`

describe('incentive log models', () => {
  it('decode Accrued(asset, reward, user, assetIndex, userIndex, rewardsAccrued)', () => {
    const s = mv('mm_incentive_accruals_mv')
    expect(s).toContain('TO price_data.mm_incentive_accruals ')
    for (const f of [CONTROLLER, ACCRUED, 'length(topics) = 4', 'length(data) = 194']) expect(s).toContain(f)
    expect(s).toContain(`${topicAddr(4)} AS user_address, ${topicAddr(2)} AS asset_address, ${topicAddr(3)} AS reward_address`)
    expect(s).toContain(`${word(0)} AS asset_index, ${word(1)} AS user_index, ${word(2)} AS rewards_accrued`)
  })

  it('decode RewardsClaimed(user, reward, to, claimer, amount)', () => {
    const s = mv('mm_incentive_claims_mv')
    for (const f of [CONTROLLER, CLAIMED, 'length(data) = 130']) expect(s).toContain(f)
    expect(s).toContain(`${topicAddr(2)} AS user_address, ${topicAddr(3)} AS reward_address`)
    expect(s).toContain(`${topicAddr(4)} AS to_address, lower(concat('0x', substring(data, 27, 40))) AS claimer, ${word(1)} AS amount`)
  })

  it('decode AssetConfigUpdated(asset, reward, oldEmission, newEmission, oldEnd, newEnd, assetIndex)', () => {
    const s = mv('mm_incentive_programmes_mv')
    for (const f of [CONTROLLER, CONFIG, 'length(topics) = 3', 'length(data) = 322']) expect(s).toContain(f)
    expect(s).toContain(`${word(0)} AS old_emission, ${word(1)} AS new_emission, ${word(2)} AS old_distribution_end, ${word(3)} AS new_distribution_end, ${word(4)} AS asset_index`)
  })

  // The programme index is written in exactly two places, and both feed the "last
  // index at or before h" table.
  it('feed the index table from every Accrued and every AssetConfigUpdated', () => {
    const accrued = mv('mm_incentive_accrual_index_updates_mv')
    const config = mv('mm_incentive_config_index_updates_mv')
    expect(accrued).toContain('TO price_data.mm_incentive_index_updates ')
    expect(config).toContain('TO price_data.mm_incentive_index_updates ')
    expect(accrued).toContain(`${word(0)} AS asset_index, 'accrued' AS source`)
    expect(config).toContain(`${word(4)} AS asset_index, 'config' AS source`)
    expect(accrued).toContain(ACCRUED)
    expect(config).toContain(CONFIG)
  })

  // Replay safety: every log model keys on the log's own (block, event index) and
  // replaces by ingest time, so re-indexing a range rewrites the same rows.
  it('key every log model on the log identity, replacing by ingest time', () => {
    const keys: Record<string, string> = {
      mm_incentive_accruals: 'ORDER BY (user_address, asset_address, reward_address, block_height, event_index)',
      mm_incentive_claims: 'ORDER BY (user_address, reward_address, block_height, event_index)',
      mm_incentive_index_updates: 'ORDER BY (asset_address, reward_address, block_height, event_index)',
      mm_incentive_programmes: 'ORDER BY (asset_address, reward_address, block_height, event_index)',
    }
    for (const [name, key] of Object.entries(keys)) {
      const s = table(name)
      expect(s, name).toContain('ENGINE = ReplacingMergeTree(ingested_at)')
      expect(s, name).toContain(key)
    }
    expect(table('mm_incentive_anchor')).toContain('ORDER BY (user_address, asset_address, reward_address)')
    expect(table('mm_incentive_snapshots')).toContain('PARTITION BY snapshot_id ORDER BY (snapshot_id, account_id, reward_asset_id, asset_address)')
    expect(table('mm_incentive_snapshot_state')).toContain('ORDER BY snapshot_key')
  })
})
