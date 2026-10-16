import { describe, expect, it } from 'vitest'
import { decodeNttReceivedMessage, nttJourneyMessageId, decodeNttTransferSent, nttDestination, nttLegExclusionSql, nttOriginChain, ocnChainName, originTxExplorerUrl } from '../src/services/explorerService.ts'

// A journey's ends are named by Ocelloids URNs, and a bridge can put either end on a
// chain this app has no other reason to know. Two things then go wrong quietly: the
// chain id gets ignored, so every EVM chain reads as "Ethereum", and its transaction
// links point at etherscan where it does not exist. These pin the ends the live
// bridges actually reach — measured on Hydration's own journeys: ethereum:1,
// ethereum:8453 (Base), solana:101 and sui.

describe('ocnChainName', () => {
  it('tells the EVM chains apart rather than calling them all Ethereum', () => {
    expect(ocnChainName('urn:ocn:ethereum:1')).toBe('Ethereum')
    expect(ocnChainName('urn:ocn:ethereum:8453')).toBe('Base')
    expect(ocnChainName('urn:ocn:ethereum:42161')).toBe('Arbitrum')
  })

  // An unmapped EVM chain says which one it is instead of claiming Ethereum; a wrong
  // name is worse than an unfamiliar one.
  it('names an unmapped EVM chain by its id', () => {
    expect(ocnChainName('urn:ocn:ethereum:999999')).toBe('EVM chain 999999')
  })

  // Robinhood, an Arbitrum Orbit L2: EVM chain id 4663, and Wormhole chain
  // id 72 — read off its own core bridge (chainId() at
  // 0x141fBa8AD5D61bdaB45A047cF60b5Ad9784987FB answers 0x48).
  it('names Robinhood and links its own explorer', () => {
    expect(ocnChainName('urn:ocn:ethereum:4663')).toBe('Robinhood')
    expect(originTxExplorerUrl('urn:ocn:ethereum:4663', '0x' + 'ab'.repeat(32)))
      .toBe(`https://robinhoodchain.blockscout.com/tx/0x${'ab'.repeat(32)}`)
  })

  // Sui identifies itself with a hex digest, which the old numeric-only URN pattern
  // rejected outright — so a Sui journey resolved to nothing at all.
  it('accepts a non-numeric chain id', () => {
    expect(ocnChainName('urn:ocn:sui:0x35834a8a')).toBe('Sui')
  })

  it('names substrate ends and rejects nonsense', () => {
    expect(ocnChainName('urn:ocn:polkadot:0')).toBe('Polkadot')
    expect(ocnChainName('urn:ocn:solana:101')).toBe('Solana')
    expect(ocnChainName('not-a-urn')).toBeNull()
    expect(ocnChainName('')).toBeNull()
  })
})

describe('originTxExplorerUrl', () => {
  const tx = '0x' + 'ab'.repeat(32)

  it('sends each EVM chain to its own explorer', () => {
    expect(originTxExplorerUrl('urn:ocn:ethereum:1', tx)).toBe(`https://etherscan.io/tx/${tx}`)
    expect(originTxExplorerUrl('urn:ocn:ethereum:8453', tx)).toBe(`https://basescan.org/tx/${tx}`)
    expect(originTxExplorerUrl('urn:ocn:ethereum:42161', tx)).toBe(`https://arbiscan.io/tx/${tx}`)
  })

  // A link is only offered where it would resolve; an unmapped chain gets none rather
  // than a plausible-looking etherscan URL for a transaction that is not there.
  it('offers no link for an unmapped EVM chain', () => {
    expect(originTxExplorerUrl('urn:ocn:ethereum:999999', tx)).toBeNull()
  })

  // Solana signatures are base58, so the hex test that guards the EVM/substrate
  // branches must not be applied to them.
  it('links a base58 Solana signature', () => {
    const sig = '5x7cH1kQ2pYourSignatureHere9aBcDeFgHiJkLmNoPqRsTuVwXyZ'
    expect(originTxExplorerUrl('urn:ocn:solana:101', sig)).toBe(`https://orbmarkets.io/tx/${encodeURIComponent(sig)}`)
  })

  it('links a Sui digest', () => {
    expect(originTxExplorerUrl('urn:ocn:sui:0x35834a8a', 'AbCdEf123')).toBe('https://suiscan.xyz/mainnet/tx/AbCdEf123')
  })

  it('has nothing to link without a hash', () => {
    expect(originTxExplorerUrl('urn:ocn:ethereum:1', null)).toBeNull()
    expect(originTxExplorerUrl('urn:ocn:ethereum:1', 'not-hex')).toBeNull()
  })
})

// Wormhole Native Token Transfers replaced Moonbeam Routed Liquidity for the venues MRL
// served. A send burns the token here and mints it on the far chain, so it carries no
// XCM topic, no destination junction and no sibling — and the crosschain index cannot be
// joined to it either (none of 47 NTT journeys' origin hashes matches a Hydration
// extrinsic hash or an EVM transaction hash). The far end is only in our own log.
//
// Decoded from a real send: 0.002 WETH at block 13405364, recipientChain 2.
describe('decodeNttTransferSent', () => {
  const topic = '0xe54e51e42099622516fa3b48e9733581c9dbdcb771cafb093f745a0532a35982'
  const sender = '0x000000000000000000000000e6af127259bf7f1b0539fc0a955494f48e31240b'
  const recipient = '0x000000000000000000000000e6af127259bf7f1b0539fc0a955494f48e31240b'
  // amount, fee, recipientChain, sequence
  const data = '0x00000000000000000000000000000000000000000000000000071afd498d0000'
    + '0000000000000000000000000000000000000000000000000000000000000000'
    + '0000000000000000000000000000000000000000000000000000000000000002'
    + '0000000000000000000000000000000000000000000000000000000000000001'

  it('reads the recipient, amount and destination chain of a real send', () => {
    expect(decodeNttTransferSent([topic, sender, recipient], data)).toEqual({
      recipient: recipient.toLowerCase(),
      refundAddress: recipient.toLowerCase(),
      amount: '2000000000000000',
      recipientChain: 2,
    })
  })

  // The event is TransferSent(bytes32 indexed recipient, bytes32 indexed refundAddress, …).
  // Real ZEC send to NEAR at block 15788869: the recipient is sha256 of the NEAR account
  // that was credited, the refund address that account's implicit form.
  it('reads the recipient from the first indexed topic, not the refund address', () => {
    const toNear = '0xa8e92983a580e928180177795abae2e55b8734491b94859a7821489afd286af6'
    const refund = '0x0952c20ad87a71bfa5177b0e37e274e109d0d9b54544ab228e0051a42cb15804'
    const nearData = '0x' + (500000).toString(16).padStart(64, '0') + '00'.repeat(32) + (15).toString(16).padStart(64, '0') + (6).toString(16).padStart(64, '0')
    expect(decodeNttTransferSent([topic, toNear, refund], nearData)).toEqual({
      recipient: toNear, refundAddress: refund, amount: '500000', recipientChain: 15,
    })
  })

  it('ignores any other log', () => {
    expect(decodeNttTransferSent(['0x' + '11'.repeat(32), sender, recipient], data)).toBeNull()
    // A truncated payload names no chain, and guessing one would invent a destination.
    expect(decodeNttTransferSent([topic, sender, recipient], '0x00')).toBeNull()
    // Without both indexed words there is no account to show.
    expect(decodeNttTransferSent([topic, sender], data)).toBeNull()
  })
})

// The transceiver's ReceivedMessage is what marks an extrinsic as an NTT redeem, and
// its second data word is the only place the source CHAIN is stated on this side. The
// sending USER is not in any log — it lives in the NTT payload, which is calldata —
// so the decode deliberately yields no source account.
//
// Decoded from a real arrival: SUI from Sui (chain 21) at block 13405201.
describe('decodeNttReceivedMessage', () => {
  const topic = '0xf6fc529540981400dc64edf649eb5e2e0eb5812a27f8c81bac2c1d317e71a5f0'
  const digest = 'b7cf11ac1b0c576f84db64a0b0a1ff64b28662e1b83315678489bca472af401d'
  const emitter = '25437da9f99dfab32c1a275663f51cd5c99eb867ab4d1f630e3799c5e68215da'
  const data = '0x' + digest
    + '0000000000000000000000000000000000000000000000000000000000000015'
    + emitter
    + '0000000000000000000000000000000000000000000000000000000000000001'

  it('reads the source chain of a real arrival', () => {
    expect(decodeNttReceivedMessage([topic], data)).toMatchObject({ sourceChain: 21 })
  })

  // The VAA's own identity, which is how Ocelloids correlates the journey that
  // carried this arrival — without it an NTT row has no key to ask for and stays
  // sourceless. Read from the live arrival at block 14,637,790: chain 1 (Solana),
  // emitter 0xe97e1f56…, sequence 53.
  it('carries the emitter and sequence the journey is keyed by', () => {
    const solana = '0x' + 'b'.repeat(64)
      + '0000000000000000000000000000000000000000000000000000000000000001'
      + 'e97e1f562b67844adddcc4aff6a22e017596c8e612de2686a0745b6e74f196cd'
      + '0000000000000000000000000000000000000000000000000000000000000035'
    expect(decodeNttReceivedMessage([topic], solana)).toEqual({
      sourceChain: 1,
      emitterAddress: 'e97e1f562b67844adddcc4aff6a22e017596c8e612de2686a0745b6e74f196cd',
      sequence: '53',
    })
  })

  // Ocelloids correlates on `chain/emitter/sequence` with slashes and no 0x — the
  // colon form vaaKey() builds for our own redemption matching does not resolve
  // there, so the two must not be confused.
  it('builds the journey id in the form Ocelloids correlates on', () => {
    expect(nttJourneyMessageId(decodeNttReceivedMessage([topic], '0x' + 'b'.repeat(64)
      + '0000000000000000000000000000000000000000000000000000000000000001'
      + 'e97e1f562b67844adddcc4aff6a22e017596c8e612de2686a0745b6e74f196cd'
      + '0000000000000000000000000000000000000000000000000000000000000035')!))
      .toBe('1/e97e1f562b67844adddcc4aff6a22e017596c8e612de2686a0745b6e74f196cd/53')
  })

  it('ignores any other log', () => {
    expect(decodeNttReceivedMessage(['0x' + '11'.repeat(32)], data)).toBeNull()
    // A payload too short to hold the chain word names no chain.
    expect(decodeNttReceivedMessage([topic], '0x' + digest)).toBeNull()
  })
})

describe('nttOriginChain', () => {
  it('names the source chain in the fields inbound rows carry', () => {
    expect(nttOriginChain(21)).toEqual({ fromChain: 'Sui', fromParachainId: null })
    expect(nttOriginChain(1)).toEqual({ fromChain: 'Solana', fromParachainId: null })
    expect(nttOriginChain(2)).toEqual({ fromChain: 'Ethereum', fromParachainId: null })
    expect(nttOriginChain(16)).toEqual({ fromChain: 'Moonbeam', fromParachainId: 2004 })
  })

  it('yields nothing for a chain it does not know, rather than a plausible wrong one', () => {
    expect(nttOriginChain(9999)).toBeNull()
  })
})

// The manager-leg exclusion every transfer read site and the transfer count arm share:
// a transfer of an NTT asset TO its manager is that asset's outbound send, and one FROM
// a locking manager its inbound release — both rendered as cross-chain rows, so the
// transfer family must not also count or show them. Stated as one SQL fragment so the
// sites cannot drift.
describe('nttLegExclusionSql', () => {
  const managers = [
    { assetId: 20, manager: '0xb5cef790d52a57fa619ed96edd64c5328f3dcfb7', account: '0x45544800b5cef790d52a57fa619ed96edd64c5328f3dcfb70000000000000000', mode: 'burn' as const, erc20: null },
    { assetId: 18, manager: '0xcfd576f88c90844aebf45378fd09931281d8b14d', account: '0x45544800cfd576f88c90844aebf45378fd09931281d8b14d0000000000000000', mode: 'burn' as const, erc20: null },
    // HDX is LOCKED on Hydration against Robinhood: no minter registration, and its
    // release is a transfer out of the manager's custody.
    { assetId: 0, manager: '0x16ac5b8d9078ed4cf5a522f907fd9ddb6c8841f1', account: '0x4554480016ac5b8d9078ed4cf5a522f907fd9ddb6c8841f10000000000000000', mode: 'lock' as const, erc20: null },
  ]

  it('excludes exactly the (asset, manager) pairs, sends and releases alike', () => {
    const sql = nttLegExclusionSql(managers)
    expect(sql).toContain('NOT IN')
    expect(sql).toContain("(20,'0x45544800b5cef790d52a57fa619ed96edd64c5328f3dcfb70000000000000000')")
    expect(sql).toContain("(18,'0x45544800cfd576f88c90844aebf45378fd09931281d8b14d0000000000000000')")
    expect(sql).toContain("(0,'0x4554480016ac5b8d9078ed4cf5a522f907fd9ddb6c8841f10000000000000000')")
    expect(sql).toContain('toUInt32(asset_id)')
    expect(sql).toContain('lower(to_account)) NOT IN')
    // from_account is lowercase in the read models, so it is compared as given.
    expect(sql).toContain('(toUInt32(asset_id), from_account) NOT IN')
  })

  it('takes per-site column expressions', () => {
    const sql = nttLegExclusionSql(managers, "JSONExtractInt(args_json,'currencyId')", "JSONExtractString(args_json,'to')", "lower(JSONExtractString(args_json,'from'))")
    expect(sql).toContain("toUInt32(JSONExtractInt(args_json,'currencyId'))")
    expect(sql).toContain("lower(JSONExtractString(args_json,'to'))")
    expect(sql).toContain("lower(JSONExtractString(args_json,'from'))) NOT IN")
  })

  it('excludes nothing when no manager is known', () => {
    expect(nttLegExclusionSql([])).toBe('')
  })
})

describe('nttDestination', () => {
  const sent = (recipientChain: number, recipient = '0x' + '00'.repeat(12) + 'e6af127259bf7f1b0539fc0a955494f48e31240b') =>
    ({ recipient, refundAddress: recipient, amount: '1', recipientChain })

  // An EVM destination wants the low 20 bytes; Solana and Sui need all 32, which is what
  // their encodings are built from.
  it('narrows a bytes32 recipient for EVM chains and keeps it whole otherwise', () => {
    expect(nttDestination(sent(2))).toEqual({ urn: 'urn:ocn:ethereum:1', account: '0xe6af127259bf7f1b0539fc0a955494f48e31240b' })
    expect(nttDestination(sent(30))).toEqual({ urn: 'urn:ocn:ethereum:8453', account: '0xe6af127259bf7f1b0539fc0a955494f48e31240b' })
    const solRecipient = '0x' + 'ab'.repeat(32)
    expect(nttDestination(sent(1, solRecipient))).toEqual({ urn: 'urn:ocn:solana:101', account: solRecipient })
  })

  // Wormhole numbers chains its own way, and an unmapped one yields no destination rather
  // than a plausible wrong chain — the same rule the EVM explorer links follow.
  it('yields nothing for a chain it does not know', () => {
    expect(nttDestination(sent(9999))).toBeNull()
  })

  // Wormhole chain 72 is Robinhood; 73 is Hydration itself, so the two sit
  // next to each other and a slip between them would send a transfer's far end to
  // the chain it left.
  it('resolves a send to Robinhood', () => {
    expect(nttDestination(sent(72))).toEqual({ urn: 'urn:ocn:ethereum:4663', account: '0xe6af127259bf7f1b0539fc0a955494f48e31240b' })
  })
})

// Hydration is no longer indexed on Subscan — the host answers 403 — so a remote
// pill or origin-transaction link pointing back at this chain must offer nothing
// rather than a page that cannot load. The SS58 prefix stays: it is how the
// address is ENCODED, which is unrelated to where it can be looked up.
describe('links back to Hydration itself', () => {
  it('offers no Subscan link for Hydration, while still naming and encoding it', () => {
    expect(ocnChainName('urn:ocn:polkadot:2034')).toBe('Hydration')
    expect(originTxExplorerUrl('urn:ocn:polkadot:2034', '0x' + 'ab'.repeat(32))).toBeNull()
  })
})

// Kusama's side of a bridged journey. Ocelloids reports these ends as
// urn:ocn:kusama:<para>, and with no branch for that consensus they fell through to
// the generic one: named "Kusama 1000" and rendered with no link at all, even
// though the journeys exist upstream (2 of 250 scanned).
describe('kusama journey ends', () => {
  it('names Kusama AssetHub rather than the bare para id', () => {
    expect(ocnChainName('urn:ocn:kusama:1000')).toBe('Kusama AssetHub')
    expect(ocnChainName('urn:ocn:kusama:0')).toBe('Kusama')
  })

  it('links each to its own Subscan', () => {
    const tx = '0x' + 'cd'.repeat(32)
    expect(originTxExplorerUrl('urn:ocn:kusama:1000', tx)).toBe(`https://assethub-kusama.subscan.io/extrinsic/${tx}`)
    expect(originTxExplorerUrl('urn:ocn:kusama:0', tx)).toBe(`https://kusama.subscan.io/extrinsic/${tx}`)
  })

  it('still names an unmapped Kusama parachain without inventing a link', () => {
    expect(ocnChainName('urn:ocn:kusama:2222')).toBe('Kusama 2222')
    expect(originTxExplorerUrl('urn:ocn:kusama:2222', '0x' + 'cd'.repeat(32))).toBeNull()
  })
})
