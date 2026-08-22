import { describe, it, expect } from 'vitest'
import {
  assetIdFromPrecompile,
  base58Decode,
  base58Encode,
  decodeGetPeer,
  decodeInboundQueuedTransfer,
  decodeU128Le,
  decodeU32Le,
  deTrim,
  displayChainAddress,
  encodeBalanceOf,
  encodeGetInboundQueuedTransfer,
  encodeGetPeer,
  hexToBytes,
  nttDigest,
  parseLogMessagePublished,
  parseNttTransceiverMessage,
  parseOriginRpcUrls,
  parseReceivedMessage,
  parseSolanaInboxItem,
  parseSolanaNttConfig,
  parseSuiNttState,
  parseWormholeLocation,
  rescaleAmount,
  SOLANA_NTT_CONFIG_DISCRIMINATOR,
  SOLANA_NTT_INBOX_ITEM_DISCRIMINATOR,
  SOLANA_NTT_INBOX_ITEM_LENGTH,
  SOLANA_RELEASE_STATUS,
  storagePrefix,
  tokensTotalIssuanceKey,
  TOPIC,
  trimmedDecimalsFor,
  unpackTrimmedAmount,
  vaaKey,
  wormholeChainFamily,
} from '../src/services/wormholeNtt.ts'

// Real Hydration bytes. An outbound send of 3500 SUI at block 13,728,047
// extrinsic 3: the core bridge's LogMessagePublished (event 85) carries VAA
// sequence 12 and an NTT payload trimmed to 8 decimals, and the same extrinsic's
// Tokens.Withdrawn from the manager's ETH\0 account is 3_500_000_000_000 — the
// de-trimmed amount, to the unit.
const SUI_SEND_DATA = '0x'
  + '000000000000000000000000000000000000000000000000000000000000000c'
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '0000000000000000000000000000000000000000000000000000000000000080'
  + '00000000000000000000000000000000000000000000000000000000000000ca'
  + '00000000000000000000000000000000000000000000000000000000000000d9'
  + '9945ff10'
  + '000000000000000000000000978443f00cab6b09445140321ec73a221ebff5f8'
  + 'a0bc45e0384140dc125f273eda89cad1434f5dee430726cf6364bdcceba1e9a3'
  + '0091'
  + '000000000000000000000000000000000000000000000000000000000000000a'
  + '000000000000000000000000fc39fcf04a8071b7409823b7c82427ce67910c6e'
  + '004f'
  + '994e5454'
  + '08'
  + '000000517da02c00'
  + '00000000000000000000000000000000000000000000000000000001000f4531'
  + '158827f09bac47981480d0e8156565b0481dc063ae9e1d0c80c56394012d45a3'
  + '0015'
  + '0000000000000000'
const SUI_SEND_TOPICS = [TOPIC.logMessagePublished, '0x000000000000000000000000a224d6f4e0e276b34d91bfe6c3a5fe6838322af7']

// An inbound redemption of 4921.564541 USDC at block 13,725,326 extrinsic 3:
// the USDC transceiver's ReceivedMessage (event 18) names Ethereum (chain 2)
// sequence 50, which is the identity our redemption set is keyed by.
const USDC_RECEIVE_DATA = '0x'
  + '1ad03194fc0fd427479b7e6475238558897133cbfa23860b905c5d0b1017f7e8'
  + '0000000000000000000000000000000000000000000000000000000000000002'
  + '000000000000000000000000a108bd5dbc6ce665aebb6895351e0609c76f8efc'
  + '0000000000000000000000000000000000000000000000000000000000000032'

// The outbound send that produced this feature. 79,998.96642431 sUSDS
// (asset 1000745) left Hydration for Ethereum at block 13,703,216 extrinsic 2,
// core bridge event 24, VAA sequence 8. Ethereum redeemed it and its inbound
// rate limiter then held it: the Ethereum manager
// 0x5085a4863f89ec9553f70187ee73b5aae0fd14b5 answered
// getInboundQueuedTransfer(0x319c998f…d41c) with amount 7999896642431 at 8
// decimals, txTimestamp 2026-08-20T12:20:35Z and recipient 0xe84121ca…aa3e,
// and rateLimitDuration() with 86400 — releasable 2026-08-21T12:20:35Z. This
// digest is the hard gate on the formula.
const SUSDS_SEND_DATA = '0x'
  + '0000000000000000000000000000000000000000000000000000000000000008'
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '0000000000000000000000000000000000000000000000000000000000000080'
  + '00000000000000000000000000000000000000000000000000000000000000ca'
  + '00000000000000000000000000000000000000000000000000000000000000d9'
  + '9945ff10'
  + '0000000000000000000000001973e7044d9a7c7bb2d6ea1693a296a9e4b7e448'
  + '0000000000000000000000005085a4863f89ec9553f70187ee73b5aae0fd14b5'
  + '0091'
  + '0000000000000000000000000000000000000000000000000000000000000006'
  + '000000000000000000000000a1a687bee8249b337bfa3f644f6e1cc7dca68e36'
  + '004f'
  + '994e5454'
  + '08'
  + '000007469eff637f'
  + '00000000000000000000000000000000000000000000000000000001000f4529'
  + '000000000000000000000000e84121cad17d2da9e0220aa8453f85396e73aa3e'
  + '0002'
  + '0000000000000000'
const SUSDS_SEND_TOPICS = [TOPIC.logMessagePublished, '0x00000000000000000000000068ecadd7934d4fcfeabafb209c95d379b96400cb']
const SUSDS_QUEUE_DIGEST = '0x319c998f9e8ab534fb886dbfc4db6fccf0d10101cdb687f1a6657f79cb83d41c'

describe('LogMessagePublished / NTT payload', () => {
  it('decodes the real outbound SUI send at block 13728047', () => {
    const published = parseLogMessagePublished(SUI_SEND_TOPICS, SUI_SEND_DATA)
    expect(published).not.toBeNull()
    expect(published!.sequence).toBe(12n)
    expect(published!.nonce).toBe(0)
    expect(published!.consistencyLevel).toBe(202)
    expect(published!.emitter).toBe('0xa224d6f4e0e276b34d91bfe6c3a5fe6838322af7')

    const message = parseNttTransceiverMessage(published!.payload)
    expect(message).not.toBeNull()
    expect(message!.sourceManager).toBe('0x000000000000000000000000978443f00cab6b09445140321ec73a221ebff5f8')
    // The Sui recipient manager is the state object id, not an address.
    expect(message!.recipientManager).toBe('0xa0bc45e0384140dc125f273eda89cad1434f5dee430726cf6364bdcceba1e9a3')
    expect(message!.transfer.toChain).toBe(21)
    expect(message!.transfer.trimmedDecimals).toBe(8)
    expect(message!.transfer.trimmedAmount).toBe(350_000_000_000n)
    // sourceToken is the asset's ERC-20 precompile, so the payload names the
    // registry asset without any lookup.
    expect(assetIdFromPrecompile(message!.transfer.sourceToken)).toBe(1_000_753)
    // SUI carries 9 decimals; the burn recorded on chain was 3_500_000_000_000.
    expect(deTrim(message!.transfer.trimmedAmount, message!.transfer.trimmedDecimals, 9)).toBe(3_500_000_000_000n)
  })

  it('rejects a log whose topic0 is not LogMessagePublished', () => {
    expect(parseLogMessagePublished([TOPIC.transferSent, SUI_SEND_TOPICS[1]], SUI_SEND_DATA)).toBeNull()
  })

  it('rejects a payload whose transceiver prefix is wrong', () => {
    expect(parseNttTransceiverMessage('0xdeadbeef' + '00'.repeat(200))).toBeNull()
  })

  it('rejects a payload truncated inside the NativeTokenTransfer body', () => {
    const published = parseLogMessagePublished(SUI_SEND_TOPICS, SUI_SEND_DATA)!
    expect(parseNttTransceiverMessage(published.payload.slice(0, 120))).toBeNull()
  })
})

describe('NTT message digest', () => {
  it('reproduces the digest the Ethereum manager queued the real sUSDS send under', () => {
    const published = parseLogMessagePublished(SUSDS_SEND_TOPICS, SUSDS_SEND_DATA)!
    const message = parseNttTransceiverMessage(published.payload)!
    expect(message.transfer.trimmedAmount).toBe(7_999_896_642_431n)
    expect(message.transfer.trimmedDecimals).toBe(8)
    expect(message.transfer.toChain).toBe(2)
    expect(message.transfer.recipient).toBe('0x000000000000000000000000e84121cad17d2da9e0220aa8453f85396e73aa3e')
    expect(assetIdFromPrecompile(message.transfer.sourceToken)).toBe(1_000_745)
    // The NttManagerMessage is carried through byte for byte, length prefix of
    // the inner transfer included, because the digest is taken over exactly it.
    expect(message.managerMessage).toBe('0x'
      + '0000000000000000000000000000000000000000000000000000000000000006'
      + '000000000000000000000000a1a687bee8249b337bfa3f644f6e1cc7dca68e36'
      + '004f'
      + '994e5454' + '08' + '000007469eff637f'
      + '00000000000000000000000000000000000000000000000000000001000f4529'
      + '000000000000000000000000e84121cad17d2da9e0220aa8453f85396e73aa3e'
      + '0002')
    expect(hexToBytes(message.managerMessage)).toHaveLength(145)

    expect(nttDigest(73, message.managerMessage)).toBe(SUSDS_QUEUE_DIGEST)
  })

  it('is taken over the SENDING chain id, so the peer id gives a different key', () => {
    const message = parseNttTransceiverMessage(parseLogMessagePublished(SUSDS_SEND_TOPICS, SUSDS_SEND_DATA)!.payload)!
    expect(nttDigest(2, message.managerMessage)).not.toBe(SUSDS_QUEUE_DIGEST)
  })

  it('yields nothing rather than a hash of nothing for an empty message', () => {
    expect(nttDigest(73, '0x')).toBe('')
    expect(nttDigest(73, '0xabc')).toBe('')
  })
})

describe('inbound rate-limiter queue', () => {
  it('encodes the digest as the single bytes32 argument', () => {
    expect(encodeGetInboundQueuedTransfer(SUSDS_QUEUE_DIGEST))
      .toBe('0xfd96063c' + SUSDS_QUEUE_DIGEST.slice(2))
  })

  it('unpacks the uint72 TrimmedAmount into value and decimals', () => {
    // 7999896642431 at 8 decimals is packed as (amount << 8) | decimals.
    expect(unpackTrimmedAmount(0x07469eff637f08n)).toEqual({ amount: 7_999_896_642_431n, decimals: 8 })
    expect(unpackTrimmedAmount(0n)).toEqual({ amount: 0n, decimals: 0 })
  })

  it('decodes the struct Ethereum returned while it held the sUSDS transfer', () => {
    const result = '0x'
      + '0000000000000000000000000000000000000000000000000007469eff637f08'
      + '000000000000000000000000000000000000000000000000000000006a86f113'
      + '000000000000000000000000e84121cad17d2da9e0220aa8453f85396e73aa3e'
    const queued = decodeInboundQueuedTransfer(result)
    expect(queued).toEqual({
      amount: 7_999_896_642_431n,
      trimmedDecimals: 8,
      txTimestampSec: 1_787_228_435,
      recipient: '0xe84121cad17d2da9e0220aa8453f85396e73aa3e',
    })
    expect(new Date(queued!.txTimestampSec * 1000).toISOString()).toBe('2026-08-20T12:20:35.000Z')
    // rateLimitDuration() is 86400 on that manager.
    expect(new Date((queued!.txTimestampSec + 86_400) * 1000).toISOString()).toBe('2026-08-21T12:20:35.000Z')
    // sUSDS carries 18 decimals; the queue speaks the trimmed 8.
    expect(deTrim(queued!.amount, queued!.trimmedDecimals, 18)).toBe(79_998_966_424_310_000_000_000n)
  })

  it('reads a released entry as a zeroed struct, not as unknown', () => {
    // The same call after the release: NTT deletes the record, so every field
    // is zero. That is a settled answer and may be cached forever.
    const settled = decodeInboundQueuedTransfer('0x' + '0'.repeat(192))
    expect(settled).not.toBeNull()
    expect(settled!.amount).toBe(0n)
  })

  it('reads an unanswered or short call as unknown, so it is retried', () => {
    expect(decodeInboundQueuedTransfer(null)).toBeNull()
    expect(decodeInboundQueuedTransfer('0x')).toBeNull()
    expect(decodeInboundQueuedTransfer('0x' + '0'.repeat(128))).toBeNull()
  })
})

describe('ReceivedMessage', () => {
  it('decodes the real inbound USDC redemption at block 13725326', () => {
    const received = parseReceivedMessage([TOPIC.receivedMessage], USDC_RECEIVE_DATA)
    expect(received).not.toBeNull()
    expect(received!.emitterChainId).toBe(2)
    expect(received!.emitterAddress).toBe('0x000000000000000000000000a108bd5dbc6ce665aebb6895351e0609c76f8efc')
    expect(received!.sequence).toBe(50n)
    expect(received!.digest).toBe('0x1ad03194fc0fd427479b7e6475238558897133cbfa23860b905c5d0b1017f7e8')
  })

  it('keys a redemption identically however the sequence and address are written', () => {
    const received = parseReceivedMessage([TOPIC.receivedMessage], USDC_RECEIVE_DATA)!
    const fromLog = vaaKey(received.emitterChainId, received.emitterAddress, received.sequence)
    const fromScan = vaaKey(2, '000000000000000000000000a108bd5dbc6ce665aebb6895351e0609c76f8efc', '50')
    expect(fromLog).toBe(fromScan)
  })
})

describe('de-trim arithmetic', () => {
  it('trims to min(8, local, peer)', () => {
    expect(trimmedDecimalsFor(18, 18)).toBe(8)
    expect(trimmedDecimalsFor(6, 6)).toBe(6)
    expect(trimmedDecimalsFor(9, 6)).toBe(6)
    expect(trimmedDecimalsFor(6, null)).toBe(6)
  })

  it('widens exactly below, at and above 8 decimals', () => {
    // fewer than 8: nothing was trimmed
    expect(deTrim(1_234_567n, 6, 6)).toBe(1_234_567n)
    // exactly 8
    expect(deTrim(1_234_567n, 8, 8)).toBe(1_234_567n)
    // more than 8: ten more zeroes for an 18-decimal asset
    expect(deTrim(1n, 8, 18)).toBe(10_000_000_000n)
    expect(deTrim(350_000_000_000n, 8, 9)).toBe(3_500_000_000_000n)
  })

  it('round-trips a trimmed amount back to its own precision', () => {
    const assetAmount = 3_776_211_310_000_000_000n
    const trimmed = rescaleAmount(assetAmount, 18, 8)
    expect(trimmed).toBe(377_621_131n)
    expect(deTrim(trimmed, 8, 18)).toBe(assetAmount)
  })

  it('truncates rather than inventing units when narrowing', () => {
    expect(rescaleAmount(1_999_999_999_999_999_999n, 18, 8)).toBe(199_999_999n)
  })
})

describe('registry `wh` location', () => {
  const args = (assetId: number, chain: string, token: string) => JSON.stringify({
    assetId,
    location: {
      parents: 0,
      interior: {
        __kind: 'X3',
        value: [
          { length: 2, data: '0x7768' + '00'.repeat(31), __kind: 'GeneralKey' },
          { __kind: 'GeneralIndex', value: chain },
          { length: 32, data: token, __kind: 'GeneralKey' },
        ],
      },
    },
  })

  it('reads the origin chain and 32-byte token from a real USDC registration', () => {
    const parsed = parseWormholeLocation(args(21, '2', '0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'))
    expect(parsed).toEqual({ assetId: 21, originChainId: 2, originToken: '0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' })
  })

  it('reads a Solana origin without treating the mint as an address', () => {
    const parsed = parseWormholeLocation(args(1_000_752, '1', '0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001'))
    expect(parsed!.originChainId).toBe(1)
    expect(displayChainAddress('solana', parsed!.originToken)).toBe('So11111111111111111111111111111111111111112')
  })

  it('ignores a location that is not the wormhole marker', () => {
    const notWh = JSON.stringify({
      assetId: 5,
      location: { parents: 1, interior: { __kind: 'X3', value: [{ length: 2, data: '0x0900' + '00'.repeat(31), __kind: 'GeneralKey' }, { __kind: 'GeneralIndex', value: '2' }, { length: 32, data: '0x' + '11'.repeat(32), __kind: 'GeneralKey' }] } },
    })
    expect(parseWormholeLocation(notWh)).toBeNull()
    expect(parseWormholeLocation('not json')).toBeNull()
  })
})

describe('chain-native address forms', () => {
  it('renders the same 32 bytes the way each chain writes them', () => {
    const evm = '0x000000000000000000000000447b2c7485a3d6813f8197e605b10bccd8dd8398'
    expect(displayChainAddress('evm', evm)).toBe('0x447b2c7485a3d6813f8197e605b10bccd8dd8398')
    expect(displayChainAddress('sui', '0xa0bc45e0384140dc125f273eda89cad1434f5dee430726cf6364bdcceba1e9a3'))
      .toBe('0xa0bc45e0384140dc125f273eda89cad1434f5dee430726cf6364bdcceba1e9a3')
    // A Solana handle uses all 32 bytes, so it must never be narrowed to 20.
    expect(displayChainAddress('solana', '0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001'))
      .toBe('So11111111111111111111111111111111111111112')
  })

  it('families follow Wormhole chain ids', () => {
    expect(wormholeChainFamily(1)).toBe('solana')
    expect(wormholeChainFamily(21)).toBe('sui')
    expect(wormholeChainFamily(2)).toBe('evm')
    expect(wormholeChainFamily(30)).toBe('evm')
    // An id nobody has mapped yet still gets read, as EVM.
    expect(wormholeChainFamily(9_999)).toBe('evm')
  })
})

describe('base58', () => {
  it('round-trips, and preserves leading zero bytes as leading ones', () => {
    const wsol = 'So11111111111111111111111111111111111111112'
    expect(base58Encode(base58Decode(wsol)!)).toBe(wsol)
    expect(base58Encode(new Uint8Array([0, 0, 1]))).toBe('112')
    expect(base58Decode('not-base58-l0O')).toBeNull()
  })
})

describe('EVM call encoding and decoding', () => {
  it('encodes getPeer and balanceOf as the ABI requires', () => {
    expect(encodeGetPeer(2)).toBe('0xc128d170' + '0'.repeat(63) + '2')
    expect(encodeBalanceOf('0x447b2c7485a3d6813f8197e605b10bccd8dd8398'))
      .toBe('0x70a08231' + '0'.repeat(24) + '447b2c7485a3d6813f8197e605b10bccd8dd8398')
  })

  it('decodes getPeer into the bytes32 handle plus its decimals', () => {
    const result = '0x'
      + 'bcdf1a8178e5fb1313865e48af9338a1eeb957f62a2ff7d6d597fe245a533f55'
      + '0000000000000000000000000000000000000000000000000000000000000009'
    expect(decodeGetPeer(result)).toEqual({ address: '0xbcdf1a8178e5fb1313865e48af9338a1eeb957f62a2ff7d6d597fe245a533f55', decimals: 9 })
  })

  it('treats an unregistered peer and a short answer as unknown, never as zero', () => {
    expect(decodeGetPeer('0x' + '0'.repeat(128))).toBeNull()
    expect(decodeGetPeer('0x')).toBeNull()
    expect(decodeGetPeer(null)).toBeNull()
  })

  it('reads an asset id back out of the ERC-20 precompile', () => {
    expect(assetIdFromPrecompile('0x0000000000000000000000000000000100000015')).toBe(21)
    expect(assetIdFromPrecompile('0x00000000000000000000000000000001000f4531')).toBe(1_000_753)
    // A real contract is not a precompile and must not resolve to an asset.
    expect(assetIdFromPrecompile('0x531a654d1696ed52e7275a8cede955e82620f99a')).toBeNull()
  })
})

describe('substrate storage keys', () => {
  it('builds Tokens.TotalIssuance as prefix ++ twox64Concat(u32 le)', () => {
    const key = tokensTotalIssuanceKey(21)
    expect(key.startsWith(storagePrefix('Tokens', 'TotalIssuance'))).toBe(true)
    // twox64 (8 bytes) followed by the little-endian u32 asset id.
    expect(key.slice(-8)).toBe('15000000')
    expect(key).toHaveLength(2 + 32 + 32 + 16 + 8)
  })

  it('decodes a u128 little-endian value and keeps an unread key unknown', () => {
    expect(decodeU128Le('0x' + '15cd5b07' + '00'.repeat(12))).toBe(123_456_789n)
    expect(decodeU128Le(null)).toBeNull()
    expect(decodeU128Le('0x00')).toBeNull()
    expect(decodeU32Le('0x' + 'efd7d100')).toBe(13_752_303)
  })
})

describe('Solana NTT config layout', () => {
  it('reads mint, mode, chain id, pause flag and custody from their fixed offsets', () => {
    const bytes = new Uint8Array(192)
    bytes.set(hexToBytes(SOLANA_NTT_CONFIG_DISCRIMINATOR), 0)
    const mint = base58Decode('So11111111111111111111111111111111111111112')!
    const custody = base58Decode('4Z2n3D6szuyPkg2uRbm6NwvjpXzKifKQ8HvxhykknyvF')!
    bytes.set(mint, 42)
    bytes[106] = 0            // LOCKING
    bytes[107] = 0; bytes[108] = 1  // chain id 1, u16 big-endian
    bytes[127] = 0            // not paused
    bytes.set(custody, 128)
    expect(parseSolanaNttConfig(bytes)).toEqual({
      mint: 'So11111111111111111111111111111111111111112',
      mode: 0,
      chainId: 1,
      paused: false,
      custody: '4Z2n3D6szuyPkg2uRbm6NwvjpXzKifKQ8HvxhykknyvF',
    })
  })

  it('refuses a truncated account rather than reading past its end', () => {
    expect(parseSolanaNttConfig(new Uint8Array(64))).toBeNull()
  })
})

describe('Solana NTT InboxItem layout', () => {
  // A real released InboxItem from the PRIME manager program
  // 4T5m5NtRVewiCVzP2mnfeUoMYRqncfkrS21X2dhVCNRT (account
  // 149YDK8Fknb5ZdVjS57dxgEWMYvzEXUqLeqd5kFcHk8j). Its amount and recipient
  // reconcile to one of our indexed outbound sends; every one of the 94 items
  // across the three Solana managers reconciles the same way, which is how the
  // layout below was established.
  const RELEASED = hexToBytes('0x'
    + 'ed8dcc67bb7a395c'                                                  // account:InboxItem
    + '01' + 'fd'                                                         // init, bump
    + '80841e0000000000'                                                  // amount u64 le = 2_000_000
    + '6d836da38c4d4dfaee11ee00745980f820e416b2ca3675c606360b402262de61'  // recipient
    + '01000000000000000000000000000000'                                  // vote bitmap
    + '02'                                                                // Released
    + '061e726a00000000')                                                 // stale ReleaseAfter

  it('reads amount, recipient and release status from the real account', () => {
    const item = parseSolanaInboxItem(RELEASED)
    expect(RELEASED).toHaveLength(SOLANA_NTT_INBOX_ITEM_LENGTH)
    expect(item).toEqual({
      bump: 253,
      amount: 2_000_000n,
      recipient: '8NVg9LBdWsEnakdzMsAoDo8tif6vJf8ANG3wpCBpzCx8',
      status: SOLANA_RELEASE_STATUS.released,
      // A released item keeps the timestamp it was queued under in the tail
      // because Borsh does not zero what it no longer writes, so it must not be
      // reported as a release time.
      releaseAfterSec: null,
    })
  })

  it('reports the release time only while the item is still queued', () => {
    const queued = Uint8Array.from(RELEASED)
    queued[66] = SOLANA_RELEASE_STATUS.releaseAfter
    expect(parseSolanaInboxItem(queued)!.releaseAfterSec).toBe(1_785_863_686)
    expect(new Date(1_785_863_686 * 1000).toISOString()).toBe('2026-08-04T17:14:46.000Z')

    const notApproved = Uint8Array.from(RELEASED)
    notApproved[66] = SOLANA_RELEASE_STATUS.notApproved
    expect(parseSolanaInboxItem(notApproved)!.releaseAfterSec).toBeNull()
  })

  it('refuses an account that is not an InboxItem', () => {
    const wrong = Uint8Array.from(RELEASED)
    wrong.set(hexToBytes(SOLANA_NTT_CONFIG_DISCRIMINATOR), 0)
    expect(parseSolanaInboxItem(wrong)).toBeNull()
    expect(parseSolanaInboxItem(hexToBytes('0x' + SOLANA_NTT_INBOX_ITEM_DISCRIMINATOR))).toBeNull()
  })
})

describe('Sui NTT state', () => {
  it('reads the locked balance, mode, pause flag and inbox size', () => {
    const state = parseSuiNttState({
      balance: '18446744073',
      paused: false,
      mode: { '@variant': 'Locking' },
      chain_id: 21,
      inbox: { entries: { size: '7' } },
    })
    expect(state).toEqual({ balance: 18_446_744_073n, paused: false, mode: 'Locking', chainId: 21, inboxSize: 7, outboundRateLimit: null, peersTableId: null, inboxTableId: null })
  })

  it('returns null when the object carries no balance at all', () => {
    expect(parseSuiNttState({ paused: true })).toBeNull()
    expect(parseSuiNttState(null)).toBeNull()
  })
})

describe('WORMHOLE_ORIGIN_RPC_URLS', () => {
  it('reads a chain-id-keyed JSON map', () => {
    const map = parseOriginRpcUrls('{"1":"https://solana.example/rpc","21":"https://graphql.mainnet.sui.io/graphql"}')
    expect([...map.keys()]).toEqual([1, 21])
    expect(map.get(1)).toBe('https://solana.example/rpc')
  })

  it('ignores invalid JSON and unusable entries instead of failing startup', () => {
    expect(parseOriginRpcUrls('{oops').size).toBe(0)
    expect(parseOriginRpcUrls('["https://x"]').size).toBe(0)
    expect(parseOriginRpcUrls(undefined).size).toBe(0)
    expect(parseOriginRpcUrls('{"abc":"https://x","2":"ftp://x","30":"https://base.example"}')).toEqual(new Map([[30, 'https://base.example']]))
  })
})
