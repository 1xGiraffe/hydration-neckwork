import { describe, it, expect } from 'vitest'
import { dedupeTransferEvents } from '../src/services/explorerService.ts'

// HOLLAR's canonical balance lives in an EVM contract, so a HOLLAR movement can
// reach the indexer twice: as a substrate Currencies.Transferred and as the
// contract's own ERC-20 Transfer log. The two name the same accounts in
// different forms — the substrate event carries the real AccountId32, the log
// carries the runtime's 20-byte truncation of it — so transfer identity has to
// compare accounts truncated, or the same movement renders twice.
//
// Measured on 2026-07-01..08-03 HOLLAR legs: 74,891 legs have a twin whose
// substrate side is a real (non-ETH-prefixed) account id, so keying the log leg
// on its ETH-prefixed form alone would double-render every one of them.
const REAL = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d'
const REAL_TRUNCATED = '0x45544800d43593c715fdd31c61141abd04a99fd6822c85580000000000000000'
const MODULE = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'
const MODULE_TRUNCATED = '0x455448006d6f646c70792f747273727900000000000000000000000000000000'
const OTHER = '0x1111111111111111111111111111111111111111111111111111111111111111'

const leg = (over: Partial<Parameters<typeof dedupeTransferEvents>[0][number]> = {}) => ({
  block_height: 13443111,
  ts: '2026-08-03 12:58:42',
  event_index: 22,
  extrinsic_index: 3,
  event_name: 'EVM.Transfer',
  from_acc: REAL_TRUNCATED,
  to_acc: MODULE_TRUNCATED,
  amount: '491542320828010040074040',
  asset_id: 222,
  ...over,
})

describe('transfer identity across the substrate/EVM boundary', () => {
  it('drops an EVM leg whose substrate twin names the real account id', () => {
    const rows = [
      leg(),
      leg({ event_name: 'Currencies.Transferred', event_index: 23, from_acc: REAL, to_acc: MODULE }),
    ]

    expect(dedupeTransferEvents(rows).map(r => r.event_name)).toEqual(['Currencies.Transferred'])
  })

  it('keeps an EVM leg that has no substrate twin', () => {
    expect(dedupeTransferEvents([leg()]).map(r => r.event_name)).toEqual(['EVM.Transfer'])
  })

  it('still prefers Currencies.Transferred over Tokens.Transfer', () => {
    const rows = [
      leg({ event_name: 'Tokens.Transfer', from_acc: REAL, to_acc: MODULE }),
      leg({ event_name: 'Currencies.Transferred', event_index: 23, from_acc: REAL, to_acc: MODULE }),
    ]

    expect(dedupeTransferEvents(rows).map(r => r.event_name)).toEqual(['Currencies.Transferred'])
  })

  it('does not collapse legs between different accounts', () => {
    const rows = [
      leg(),
      leg({ event_name: 'Currencies.Transferred', event_index: 23, from_acc: OTHER, to_acc: MODULE }),
    ]

    expect(dedupeTransferEvents(rows)).toHaveLength(2)
  })

  it('does not collapse legs of different amounts between the same accounts', () => {
    const rows = [
      leg(),
      leg({ event_name: 'Currencies.Transferred', event_index: 23, from_acc: REAL, to_acc: MODULE, amount: '1' }),
    ]

    expect(dedupeTransferEvents(rows)).toHaveLength(2)
  })
})
