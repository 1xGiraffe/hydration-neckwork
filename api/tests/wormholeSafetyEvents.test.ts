import { describe, expect, it } from 'vitest'
import { buildWormholeSafetyEvents, type WormholeManagerEventRow } from '../src/services/securityService.ts'
import { safetyIdentity } from '../src/notifications/evaluator.ts'
import type { WormholeManagerRef } from '../src/services/wormholeNttService.ts'

// Actions on the Wormhole managers join the same Security ledger the circuit
// breakers write to, so they get the safety kind's notifications, its renderer
// and its inbox rows for free. The log bytes below are the real ones Hydration
// wrote when the managers were configured in July 2026, except where a fixture
// is marked as encoded from the verified ABI (Hydration has never paused a
// manager, and its uncapped limiters have never queued a transfer).

const USDC: WormholeManagerRef = {
  assetId: 21, symbol: 'USDC', decimals: 6,
  manager: '0xeceab64542a875c4472671d9ed1e690cdd4e28fc',
  originChainId: 2, originChainName: 'Ethereum',
}
const managers = [USDC]

const row = (over: Partial<WormholeManagerEventRow>): WormholeManagerEventRow => ({
  block_height: 13_371_547,
  block_timestamp: '2026-07-29 16:15:03',
  extrinsic_index: 2,
  event_index: 9,
  contract: USDC.manager,
  topics: [],
  data: '0x',
  ...over,
})

// Block 13,371,547 event 9: the USDC manager's outbound limit moving from the
// u64 ceiling to 184,467,440,737 USDC — Hydration's deliberate uncapping.
const OUTBOUND_LIMIT_SET = row({
  topics: ['0x7e3b0fc388be9d36273f66210aed83be975df3a9adfffa4c734033f498f362cd'],
  data: '0x000000000000000000000000000000000000000000000000ffffffffffffffff'
    + '000000000000000000000000000000000000000000000000028f5c28f5c11a40',
})

// Block 13,371,542 event 7: the same manager's inbound limit from Ethereum
// (chain 2, the indexed topic) being set for the first time.
const INBOUND_LIMIT_SET = row({
  block_height: 13_371_542,
  block_timestamp: '2026-07-29 16:14:42',
  event_index: 7,
  topics: [
    '0x739ed886fd81a3ddc9f4b327ab69152e513cd45b26fda0c73660eaca8e119301',
    '0x0000000000000000000000000000000000000000000000000000000000000002',
  ],
  data: '0x0000000000000000000000000000000000000000000000000000000000000000'
    + '000000000000000000000000000000000000000000000000028f5c28f5c11a40',
})

// Hydration's managers have never been paused, so the pair below is encoded from
// the verified NttManager ABI: Paused(bool) and NotPaused(bool), which is NTT's
// own PausableUpgradeable — not OpenZeppelin's Paused(address).
const PAUSED = row({
  block_height: 13_400_000,
  topics: ['0x0e2fb031ee032dc02d8011dc50b816eb450cf856abd8261680dac74f72165bd2'],
  data: '0x' + '0'.repeat(63) + '1',
})
const UNPAUSED = row({
  block_height: 13_400_100,
  topics: ['0xe11c2112add17fb763d3bd59f63b10429c3e11373da4fb8ef6725107a2fdc4b0'],
  data: '0x' + '0'.repeat(63) + '1',
})

// Hydration's own limiters are uncapped (184.5B tokens), so neither of these has
// ever fired here. They are encoded from the verified NttManager ABI —
// OutboundTransferQueued(uint64 queueSequence) and
// InboundTransferQueued(bytes32 digest) — because the day a local limit is set
// is the day a held transfer must reach the ledger.
const OUTBOUND_QUEUED = row({
  block_height: 13_500_000,
  topics: ['0x69add1952a6a6b9cb86f04d05f0cb605cbb469a50ae916139d34495a9991481f'],
  data: '0x' + (7).toString(16).padStart(64, '0'),
})
const INBOUND_QUEUED = row({
  block_height: 13_500_010,
  topics: ['0x7f63c9251d82a933210c2b6d0b0f116252c3c116788120e64e8e8215df6f3162'],
  data: '0x319c998f9e8ab534fb886dbfc4db6fccf0d10101cdb687f1a6657f79cb83d41c',
})

describe('Wormhole manager events on the Security ledger', () => {
  it('reads the real outbound limit update, old value and all', () => {
    const [event] = buildWormholeSafetyEvents([OUTBOUND_LIMIT_SET], managers)
    expect(event.kind).toBe('limit')
    expect(event.label).toBe('Wormhole USDC outbound limit set to 184,467,440,737 USDC')
    expect(event.detail).toContain('leaving Hydration for Ethereum')
    expect(event.detail).toContain('(was 18,446,744,073,710 USDC)')
    expect(event.blockHeight).toBe(13_371_547)
    expect(event.extrinsicIndex).toBe(2)
    expect(event.asset?.assetId).toBe(21)
  })

  it('reads the inbound update and names the peer it applies to', () => {
    const [event] = buildWormholeSafetyEvents([INBOUND_LIMIT_SET], managers)
    expect(event.label).toBe('Wormhole USDC inbound limit set to 184,467,440,737 USDC')
    expect(event.detail).toContain('arriving from Ethereum')
  })

  it('gives two limit updates in one block distinct identities', () => {
    // A governance batch can set both legs in one extrinsic. The safety
    // identity is (block, extrinsic, kind, asset, label), so the labels have to
    // differ or one of the two notifications is deduplicated away.
    const sameBlock = { block_height: 13_371_547, extrinsic_index: 2 }
    const events = buildWormholeSafetyEvents(
      [row({ ...OUTBOUND_LIMIT_SET, ...sameBlock }), row({ ...INBOUND_LIMIT_SET, ...sameBlock })],
      managers,
    )
    expect(new Set(events.map(safetyIdentity)).size).toBe(2)
  })

  it('turns the pause pair into pause and unpause actions', () => {
    const events = buildWormholeSafetyEvents([PAUSED, UNPAUSED], managers)
    expect(events.map(e => e.kind)).toEqual(['pause', 'unpause'])
    expect(events[0].label).toBe('Wormhole USDC manager paused')
    expect(events[0].detail).toContain('halted in both directions')
    expect(events[1].label).toBe('Wormhole USDC manager unpaused')
  })

  it('turns a Hydration-side queue log into a queued action', () => {
    // The origin-chain counterpart of this event has no indexed row and reaches
    // a subscriber through the safety snapshot lane instead; the two never
    // report the same held transfer.
    const [event] = buildWormholeSafetyEvents([OUTBOUND_QUEUED], managers)
    expect(event.kind).toBe('queued')
    expect(event.label).toBe('Wormhole USDC outbound transfer queued #7')
    expect(event.detail).toContain('leaving Hydration for Ethereum')
    expect(event.detail).toContain('held by the limiter')
  })

  it('names the inbound queue entry by its digest', () => {
    const [event] = buildWormholeSafetyEvents([INBOUND_QUEUED], managers)
    expect(event.kind).toBe('queued')
    expect(event.label).toBe('Wormhole USDC inbound transfer queued 0x319c99…83d41c')
    expect(event.detail).toContain('arriving from Ethereum')
  })

  it('gives two queue entries in one extrinsic distinct identities', () => {
    // The event carries the queue slot, not the amount, so the slot is what
    // separates two holds inside one batch.
    const sameBlock = { block_height: 13_500_000, extrinsic_index: 4 }
    const second = row({
      ...OUTBOUND_QUEUED, ...sameBlock,
      data: '0x' + (8).toString(16).padStart(64, '0'),
    })
    const events = buildWormholeSafetyEvents([row({ ...OUTBOUND_QUEUED, ...sameBlock }), second], managers)
    expect(new Set(events.map(safetyIdentity)).size).toBe(2)
  })

  it('drops a log from an address the discovery does not name', () => {
    // The two decoy managers on Hydration's EVM — an NTTUSD test deployment and
    // a superseded PRIME duplicate — emitted the same configuration events in
    // July. Only NttMinterSet decides what is a live manager.
    const decoy = row({ ...OUTBOUND_LIMIT_SET, contract: '0xba432ae7819a4b5c0393a924bd17e6922285e468' })
    expect(buildWormholeSafetyEvents([decoy], managers)).toEqual([])
  })

  it('ignores a log whose data is too short to decode', () => {
    expect(buildWormholeSafetyEvents([row({ ...OUTBOUND_LIMIT_SET, data: '0x00' })], managers)).toEqual([])
  })
})

describe('a limit restated at its current value', () => {
  it('does not append a previous value that reads the same', () => {
    // The managers were configured by setting the same uncapped limit twice, a
    // few blocks apart. "(was 184,467,440,737 USDC)" beside the identical new
    // figure reads as a mistake rather than as a change.
    const restated = row({
      topics: ['0x7e3b0fc388be9d36273f66210aed83be975df3a9adfffa4c734033f498f362cd'],
      data: '0x000000000000000000000000000000000000000000000000028f5c28f5c11a40'
        + '000000000000000000000000000000000000000000000000028f5c28f5c11a40',
    })
    const [event] = buildWormholeSafetyEvents([restated], managers)
    expect(event.detail).toBe('Transfers of USDC leaving Hydration for Ethereum over Wormhole are limited to 184,467,440,737 USDC in a rolling window.')
  })
})
