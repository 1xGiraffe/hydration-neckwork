import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  attachFeePurchases, decodeExecutorRequest, decodeMrlTransferTokens, executedXcmCostLegs, executedXcmPayloadLegs,
  parseOutboundXcm, suppressSubordinateActivityRows, EVM_GAS_ASSET_ID, WORMHOLE_EXECUTOR_REQUEST_TOPIC,
  type ActivityRow, type XcmFeeLeg,
} from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const occurrences = (needle: string): number => explorerService.split(needle).length - 1

const SENDER = `0x${'0a'.repeat(32)}`
const GLMR_LOC = { parents: 1, interior: { __kind: 'X2', value: [{ __kind: 'Parachain', value: 2004 }, { __kind: 'PalletInstance', value: 10 }] } }
const SUSDS_LOC = { parents: 1, interior: { __kind: 'X3', value: [{ __kind: 'Parachain', value: 2004 }, { __kind: 'PalletInstance', value: 110 }, { key: '0xda430218862d3db25de9f61458645dde49a9e9c1', __kind: 'AccountKey20' }] } }
const MOONBEAM_DEST = { parents: 1, interior: { __kind: 'X2', value: [{ __kind: 'Parachain', value: 2004 }, { key: '0x31d6f10a8341cb395ac5d893b30d813307d1ae88', __kind: 'AccountKey20' }] } }

// XTokens.TransferredAssets of extrinsic 13350241-2: an MRL send of 9,080.87 sUSDS
// to Moonbeam with 1 GLMR as the fee item (`feeItem: 1`).
const MRL_SEND = {
  sender: SENDER,
  assets: [
    { id: GLMR_LOC, fun: { __kind: 'Fungible', value: '1000000000000000000' } },
    { id: SUSDS_LOC, fun: { __kind: 'Fungible', value: '9080874080832233932062' } },
  ],
  fee: { id: GLMR_LOC, fun: { __kind: 'Fungible', value: '1000000000000000000' } },
  dest: MOONBEAM_DEST,
}

describe('parseOutboundXcm fee items', () => {
  it('reports the XTokens fee item beside another asset as the fee, not a payload', () => {
    const p = parseOutboundXcm(MRL_SEND)!
    expect(p.amounts).toEqual(['9080874080832233932062'])
    expect(p.fee).toEqual({ amount: '1000000000000000000' })
    expect(p.transact).toBe(false)
    expect(p.dest.destParachainId).toBe(2004)
  })

  // A single-leg send transfers and pays from one asset; its `fee` names the same leg.
  it('keeps a single-leg send whole and reports no fee', () => {
    const p = parseOutboundXcm({ ...MRL_SEND, assets: [MRL_SEND.assets[1]], fee: MRL_SEND.assets[1] })!
    expect(p.amounts).toEqual(['9080874080832233932062'])
    expect(p.fee).toBeNull()
  })

  // PolkadotXcm.Sent of the same extrinsic: WithdrawAsset 0.9 GLMR, BuyExecution, Transact —
  // Moonbeam executes the Wormhole call; nothing here is a Hydration leg.
  it('marks a Transact message and gives it no payload', () => {
    const p = parseOutboundXcm({
      origin: { parents: 0, interior: { __kind: 'X1', value: [{ network: { __kind: 'Polkadot' }, id: SENDER, __kind: 'AccountId32' }] } },
      destination: { parents: 1, interior: { __kind: 'X1', value: [{ __kind: 'Parachain', value: 2004 }] } },
      message: [
        { __kind: 'WithdrawAsset', value: [{ id: { parents: 0, interior: { __kind: 'X1', value: [{ __kind: 'PalletInstance', value: 10 }] } }, fun: { __kind: 'Fungible', value: '900000000000000000' } }] },
        { __kind: 'BuyExecution', fees: { fun: { __kind: 'Fungible', value: '900000000000000000' } }, weightLimit: { __kind: 'Unlimited' } },
        { __kind: 'Transact', originKind: { __kind: 'SovereignAccount' }, call: { encoded: '0x6d00' } },
      ],
    })!
    expect(p.transact).toBe(true)
    expect(p.amounts).toEqual([])
  })
})

describe('Wormhole Executor relay payment', () => {
  // EVM.Log 99 of extrinsic 14250166-2: RequestForExecution from the Executor
  // (0xd633d8d1…), amtPaid 0.000459216013967671 WETH — equal to the Tokens.Transfer of
  // WETH into the Executor's account two events earlier.
  it('decodes amtPaid from RequestForExecution', () => {
    expect(decodeExecutorRequest(
      [WORMHOLE_EXECUTOR_REQUEST_TOPIC, '0x000000000000000000000000a54008017941ece968623a0dd8ee907e2b133596'],
      '0x000000000000000000000000000000000000000000000000000' + '1a1a78f634137' + '0000000000000000000000000000000000000000000000000000000000000001',
    )).toEqual({ amountPaid: '459216013967671' })
  })
  it('ignores other logs and a zero payment', () => {
    expect(decodeExecutorRequest(['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'], '0x' + '0'.repeat(64))).toBeNull()
    expect(decodeExecutorRequest([WORMHOLE_EXECUTOR_REQUEST_TOPIC], '0x' + '0'.repeat(64))).toBeNull()
  })
  it('names WETH as the EVM native currency the payment is made in', () => {
    expect(EVM_GAS_ASSET_ID).toBe(20)
  })
})

describe('MRL arbiter fee', () => {
  // The Transact calldata of extrinsic 13350241-2 (EthereumXcm.transact → Wormhole
  // TokenBridge.transferTokens): 9,080.87 sUSDS to chain 2 (Ethereum), arbiterFee 0.
  const CALL = '0x6d0000404b4c000000000000000000000000000000000000000000000000000000000001' + '00'.repeat(40)
    + '0f5287b0'
    + '000000000000000000000000da430218862d3db25de9f61458645dde49a9e9c1'
    + '0000000000000000000000000000000000000000000001ec46718ffbe928051e'
    + '0000000000000000000000000000000000000000000000000000000000000002'
    + '00000000000000000000000036675cb19cb6c796b02d3b842595c72e7da4aea8'
    + '0000000000000000000000000000000000000000000000000000000000000000'
    + '0000000000000000000000000000000000000000000000000000000000000000'
  it('decodes the bridged amount, chain and arbiter fee', () => {
    expect(decodeMrlTransferTokens(CALL)).toEqual({ amount: '9080874080832233932062', recipientChain: 2, arbiterFee: '0' })
  })
  it('reads a nonzero arbiter fee (290 of the 2,008 MRL sends set one)', () => {
    const withFee = CALL.replace('0000000000000000000000000000000000000000000000000000000000000000' + '0000000000000000000000000000000000000000000000000000000000000000',
      '00000000000000000000000000000000000000000000000000000000000f4240' + '0000000000000000000000000000000000000000000000000000000000000000')
    expect(decodeMrlTransferTokens(withFee)?.arbiterFee).toBe('1000000')
  })
  it('returns null for a message that is not a TokenBridge transfer (the inbound GMP relay)', () => {
    expect(decodeMrlTransferTokens('0x6d0001404b4c00' + 'f53774ab' + '00'.repeat(200))).toBeNull()
  })
})

const leg = (event_index: number, cid: number, amount: string, who = SENDER) => ({ block_height: 13797529, extrinsic_index: 2, event_index, who, cid, amount })
const key = (l: { block_height: number; extrinsic_index: number | null; who: string }) => `${l.block_height}:${l.extrinsic_index}:${l.who}`

describe('executor send cost legs', () => {
  // 13797529: the user withdrew HDX (swap input), DOT (delivery fee) and USDC (payload).
  it('are every admitted leg but the payload', () => {
    const legs = [leg(3, 0, '142000000000000'), leg(5, 5, '5000000000'), leg(9, 21, '16380000')]
    expect(executedXcmPayloadLegs(legs, key, l => l.event_index)).toEqual([legs[2]])
    expect([...executedXcmCostLegs(legs, key, l => l.event_index).get(key(legs[0]))!]).toEqual([legs[0], legs[1]])
  })
})

const fee = (assetId: number, amount: string, kind: XcmFeeLeg['kind'] = 'delivery'): XcmFeeLeg =>
  ({ kind, asset: { assetId, iconAssetId: assetId, symbol: `A${assetId}`, name: `A${assetId}`, decimals: 12, parachainId: null, origin: null }, amount, valueUsd: null })

describe('attachFeePurchases', () => {
  it('drops the swap input leg and attaches the swap as the purchase of its output leg', () => {
    const out = attachFeePurchases([fee(0, '142000000000000'), fee(5, '5000000000')], [{ assetIn: 0, amountIn: '142000000000000', assetOut: 5, valueInUsd: 1.25 }])
    expect(out.map(f => f.asset.assetId)).toEqual([5])
    expect(out[0].purchase).toMatchObject({ amount: '142000000000000', valueUsd: 1.25 })
    expect(out[0].purchase?.asset.assetId).toBe(0)
  })
  it('leaves legs no swap explains untouched', () => {
    const out = attachFeePurchases([fee(16, '1000000000000000000')], [{ assetIn: 0, amountIn: '1', assetOut: 21 }])
    expect(out).toHaveLength(1)
    expect(out[0].purchase).toBeUndefined()
  })
})

const row = (type: ActivityRow['type'], overrides: Partial<ActivityRow> = {}): ActivityRow => ({
  type, blockHeight: 13350241, timestamp: '2026-08-01 00:00:00', eventIndex: 1, extrinsicIndex: 2,
  who: { accountId: SENDER } as ActivityRow['who'], to: null, asset: null, assetIn: null, assetOut: null,
  amount: null, amountIn: null, amountOut: null, valueUsd: null, ...overrides,
})
const aref = (assetId: number) => fee(assetId, '0').asset

describe('a swap that bought a send its fee folds behind the send', () => {
  // Extrinsic 13350241-2: Router.buy HDX → 1 GLMR, then the MRL send with GLMR as fee item.
  it('drops the trade and records it as the fee leg\'s purchase, on a copy of the send', () => {
    const send = row('xcm', { eventIndex: 74, xcmDir: 'out', asset: aref(1000745), amount: '9080874080832233932062', xcmFees: [fee(16, '1000000000000000000')] })
    const trade = row('trade', { eventIndex: 67, assetIn: aref(0), assetOut: aref(16), amountIn: '1089769036988', amountOut: '1000000000000000000', valueUsd: 0.0095 })
    const out = suppressSubordinateActivityRows([trade, send])
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('xcm')
    expect(out[0].xcmFees?.[0].purchase).toMatchObject({ amount: '1089769036988', valueUsd: 0.0095 })
    expect(out[0].xcmFees?.[0].purchase?.asset.assetId).toBe(0)
    // The arm's cached row is not written to.
    expect(send.xcmFees?.[0].purchase).toBeUndefined()
  })

  it('keeps a swap whose output is the payload, not a fee (a deliberate sell-then-send)', () => {
    const send = row('xcm', { eventIndex: 74, xcmDir: 'out', asset: aref(1000745), amount: '9080874080832233932062', xcmFees: [fee(16, '1000000000000000000')] })
    const trade = row('trade', { eventIndex: 67, assetIn: aref(21), assetOut: aref(1000745), amountIn: '9000000000', amountOut: '9080874080832233932062' })
    expect(suppressSubordinateActivityRows([trade, send]).map(r => r.type)).toEqual(['trade', 'xcm'])
  })

  it('keeps a swap beside a send that claims no fee', () => {
    const send = row('xcm', { eventIndex: 74, xcmDir: 'out', asset: aref(5), amount: '1' })
    const trade = row('trade', { eventIndex: 67, assetIn: aref(0), assetOut: aref(16), amountIn: '1', amountOut: '1' })
    expect(suppressSubordinateActivityRows([trade, send]).map(r => r.type)).toEqual(['trade', 'xcm'])
  })

  // Extrinsic 14250166-2: Router.buy HDX → 0.000464 WETH, NTT transfer of PRIME, then the
  // Executor request paid 0.000459 WETH — the relayer fee of the Wormhole send.
  it('folds the WETH purchase behind a Wormhole send that paid the Executor', () => {
    const send = row('xcm', { eventIndex: 77, xcmDir: 'out', bridge: 'Wormhole', asset: aref(43), amount: '29982990000', xcmFees: [fee(EVM_GAS_ASSET_ID, '459216013967671', 'relayer')] })
    const trade = row('trade', { eventIndex: 64, assetIn: aref(0), assetOut: aref(EVM_GAS_ASSET_ID), amountIn: '142901112909325', amountOut: '464616013967671' })
    const out = suppressSubordinateActivityRows([trade, send])
    expect(out.map(r => r.type)).toEqual(['xcm'])
    expect(out[0].xcmFees?.[0]).toMatchObject({ kind: 'relayer', amount: '459216013967671' })
    expect(out[0].xcmFees?.[0].purchase?.amount).toBe('142901112909325')
  })
})

// The surfaces that read trades WITHOUT their send beside them apply the same rule as
// SQL: the account count arm (or its total numbers pages the feed does not hold) and the
// three trade-bearing feeds. Pinning the call sites keeps a new feed from re-growing the
// swap rows the fold removes.
describe('the fee-purchase fold is mirrored where trades are read alone', () => {
  it('is one SQL statement used by the count arm and resolved once per feed', () => {
    expect(occurrences('feePurchaseSwapSelectSql(')).toBe(4)   // definition, helper, count arm ×2
    expect(occurrences('await feePurchaseSwapKeys(trades)')).toBe(3)  // global, asset, account feeds
    expect(explorerService).toContain("topic0 = '${WORMHOLE_EXECUTOR_REQUEST_TOPIC}'")
  })
})
