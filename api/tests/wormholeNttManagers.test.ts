import { describe, expect, it } from 'vitest'
import {
  buildNttManagers,
  decodeErc20Transfer,
  nttErc20ManagerOf,
  nttManagerAccount,
  nttManagerOfLeg,
  resolveLockManagers,
  type NttLockObservation,
} from '../src/services/wormholeNttManagers.ts'
import { decodeNttExtrinsicLogs, nttArrivalRow, nttErc20Owner, nttSendRow } from '../src/services/explorerService.ts'

// HDX (asset 0) and HOLLAR (asset 222, an Erc20 registry asset at 0x531a…) are LOCKED on
// Hydration and minted on Robinhood (Wormhole chain 72). Neither manager is in the
// runtime's minter registry, so a reader that only knew minters showed these sends as
// nothing but the swap beside them. Every fixture below is a real indexed row.
const HDX_MANAGER = '0x16ac5b8d9078ed4cf5a522f907fd9ddb6c8841f1'
const HOLLAR_MANAGER = '0x4188f147eec68921c1ee2d72898a263722a76844'
const HOLLAR_TOKEN = '0x531a654d1696ed52e7275a8cede955e82620f99a'
const NTTUSD_TEST_MANAGER = '0xba432ae7819a4b5c0393a924bd17e6922285e468'
const SENDER = '0xa4e6cf775b22fc5f38b36e1b6752d0c1eabab435ccf737bbbeef823e415f5236' // 14jDRF…
const RECIPIENT = '0x82fb02afe02fe5d6c793145a75e6860c4e206682c3ab395a9d2a941eb7c0d30d'
const ROBINHOOD_RECIPIENT = '0x59197b192f4104982196da9a003c934736f0ac3d'

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const TRANSFER_SENT = '0xe54e51e42099622516fa3b48e9733581c9dbdcb771cafb093f745a0532a35982'
const RECEIVED_MESSAGE = '0xf6fc529540981400dc64edf649eb5e2e0eb5812a27f8c81bac2c1d317e71a5f0'
const TRANSFER_REDEEMED = '0x504e6efe18ab9eed10dc6501a417f5b12a2f7f2b1593aed9b89f9bce3cf29a91'
const pad = (h160: string) => '0x' + '0'.repeat(24) + h160.slice(2)

// 15,705,909 e2 (HOLLAR, 10) and 15,705,950 e5 (HDX, 20): TransferSent to chain 72.
const hollarSent = {
  contract: HOLLAR_MANAGER,
  topics: [TRANSFER_SENT, pad(ROBINHOOD_RECIPIENT), pad(ROBINHOOD_RECIPIENT)],
  data: '0x0000000000000000000000000000000000000000000000008ac7230489e80000'
    + '0000000000000000000000000000000000000000000000000000000000000000'
    + '0000000000000000000000000000000000000000000000000000000000000048'
    + '0000000000000000000000000000000000000000000000000000000000000008',
}
const hollarLock = {
  contract: HOLLAR_TOKEN,
  topics: [TRANSFER, pad('0xa4e6cf775b22fc5f38b36e1b6752d0c1eabab435'), pad(HOLLAR_MANAGER)],
  data: '0x0000000000000000000000000000000000000000000000008ac7230489e80000',
}
const hdxSent = {
  contract: HDX_MANAGER,
  topics: [TRANSFER_SENT, pad(ROBINHOOD_RECIPIENT), pad(ROBINHOOD_RECIPIENT)],
  data: '0x000000000000000000000000000000000000000000000000000012309ce54000'
    + '0000000000000000000000000000000000000000000000000000000000000000'
    + '0000000000000000000000000000000000000000000000000000000000000048'
    + '0000000000000000000000000000000000000000000000000000000000000008',
}
// 15,503,028 e3 (HDX release, 10) and 15,503,023 e3 (HOLLAR release, 1) from chain 72.
const hdxRedeem = [
  {
    contract: '0xdde268d8b89834f6ef213002651d0586ced646b9',
    topics: [RECEIVED_MESSAGE],
    data: '0x2f95bf3f4af714d7d14d2d341766943b4699c91ec97c7505e6a23cdf1a13a6ee'
      + '0000000000000000000000000000000000000000000000000000000000000048'
      + '00000000000000000000000097cd0d08c376005d09afcc47fa9ce0c384fba406'
      + '0000000000000000000000000000000000000000000000000000000000000003',
  },
  { contract: HDX_MANAGER, topics: [TRANSFER_REDEEMED, '0xee82bfefd86b1d999d5e1f45c812a7b756a411fcf96f2ddd6e5936e2fd73135b'], data: '0x' },
]
const hollarRelease = {
  contract: HOLLAR_TOKEN,
  topics: [TRANSFER, pad(HOLLAR_MANAGER), pad('0x82fb02afe02fe5d6c793145a75e6860c4e206682')],
  data: '0x0000000000000000000000000000000000000000000000000de0b6b3a7640000',
}

const managers = buildNttManagers(
  new Map([[20, '0x45544800b5cef790d52a57fa619ed96edd64c5328f3dcfb70000000000000000']]),
  new Map([[HDX_MANAGER, { assetId: 0, erc20: null }], [HOLLAR_MANAGER, { assetId: 222, erc20: HOLLAR_TOKEN }]]),
)

describe('decodeErc20Transfer', () => {
  it('reads the parties and value of a real HOLLAR lock and release', () => {
    expect(decodeErc20Transfer(hollarLock.topics, hollarLock.data)).toEqual({
      from: '0xa4e6cf775b22fc5f38b36e1b6752d0c1eabab435', to: HOLLAR_MANAGER, value: '10000000000000000000',
    })
    expect(decodeErc20Transfer(hollarRelease.topics, hollarRelease.data)).toEqual({
      from: HOLLAR_MANAGER, to: '0x82fb02afe02fe5d6c793145a75e6860c4e206682', value: '1000000000000000000',
    })
  })

  it('ignores any other log', () => {
    expect(decodeErc20Transfer(hdxSent.topics, hdxSent.data)).toBeNull()
    expect(decodeErc20Transfer(hollarLock.topics.slice(0, 2), hollarLock.data)).toBeNull()
    expect(decodeErc20Transfer(hollarLock.topics, '0x')).toBeNull()
  })
})

describe('resolveLockManagers', () => {
  // The legs seen inside each candidate manager's own TransferSent/TransferRedeemed
  // extrinsics, as the registry reads them.
  const observations: NttLockObservation[] = [
    { manager: HDX_MANAGER, assetId: 0, extrinsic: '15705950:5' },
    { manager: HDX_MANAGER, assetId: 0, extrinsic: '15706098:2' },
    { manager: HDX_MANAGER, assetId: 0, extrinsic: '15503028:3' },
    { manager: HOLLAR_MANAGER, assetId: 222, extrinsic: '15705909:2', erc20: HOLLAR_TOKEN },
    { manager: HOLLAR_MANAGER, assetId: 222, extrinsic: '15706107:2', erc20: HOLLAR_TOKEN },
    { manager: HOLLAR_MANAGER, assetId: 222, extrinsic: '15503023:3', erc20: HOLLAR_TOKEN },
  ]

  it('names the asset each locking manager moves, and its ERC-20 token where it has one', () => {
    const resolved = resolveLockManagers(observations)
    expect(resolved.get(HDX_MANAGER)).toEqual({ assetId: 0, erc20: null })
    expect(resolved.get(HOLLAR_MANAGER)).toEqual({ assetId: 222, erc20: HOLLAR_TOKEN })
    // A deployment whose token is no registry asset moves nothing a reader indexes.
    expect(resolved.has(NTTUSD_TEST_MANAGER)).toBe(false)
  })

  it('outvotes a stray movement, and refuses to guess on a tie', () => {
    const stray = [...observations, { manager: HDX_MANAGER, assetId: 5, extrinsic: '15705950:5' }]
    expect(resolveLockManagers(stray).get(HDX_MANAGER)?.assetId).toBe(0)
    const tie = [{ manager: HDX_MANAGER, assetId: 0, extrinsic: '1:1' }, { manager: HDX_MANAGER, assetId: 5, extrinsic: '1:1' }]
    expect(resolveLockManagers(tie).has(HDX_MANAGER)).toBe(false)
  })
})

describe('buildNttManagers', () => {
  it('keeps the minter registry and adds the locking managers beside it', () => {
    expect(managers.map(m => [m.assetId, m.mode, m.account, m.erc20])).toEqual([
      [20, 'burn', '0x45544800b5cef790d52a57fa619ed96edd64c5328f3dcfb70000000000000000', null],
      [0, 'lock', nttManagerAccount(HDX_MANAGER), null],
      [222, 'lock', nttManagerAccount(HOLLAR_MANAGER), HOLLAR_TOKEN],
    ])
  })

  it('lets the minter registry win an asset both claim', () => {
    const refs = buildNttManagers(
      new Map([[0, nttManagerAccount('0x' + '11'.repeat(20))]]),
      new Map([[HDX_MANAGER, { assetId: 0, erc20: null }]]),
    )
    expect(refs).toHaveLength(1)
    expect(refs[0].mode).toBe('burn')
  })

  it('matches a leg to its own manager only', () => {
    expect(nttManagerOfLeg(managers, 0, '0x4554480016AC5B8D9078ED4CF5A522F907FD9DDB6C8841F10000000000000000')?.manager).toBe(HDX_MANAGER)
    // HDX sent to the HOLLAR manager is not an NTT leg.
    expect(nttManagerOfLeg(managers, 0, nttManagerAccount(HOLLAR_MANAGER))).toBeUndefined()
    expect(nttErc20ManagerOf(managers, HOLLAR_TOKEN, HOLLAR_MANAGER)?.assetId).toBe(222)
    expect(nttErc20ManagerOf(managers, '0x' + '22'.repeat(20), HOLLAR_MANAGER)).toBeUndefined()
  })
})

// The 2026-10-12 regression: four sends by 14jDRF… rendered as a bare trade. Each now
// builds a cross-chain row to Robinhood with the amount the manager logged.
describe('locking-manager rows', () => {
  it('builds the HDX send (pallet lock leg) as an xcm out row to Robinhood', () => {
    const row = nttSendRow({
      block_height: 15705950, ts: '2026-10-12 10:00:00', event_index: 187, extrinsic_index: 5,
      who: SENDER, amount: '20000000000000', asset_id: 0, manager: HDX_MANAGER,
    }, decodeNttExtrinsicLogs([hdxSent]), new Map())
    expect(row).toMatchObject({
      type: 'xcm', xcmDir: 'out', bridge: 'Wormhole', amount: '20000000000000',
      destChain: 'Robinhood', linkBlock: 15705950, linkIndex: 5,
    })
    expect(row.asset?.assetId).toBe(0)
    expect(row.who?.accountId).toBe(SENDER)
    expect(row.destAccount?.address.toLowerCase()).toBe(ROBINHOOD_RECIPIENT)
  })

  it('builds the HOLLAR send (ERC-20 lock leg) as an xcm out row, named for its native signer', () => {
    const transfer = decodeErc20Transfer(hollarLock.topics, hollarLock.data)!
    const who = nttErc20Owner(transfer.from, SENDER, [])
    expect(who).toBe(SENDER)
    const row = nttSendRow({
      block_height: 15705909, ts: '2026-10-12 10:00:00', event_index: 76, extrinsic_index: 2,
      who, amount: transfer.value, asset_id: 222, manager: HOLLAR_MANAGER,
    }, decodeNttExtrinsicLogs([hollarLock, hollarSent]), new Map())
    expect(row).toMatchObject({ type: 'xcm', xcmDir: 'out', amount: '10000000000000000000', destChain: 'Robinhood' })
    expect(row.asset?.assetId).toBe(222)
    expect(row.destAccount?.address.toLowerCase()).toBe(ROBINHOOD_RECIPIENT)
  })

  it('builds a release (pallet or ERC-20 leg) as an xcm in row from Robinhood', () => {
    const hdx = nttArrivalRow({
      block_height: 15503028, ts: '2026-10-01 10:00:00', event_index: 16, extrinsic_index: 3,
      who: RECIPIENT, amount: '10000000000000', asset_id: 0, manager: HDX_MANAGER,
    }, decodeNttExtrinsicLogs(hdxRedeem), new Map())
    expect(hdx).toMatchObject({ type: 'xcm', xcmDir: 'in', amount: '10000000000000', fromChain: 'Robinhood' })
    expect(hdx.messageId).toBe('72/00000000000000000000000097cd0d08c376005d09afcc47fa9ce0c384fba406/3')
    expect(hdx.who?.accountId).toBe(RECIPIENT)

    const transfer = decodeErc20Transfer(hollarRelease.topics, hollarRelease.data)!
    // The relayer signed the redeem, so the recipient is named by the account a viewer
    // asked for, or else by its own EVM-side form.
    expect(nttErc20Owner(transfer.to, '0x455448000c27f5bd5a2a616fe90237b955eaef575159754e0000000000000000', [RECIPIENT])).toBe(RECIPIENT)
    expect(nttErc20Owner(transfer.to, undefined, [])).toBe('0x4554480082fb02afe02fe5d6c793145a75e6860c4e2066820000000000000000')
  })
})
