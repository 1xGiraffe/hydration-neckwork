import { describe, it, expect } from 'vitest'
import { addressFromWord, buildProxyLinks, BEACON_UPGRADED_TOPIC, UPGRADED_TOPIC, type UpgradeEventRow } from '../src/services/contractRegistryService.ts'

// The issue's example: governance dispatcher proxy → GovernanceDispatcher implementation.
const PROXY = '0x00302167f9597b9d90bd342311c5c4be39bf0fa0'
const IMPL = '0xfddb5acb121a6abab4919cfc1672250697163bed'
const OLD = '0x1111111111111111111111111111111111111111'
const word = (a: string) => '0x' + '0'.repeat(24) + a.slice(2)
const slot = (address: string, implementation = '', beacon = '', snapshot_block = 100) => ({ address, implementation, beacon, snapshot_block })
const upgraded = (proxy: string, target: string, block_height: number, topic0 = UPGRADED_TOPIC): UpgradeEventRow =>
  ({ proxy, block_height, event_index: 1, topic0, target_word: word(target), ts: `t${block_height}` })

describe('addressFromWord', () => {
  it('reads the low 20 bytes and treats zero as no address', () => {
    expect(addressFromWord(word(IMPL))).toBe(IMPL)
    expect(addressFromWord('0x' + '0'.repeat(64))).toBeNull()
    expect(addressFromWord(null)).toBeNull()
    expect(addressFromWord('0x12')).toBeNull()
  })
})

describe('buildProxyLinks', () => {
  it('links a proxy to the implementation its slot names, with no event and no verification', () => {
    const l = buildProxyLinks([slot(PROXY, IMPL), slot(IMPL)], [])
    expect(l.proxies.get(PROXY)).toEqual({ implementation: IMPL, beacon: null, history: [] })
    expect(l.proxies.has(IMPL)).toBe(false)
    expect(l.currentOf.get(IMPL)).toEqual([PROXY])
  })

  it('takes an upgrade newer than the slot read as current, and keeps the older target as history', () => {
    const l = buildProxyLinks([slot(PROXY, OLD, '', 100)], [upgraded(PROXY, OLD, 50), upgraded(PROXY, IMPL, 150)])
    expect(l.proxies.get(PROXY)?.implementation).toBe(IMPL)
    expect(l.proxies.get(PROXY)?.history.map(u => u.target)).toEqual([OLD, IMPL])
    expect(l.currentOf.get(IMPL)).toEqual([PROXY])
    expect(l.formerOf.get(OLD)).toEqual([PROXY])
    expect(l.currentOf.has(OLD)).toBe(false)
  })

  it('trusts the slot over an upgrade it has already seen', () => {
    const l = buildProxyLinks([slot(PROXY, IMPL, '', 200)], [upgraded(PROXY, OLD, 150)])
    expect(l.proxies.get(PROXY)?.implementation).toBe(IMPL)
    expect(l.formerOf.get(OLD)).toEqual([PROXY])
  })

  it('lists every proxy of a shared implementation', () => {
    const other = '0x2222222222222222222222222222222222222222'
    const l = buildProxyLinks([slot(PROXY, IMPL), slot(other, IMPL)], [])
    expect(l.currentOf.get(IMPL)?.sort()).toEqual([other, PROXY].sort())
  })

  it('counts an upgrade in the very block the slot was read at as already seen', () => {
    const l = buildProxyLinks([slot(PROXY, IMPL, '', 150)], [upgraded(PROXY, OLD, 120), upgraded(PROXY, IMPL, 150)])
    expect(l.proxies.get(PROXY)?.implementation).toBe(IMPL)
    // A same-block event the read reflects never overrides it.
    const stale = buildProxyLinks([slot(PROXY, IMPL, '', 150)], [upgraded(PROXY, OLD, 150)])
    expect(stale.proxies.get(PROXY)?.implementation).toBe(IMPL)
  })

  it('records one upgrade once when the event arrives twice', () => {
    const e = upgraded(PROXY, IMPL, 150)
    const l = buildProxyLinks([slot(PROXY, OLD, '', 100)], [e, { ...e }])
    expect(l.proxies.get(PROXY)?.history).toHaveLength(1)
  })

  it('resolves a beacon proxy to the beacon\'s announced implementation, and the beacon is no proxy', () => {
    const beacon = '0x3333333333333333333333333333333333333333'
    const l = buildProxyLinks(
      [slot(PROXY, '', beacon), slot(beacon)],
      [upgraded(PROXY, beacon, 10, BEACON_UPGRADED_TOPIC), upgraded(beacon, OLD, 5), upgraded(beacon, IMPL, 8)],
    )
    expect(l.proxies.get(PROXY)).toMatchObject({ implementation: IMPL, beacon })
    expect(l.proxies.get(PROXY)?.history[0].kind).toBe('beacon')
    expect(l.proxies.has(beacon)).toBe(false)
    expect(l.currentOf.get(IMPL)).toEqual([PROXY])
  })

  it('leaves a beacon proxy\'s implementation unknown when the beacon never announced one', () => {
    const beacon = '0x3333333333333333333333333333333333333333'
    const l = buildProxyLinks([slot(PROXY, '', beacon)], [])
    expect(l.proxies.get(PROXY)).toMatchObject({ implementation: null, beacon })
  })

  it('is not a proxy with empty slots and no upgrade', () => {
    expect(buildProxyLinks([slot(PROXY)], []).proxies.size).toBe(0)
  })
})
