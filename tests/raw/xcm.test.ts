import { describe, expect, it } from 'vitest'
import { extractXcmBridgeAndOperationRows } from '../../src/raw/xcm.ts'
import type { RawEvent } from '../../src/raw/processor.ts'

describe('raw XCM, bridge, and operation trace extraction', () => {
  it('records XCM activity, bridge evidence, and Broadcast operation traces', () => {
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

    const rows = extractXcmBridgeAndOperationRows(events, [], '2026-01-01 00:00:00', 'test')

    expect(rows.xcmActivity).toHaveLength(1)
    expect(rows.xcmActivity[0].direction).toBe('outbound')
    expect(rows.xcmActivity[0].message_hash).toBe(`0x${'ab'.repeat(32)}`)
    expect(rows.bridgeEvidence).toHaveLength(1)
    expect(rows.bridgeEvidence[0].bridge_kind).toBe('snowbridge')
    expect(rows.bridgeEvidence[0].external_account).toBe('0xf34e845538cc8a498edd97d7cde16fdfef3d4d99')
    expect(rows.operationTraces).toHaveLength(1)
    expect(rows.operationTraces[0].operation_name).toBe('Broadcast.Swapped')
    expect(rows.operationTraces[0].account_id).toBe('0x45544800f34e845538cc8a498edd97d7cde16fdfef3d4d990000000000000000')
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

    const rows = extractXcmBridgeAndOperationRows(events, [], '2026-01-01 00:00:00', 'test')

    expect(rows.xcmActivity).toHaveLength(1)
    expect(rows.xcmActivity[0].name).toBe('ParachainSystem.DownwardMessagesReceived')
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
    const rows = extractXcmBridgeAndOperationRows(events, [], '2026-01-01 00:00:00', 'test')
    const sent = rows.xcmActivity.find(r => r.name === 'PolkadotXcm.Sent')!
    expect(sent.sender).toBe(sender)
    expect(sent.recipient).toBe(recipient)
  })
})
