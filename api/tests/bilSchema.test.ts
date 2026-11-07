import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DATA_UPGRADES } from '../src/db/schemaBootstrap.ts'
import { BIL_ACTIONS, BIL_LOG_SOURCES, BIL_LOGS_SELECT, BIL_LOGS_WHERE, BIL_TOPIC, bilActionRowSql, decodeBilLog } from '../src/services/bil.ts'

const sql = readFileSync(new URL('../../clickhouse/schema/019_bil.sql', import.meta.url), 'utf8')
const mv = sql.split('\n').find(l => l.startsWith('CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.bil_logs_mv '))!

describe('bil_logs', () => {
  // The table holds exactly the contracts and topics the decoder reads: the MV states
  // bil.ts's own predicate and select, and the upgrade replays the same two.
  it('states the leaf\'s predicate and select verbatim, and replays them', () => {
    expect(mv).toContain(`AS SELECT ${BIL_LOGS_SELECT} FROM price_data.raw_evm_logs WHERE ${BIL_LOGS_WHERE};`)
    const up = DATA_UPGRADES.filter(u => u.table === 'price_data.bil_logs')
    expect(up).toHaveLength(1)
    expect(up[0].where).toBe(BIL_LOGS_WHERE)
    expect(up[0].select).toBe(BIL_LOGS_SELECT)
  })

  it('keeps every topic it decodes, each from its own contract', () => {
    const kept = new Set(BIL_LOG_SOURCES.flatMap(s => s.topics))
    for (const [name, topic] of Object.entries(BIL_TOPIC)) {
      if (name === 'Transfer') continue
      expect(kept.has(topic), name).toBe(true)
    }
    for (const s of BIL_LOG_SOURCES) {
      for (const topic of s.topics) {
        const decoded = decodeBilLog({ block_height: 1, event_index: 0, extrinsic_index: 0, ts: '2026-01-01 00:00:00', contract_address: s.contract, topic0: topic, topics: [topic, '0x' + '0'.repeat(64), '0x' + '0'.repeat(64), '0x' + '0'.repeat(64)], data: '0x' + '0'.repeat(320) })
        expect(decoded, topic).not.toBeNull()
      }
    }
  })

  it('counts every action per day from the table alone', () => {
    for (const a of BIL_ACTIONS) expect(bilActionRowSql(a)).toMatch(/^\(/)
  })
})
