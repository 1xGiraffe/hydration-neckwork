import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DATA_UPGRADES } from '../src/db/schemaBootstrap.ts'
import { TOPIC } from '../src/services/wormholeNtt.ts'

const sql = readFileSync(new URL('../../clickhouse/schema/017_narrow_event_tables.sql', import.meta.url), 'utf8')
const service = readFileSync(new URL('../src/services/wormholeNttService.ts', import.meta.url), 'utf8')

function mvWhereList(mv: string): string[] {
  const line = sql.split('\n').find(l => l.startsWith(`CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.${mv} `))
  expect(line, mv).toBeDefined()
  const list = /WHERE \S+ IN \(([^)]*)\);$/.exec(line!)?.[1] ?? ''
  return list.split(',').map(s => s.trim().replace(/^'|'$/g, '')).sort()
}

describe('wormhole_ntt_logs', () => {
  // The table holds exactly the topics the backing monitor reads: a topic the
  // service starts reading must be added to the MV (and its DATA_UPGRADES WHERE),
  // or the reader silently sees none of its rows.
  it('carries every topic the NTT service reads, and only those', () => {
    const read = [...new Set([...service.matchAll(/\$\{TOPIC\.(\w+)\}/g)].map(m => m[1]))]
    const topics = read.map(k => (TOPIC as Record<string, string>)[k]).sort()
    expect(read.length).toBe(7)
    expect(mvWhereList('wormhole_ntt_logs_mv')).toEqual(topics)
  })

  it('reads no NTT log from raw_evm_logs any more', () => {
    expect(service).not.toMatch(/FROM price_data\.raw_evm_logs/)
  })

  it('replays the same predicate as its MV', () => {
    const u = DATA_UPGRADES.find(x => x.table === 'price_data.wormhole_ntt_logs')!
    expect(u.source).toBe('raw_evm_logs')
    expect(sql).toContain(`FROM price_data.raw_evm_logs WHERE ${u.where};`)
  })
})

describe('referendum_preimage_events', () => {
  it('holds the four hash-naming events the proposal decoder pairs', () => {
    expect(mvWhereList('referendum_preimage_events_mv')).toEqual(
      ['Democracy.PreimageNoted', 'Democracy.PreimageUsed', 'Preimage.Noted', 'Referenda.Submitted'])
    const u = DATA_UPGRADES.find(x => x.table === 'price_data.referendum_preimage_events')!
    expect(sql).toContain(`FROM price_data.raw_events WHERE ${u.where};`)
  })
})
