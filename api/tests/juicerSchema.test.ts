import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DATA_UPGRADES } from '../src/db/schemaBootstrap.ts'
import { JUICER_ACTION_TOPIC, JUICER_LOG_CONTRACTS, JUICER_LOOP_TOPICS, JUICER_SUBLOOP, JUICER_TOPIC } from '../src/services/juicer.ts'

const sql = readFileSync(new URL('../../clickhouse/schema/018_juicer.sql', import.meta.url), 'utf8')
const mvLine = (name: string) => sql.split('\n').find(l => l.startsWith(`CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.${name} `))!
const mv = mvLine('juicer_logs_mv')
const loopMv = mvLine('juicer_loop_logs_mv')

function listAfter(prefix: string, line = mv): string[] {
  const at = line.indexOf(prefix)
  expect(at, prefix).toBeGreaterThan(0)
  const body = line.slice(at + prefix.length, line.indexOf(')', at + prefix.length))
  return body.split(',').map(s => s.trim().replace(/^'|'$/g, '')).sort()
}

describe('juicer_logs', () => {
  // The table holds exactly the contracts and topics the decoder reads: a topic the
  // service starts reading must join the MV (and its DATA_UPGRADES WHERE), or the
  // reader silently sees none of its rows.
  it('copies the deployment contracts the leaf names', () => {
    expect(listAfter('AND lower(raw_evm_logs.contract_address) IN (')).toEqual([...JUICER_LOG_CONTRACTS].sort())
  })

  it('copies every topic juicer.ts decodes, and only those, across its two views', () => {
    const loop = listAfter('WHERE raw_evm_logs.topic0 IN (', loopMv)
    expect(loop).toEqual([...JUICER_LOOP_TOPICS].sort())
    expect([...listAfter('WHERE raw_evm_logs.topic0 IN ('), ...loop].sort()).toEqual(Object.values(JUICER_TOPIC).sort())
    expect(listAfter('AND lower(raw_evm_logs.contract_address) IN (', loopMv)).toEqual([JUICER_SUBLOOP])
    for (const { topic } of Object.values(JUICER_ACTION_TOPIC)) expect(Object.values(JUICER_TOPIC)).toContain(topic)
  })

  it('names the party of exactly the user events', () => {
    expect(mv).toContain(`= '${JUICER_TOPIC.Deposited}' AND length(topics) >= 2, lower(concat('0x', substring(topics[2], 27, 40)))`)
    expect(listAfter("multiIf(ifNull(raw_evm_logs.topic0, '') = '" + JUICER_TOPIC.Deposited + "' AND length(topics) >= 2, lower(concat('0x', substring(topics[2], 27, 40))), ifNull(raw_evm_logs.topic0, '') IN ("))
      .toEqual([JUICER_TOPIC.RedeemRequested, JUICER_TOPIC.Claimed, JUICER_TOPIC.SurplusClaimed].sort())
  })

  it('replays each view by its own predicate and select', () => {
    const ups = DATA_UPGRADES.filter(x => x.table === 'price_data.juicer_logs')
    expect(ups).toHaveLength(2)
    expect(mv).toContain(`AS SELECT ${ups[0].select} FROM price_data.raw_evm_logs WHERE ${ups[0].where};`)
    expect(loopMv).toContain(`AS SELECT ${ups[1].select} FROM price_data.raw_evm_logs WHERE ${ups[1].where};`)
  })
})
