import { describe, expect, it } from 'vitest'
import { extractXcmActivityRows } from '../../src/raw/xcm.ts'
import type { RawEvent } from '../../src/raw/processor.ts'

describe('raw XCM extraction', () => {
  it('records XCM activity and reads the destination out of the message', () => {
    const events = [
      {
        name: 'PolkadotXcm.Sent',
        index: 1,
        extrinsicIndex: 0,
        block: { height: 10 },
        args: {
          destination: { parents: 1, interior: { __kind: 'X1', value: { __kind: 'Parachain', value: 1000 } } },
          messageHash: `0x${'ab'.repeat(32)}`,
          assets: [{ id: 5, fun: { Fungible: '12' } }],
        },
      },
      {
        name: 'Snowbridge.MessageAccepted',
        index: 2,
        extrinsicIndex: 0,
        block: { height: 10 },
        args: {
          ethereumRecipient: '0xf34e845538cc8a498edd97d7cde16fdfef3d4d99',
          amount: '99',
        },
      },
      {
        name: 'Broadcast.Swapped',
        index: 3,
        extrinsicIndex: 0,
        block: { height: 10 },
        args: {
          who: '0x45544800f34e845538cc8a498edd97d7cde16fdfef3d4d990000000000000000',
          operationStack: ['omnipool', 'xyk'],
          amountIn: '1',
        },
      },
    ] as RawEvent[]

    const rows = extractXcmActivityRows(events, [], '2026-01-01 00:00:00', 'test')

    // Only the PolkadotXcm event is XCM activity: the Snowbridge and Broadcast
    // events in the same block must not be mistaken for it.
    expect(rows).toHaveLength(1)
    expect(rows[0].direction).toBe('outbound')
    expect(rows[0].message_hash).toBe(`0x${'ab'.repeat(32)}`)
  })

  it('excludes the per-block set_validation_data inherent but keeps real ParachainSystem XCM', () => {
    const events = [
      {
        name: 'ParachainSystem.set_validation_data',
        index: 0,
        extrinsicIndex: 0,
        block: { height: 20 },
        args: { data: { validationData: { relayParentStorageRoot: `0x${'cd'.repeat(32)}` } } },
      },
      {
        name: 'ParachainSystem.DownwardMessagesReceived',
        index: 1,
        extrinsicIndex: 0,
        block: { height: 20 },
        args: { count: 1 },
      },
    ] as RawEvent[]

    const rows = extractXcmActivityRows(events, [], '2026-01-01 00:00:00', 'test')

    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('ParachainSystem.DownwardMessagesReceived')
  })
})

describe('PolkadotXcm.Sent account extraction', () => {
  // pallet_xcm nests the sender inside the origin multilocation junction and
  // the beneficiary inside the message's DepositAsset instruction — neither is
  // a direct key:account pair, so the extractor must dig into the subtree.
  it('extracts sender from the origin junction and recipient from the beneficiary', () => {
    const sender = `0x${'11'.repeat(32)}`
    const recipient = `0x${'22'.repeat(32)}`
    const events = [{
      name: 'PolkadotXcm.Sent',
      index: 17,
      extrinsicIndex: 2,
      block: { height: 123 },
      args: {
        origin: { parents: 0, interior: { __kind: 'X1', value: [{ network: { __kind: 'Polkadot' }, id: sender, __kind: 'AccountId32' }] } },
        destination: { parents: 1, interior: { __kind: 'X1', value: [{ __kind: 'Parachain', value: 1000 }] } },
        message: [
          { __kind: 'WithdrawAsset', value: [{ id: { parents: 1, interior: { __kind: 'Here' } }, fun: { __kind: 'Fungible', value: '1000' } }] },
          { __kind: 'ClearOrigin' },
          { assets: { __kind: 'Wild', value: { __kind: 'AllCounted', value: 1 } }, beneficiary: { parents: 0, interior: { __kind: 'X1', value: [{ id: recipient, __kind: 'AccountId32' }] } }, __kind: 'DepositAsset' },
        ],
        messageId: `0x${'33'.repeat(32)}`,
      },
    }] as unknown as RawEvent[]
    const rows = extractXcmActivityRows(events, [], '2026-01-01 00:00:00', 'test')
    const sent = rows.find(r => r.name === 'PolkadotXcm.Sent')!
    expect(sent.sender).toBe(sender)
    expect(sent.recipient).toBe(recipient)
  })
})

// Every extrinsic's top-level call has the empty call path, which
// callAddressToString renders as 'root'. Since raw_xcm_activity replaces on
// (block_height, source_kind, source_index, name), a per-extrinsic call source
// index is what keeps two independent root-level calls of the same name in one
// block from destroying each other.
describe('call source identity', () => {
  const rootCall = (extrinsicIndex: number, name: string, args: unknown) => ({
    id: `0000000010-00000${extrinsicIndex}-abcde`,
    name,
    address: [],
    extrinsicIndex,
    block: { height: 10 },
    args,
  })

  it('keeps two root-level XCM calls in one block distinct', () => {
    const args = {
      dest: { parents: 1, interior: { __kind: 'X1', value: { __kind: 'Parachain', value: 1000 } } },
      assets: [{ id: 5, fun: { Fungible: '12' } }],
    }
    const calls = [
      rootCall(2, 'PolkadotXcm.transfer_assets_using_type_and_then', args),
      rootCall(3, 'PolkadotXcm.transfer_assets_using_type_and_then', args),
    ] as never

    const rows = extractXcmActivityRows([], calls, '2026-01-01 00:00:00', 'test')
    const indexes = rows.filter(r => r.source_kind === 'call').map(r => r.source_index)

    expect(indexes).toHaveLength(2)
    expect(new Set(indexes).size).toBe(2)
  })

  it('separates a nested call from the same path in another extrinsic', () => {
    const nested = (extrinsicIndex: number) => ({
      id: `0000000010-00000${extrinsicIndex}-nested`,
      name: 'PolkadotXcm.send',
      address: [0, 1],
      extrinsicIndex,
      block: { height: 10 },
      args: { dest: { parents: 1, interior: { __kind: 'Here' } } },
    })
    const calls = [nested(2), nested(5)] as never

    const rows = extractXcmActivityRows([], calls, '2026-01-01 00:00:00', 'test')
    const indexes = rows.filter(r => r.source_kind === 'call').map(r => r.source_index)

    expect(new Set(indexes).size).toBe(2)
  })
})
