import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { XCM_CALL_DESTINATION_ARGS, xcmCallDestinationArgs, xcmDestinationFromCallArgs } from '../src/services/explorerService.ts'
import { XCM_CALL_DESTINATIONS_SELECT, XCM_CALL_DESTINATIONS_WHERE } from '../src/db/schemaBootstrap.ts'

const schema = readFileSync(new URL('../../clickhouse/schema/013_xcm_call_destinations.sql', import.meta.url), 'utf8')
const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// Hydration sets `XcmEventEmitter = ()`, so a message the xcm EXECUTOR dispatches
// leaves only XcmpQueue.XcmpMessageSent — a bare hash. Those sends get a row from
// their withdrawal, and the row had NO destination at all: no chain, no account, no
// message id. Measured above block 14,500,000: 15 of 153 outbound sends (~10%).
//
// The destination is not lost, only elsewhere — the extrinsic's own call args carry
// it, and this reads it from there.

const ALICE = '0x091cbd233fb39516ff1e26a64af98cd466e8a502c0536508cb01e9143a10519c'
const versioned = (value: unknown) => ({ __kind: 'V4', value })
const account = (id: string) => ({ parents: 0, interior: { __kind: 'X1', value: [{ __kind: 'AccountId32', id }] } })

describe('xcmDestinationFromCallArgs', () => {
  // The real shape of block 14,648,943 extrinsic 2: 9,785 DOT to Bifrost, reserve-
  // routed through AssetHub, whose beneficiary sits in customXcmOnDest.
  it('reads a transfer_assets_using_type_and_then, beneficiary and all', () => {
    expect(xcmDestinationFromCallArgs({
      dest: versioned({ parents: 1, interior: { __kind: 'X1', value: [{ __kind: 'Parachain', value: 2030 }] } }),
      assetsTransferType: { __kind: 'RemoteReserve', value: versioned({ parents: 1, interior: { __kind: 'X1', value: [{ __kind: 'Parachain', value: 1000 }] } }) },
      customXcmOnDest: versioned([{ __kind: 'DepositAsset', beneficiary: account(ALICE) }]),
    })).toMatchObject({
      destChain: 'Bifrost',
      destParachainId: 2030,
      destAccount: expect.objectContaining({ subscanUrl: expect.stringContaining('bifrost.subscan.io') }),
    })
  })

  // The older call names its beneficiary directly.
  it('reads a limited_reserve_transfer_assets’ top-level beneficiary', () => {
    expect(xcmDestinationFromCallArgs({
      dest: versioned({ parents: 1, interior: { __kind: 'X1', value: [{ __kind: 'Parachain', value: 1000 }] } }),
      beneficiary: versioned(account(ALICE)),
    })).toMatchObject({ destChain: 'AssetHub', destParachainId: 1000 })
  })

  // The version envelope is not always there, and the relay is parents:1 with no
  // Parachain junction at all.
  it('takes an unversioned location, and the relay', () => {
    expect(xcmDestinationFromCallArgs({
      dest: { parents: 1, interior: { __kind: 'Here' } },
      beneficiary: account(ALICE),
    })).toMatchObject({ destChain: 'Polkadot', destParachainId: null })
  })

  // Block 16,264,304 extrinsic 2, as indexed: 100 USDT to Ethereum, a v5 program the
  // wallet built. It names AssetHub (InitiateTransfer → Parachain 1000), and AssetHub's
  // program swaps DOT for the bridge fee and forwards to Ethereum (a nested
  // InitiateTransfer → GlobalConsensus Ethereum) with the recipient. The appendix
  // refunds the SENDER on AssetHub and is not the recipient.
  it('reads an execute program built from v5 InitiateTransfer, through to Ethereum', () => {
    const SENDER = '0x6e141c9f322c377b82418ddb514005260d40e6aaa11acd388961cc33914a8949'
    const RECIPIENT = '0x326e5e5024e1ad738ebd3a1a724d51a94d68d315'
    const TOPIC = '0xbb06fe37f98fed6dd9de967d05d9e851e3eeca47859e3dd41d78c31dc1035c88'
    const ethereum = { parents: 2, interior: { __kind: 'X1', value: [{ __kind: 'GlobalConsensus', value: { chainId: '1', __kind: 'Ethereum' } }] } }
    const refund = { __kind: 'SetAppendix', value: [{ __kind: 'RefundSurplus' }, { __kind: 'DepositAsset', assets: { __kind: 'Wild', value: { __kind: 'All' } }, beneficiary: account(SENDER) }] }
    const args = {
      message: { __kind: 'V5', value: [
        { __kind: 'WithdrawAsset', value: [] },
        { __kind: 'PayFees', asset: { id: { parents: 1, interior: { __kind: 'Here' } }, fun: { __kind: 'Fungible', value: '11487300' } } },
        refund,
        {
          __kind: 'InitiateTransfer',
          destination: { parents: 1, interior: { __kind: 'X1', value: [{ __kind: 'Parachain', value: 1000 }] } },
          preserveOrigin: true,
          remoteXcm: [
            refund,
            { __kind: 'ExchangeAsset', give: {}, want: [], maximal: false },
            {
              __kind: 'InitiateTransfer', destination: ethereum, preserveOrigin: true,
              remoteXcm: [
                { __kind: 'DepositAsset', assets: { __kind: 'Wild', value: { __kind: 'AllCounted', value: 3 } }, beneficiary: { parents: 0, interior: { __kind: 'X1', value: [{ __kind: 'AccountKey20', key: RECIPIENT }] } } },
                { __kind: 'SetTopic', value: TOPIC },
              ],
            },
            { __kind: 'SetTopic', value: TOPIC },
          ],
        },
        { __kind: 'SetTopic', value: TOPIC },
      ] },
      maxWeight: { refTime: '20000000000', proofSize: '500000' },
    }
    const dest = xcmDestinationFromCallArgs(args)
    expect(dest).toMatchObject({ destChain: 'Ethereum', destParachainId: null, messageId: TOPIC })
    // The Ethereum address itself, linked on Etherscan (chain id 1, from the program).
    expect(dest?.destAccount).toMatchObject({ kind: 'AccountKey20', address: RECIPIENT, subscanUrl: `https://etherscan.io/address/${RECIPIENT}` })
  })

  it('is null for a call that names no destination', () => {
    expect(xcmDestinationFromCallArgs({ value: '1' })).toBeNull()
    expect(xcmDestinationFromCallArgs(null)).toBeNull()
  })
})

// The feed reads these destinations from `xcm_call_destinations`, a projection holding
// ONLY the top-level args the decoder reads, as raw JSON slices — never from
// raw_extrinsics, whose `call_args_json` is the widest column in the database and cost
// ~2 GiB per page for ~1 MiB of result. The projection is correct only while its slice
// set is the decoder's key set; these pin the two together.
describe('xcm_call_destinations projection', () => {
  const parachain = (id: number) => ({ parents: 1, interior: { __kind: 'X1', value: [{ __kind: 'Parachain', value: id }] } })
  const dot = { id: { parents: 1, interior: { __kind: 'Here' } }, fun: { __kind: 'Fungible', value: '97850000000000' } }
  // One realistic full-args shape per PolkadotXcm call family seen on chain, carrying
  // every OTHER top-level key those calls have — so a decoder that starts reading one
  // of them (`message`, `assets`, …) fails the equivalence below until the schema stores it.
  const CALLS: Record<string, Record<string, unknown>> = {
    transfer_assets_using_type_and_then: {
      dest: versioned(parachain(2030)),
      assets: versioned([dot]),
      assetsTransferType: { __kind: 'RemoteReserve', value: versioned(parachain(1000)) },
      remoteFeesId: versioned({ __kind: 'V4', value: dot.id }),
      feesTransferType: { __kind: 'RemoteReserve', value: versioned(parachain(1000)) },
      customXcmOnDest: versioned([
        { __kind: 'SetAppendix', value: [{ __kind: 'DepositAsset', assets: { __kind: 'Wild', value: { __kind: 'AllCounted', value: 1 } }, beneficiary: account('0x' + 'ee'.repeat(32)) }] },
        { __kind: 'DepositAsset', assets: { __kind: 'Wild', value: { __kind: 'AllCounted', value: 1 } }, beneficiary: account(ALICE) },
      ]),
      weightLimit: { __kind: 'Unlimited' },
    },
    transfer_assets: {
      dest: versioned(parachain(1000)),
      beneficiary: versioned(account(ALICE)),
      assets: versioned([dot]),
      feeAssetItem: 0,
      weightLimit: { __kind: 'Unlimited' },
    },
    limited_reserve_transfer_assets: {
      dest: versioned(parachain(2004)),
      beneficiary: versioned({ parents: 0, interior: { __kind: 'X1', value: [{ __kind: 'AccountKey20', key: '0x' + 'ab'.repeat(20) }] } }),
      assets: versioned([dot]),
      feeAssetItem: 0,
      weightLimit: { __kind: 'Limited', value: { refTime: '4000000000', proofSize: '65536' } },
    },
    // A bare send names its chain but no beneficiary; the program is not read.
    send: {
      dest: versioned(parachain(1000)),
      message: versioned([{ __kind: 'WithdrawAsset', value: [dot] }, { __kind: 'DepositAsset', assets: { __kind: 'Wild', value: { __kind: 'All' } }, beneficiary: account(ALICE) }]),
    },
    // An inline program: the executor dispatches whatever it says, and no `dest` is named.
    execute: {
      message: versioned([{ __kind: 'WithdrawAsset', value: [dot] }, { __kind: 'InitiateReserveWithdraw', assets: { __kind: 'Wild', value: { __kind: 'All' } }, reserve: parachain(1000), xcm: [{ __kind: 'DepositAsset', assets: { __kind: 'Wild', value: { __kind: 'All' } }, beneficiary: account(ALICE) }] }]),
      maxWeight: { refTime: '6000000000', proofSize: '131072' },
    },
    claim_assets: { assets: versioned([dot]), beneficiary: versioned(account(ALICE)) },
  }
  // What the MV stores of a call: each slice's own JSON, or '' when the arg is absent.
  const stored = (args: Record<string, unknown>): Record<string, string> => Object.fromEntries(
    Object.entries(XCM_CALL_DESTINATION_ARGS).map(([key, column]) => [column, key in args ? JSON.stringify(args[key]) : '']),
  )

  it('decodes the stored slices to exactly the destination the full call args give', () => {
    for (const [name, args] of Object.entries(CALLS)) {
      expect(xcmDestinationFromCallArgs(xcmCallDestinationArgs(stored(args))), name).toEqual(xcmDestinationFromCallArgs(args))
    }
    // The two shapes that resolve a beneficiary do resolve one through the slices.
    expect(xcmDestinationFromCallArgs(xcmCallDestinationArgs(stored(CALLS.transfer_assets_using_type_and_then)))?.destAccount?.accountId).toBe(ALICE)
    expect(xcmDestinationFromCallArgs(xcmCallDestinationArgs(stored(CALLS.limited_reserve_transfer_assets)))?.destAccount?.kind).toBe('AccountKey20')
  })

  it('stores a call when it names a dest or is an inline program — the decoder answers null for every other', () => {
    for (const [name, args] of Object.entries(CALLS)) {
      if (!('dest' in args) && name !== 'execute') expect(xcmDestinationFromCallArgs(args), name).toBeNull()
    }
    expect(xcmDestinationFromCallArgs(CALLS.execute)).toMatchObject({ destChain: 'AssetHub', destParachainId: 1000 })
    expect(schema).toContain(`WHERE ${XCM_CALL_DESTINATIONS_WHERE};`)
  })

  // The swap-window replay and the execute-history backfill (schemaBootstrap) read
  // raw_extrinsics exactly as the view does.
  it('replays through the view\'s own SELECT', () => {
    const viewSelect = schema.slice(schema.indexOf('SELECT block_height, extrinsic_index'), schema.indexOf('FROM price_data.raw_extrinsics')).replace(/\s+/g, ' ').trim()
    expect(viewSelect).toBe(`SELECT ${XCM_CALL_DESTINATIONS_SELECT}`)
  })

  it('declares the block-keyed table before its MV, with one slice column per key the decoder reads', () => {
    const table = schema.indexOf('CREATE TABLE IF NOT EXISTS price_data.xcm_call_destinations (')
    const mv = schema.indexOf('CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.xcm_call_destinations_mv')
    expect(table).toBeGreaterThanOrEqual(0)
    expect(mv).toBeGreaterThan(table)
    expect(schema).toContain('ENGINE = ReplacingMergeTree(ingested_at)')
    expect(schema).toContain('ORDER BY (block_height, extrinsic_index)')
    expect(schema).toContain('FROM price_data.raw_extrinsics')
    for (const [key, column] of Object.entries(XCM_CALL_DESTINATION_ARGS)) {
      expect(schema).toContain(`\`${column}\` String`)
      expect(schema).toContain(`JSONExtractRaw(call_args_json, '${key}') AS ${column}`)
    }
  })

  it('is the only source both destination reads use', () => {
    // The feed's batched read and the extrinsic page's point read.
    expect(explorerService.split('FROM price_data.xcm_call_destinations FINAL').length - 1).toBe(2)
    // No query template reads PolkadotXcm call args off raw_extrinsics any more.
    expect(/FROM price_data\.raw_extrinsics[^`]*PolkadotXcm\./.test(explorerService)).toBe(false)
  })
})
