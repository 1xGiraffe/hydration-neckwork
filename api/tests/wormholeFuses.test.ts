import { describe, expect, it } from 'vitest'
import {
  buildFuse,
  decodeRateLimitParams,
  hexToBytes,
  liveCapacity,
  parseNttRateLimitState,
  parseSuiInboxEntries,
  parseSuiPeerEntry,
  parseSuiRateLimit,
  RATE_LIMIT_REFILL_SEC,
  SOLANA_INBOX_RATE_LIMIT_DISCRIMINATOR,
  SOLANA_INBOX_RATE_LIMIT_LENGTH,
  SOLANA_OUTBOX_RATE_LIMIT_DISCRIMINATOR,
  SOLANA_OUTBOX_RATE_LIMIT_LENGTH,
} from '../src/services/wormholeNtt.ts'

// Every chain states its rate limit in its own units — an EVM manager packs a
// trimmed amount, Solana counts native mint units, Sui stamps milliseconds — and
// the whole point of the fuse block is that one number comes out at the
// Hydration asset's precision. The figures below are the live readings the probe
// took on 2026-08-22, so a unit slip is a failing test rather than a wrong page.

const word = (v: bigint) => v.toString(16).padStart(64, '0')

describe('EVM rate-limit params', () => {
  // Ethereum's USDC manager, read live: limit 100,000 USDC packed as a trimmed
  // amount at 6 decimals, capacity-at-last-transfer 93,369.916782, last moved at
  // 1787389559.
  const usdcParams = '0x'
    + '0000000000000000000000000000000000000000000000000000174876e80006'
    + '000000000000000000000000000000000000000000000000000015bd47dd6e06'
    + '000000000000000000000000000000000000000000000000000000006a896677'

  it('unpacks the two trimmed amounts and the timestamp', () => {
    expect(decodeRateLimitParams(usdcParams)).toEqual({
      limit: 100_000_000_000n,
      limitDecimals: 6,
      capacityAtLastTx: 93_369_916_782n,
      lastTxSec: 1_787_389_559,
    })
  })

  it('reads a never-configured leg as unknown rather than as a spent fuse', () => {
    // A null TrimmedAmount is 0 amount at 0 decimals. Reporting it as a fuse
    // would render a leg at 100% consumed that has no limit at all.
    expect(decodeRateLimitParams('0x' + word(0n) + word(0n) + word(0n))).toBeNull()
  })

  it('is null for a short or missing answer', () => {
    expect(decodeRateLimitParams('0x')).toBeNull()
    expect(decodeRateLimitParams(null)).toBeNull()
  })

  it('states the live USDC fuse at the asset’s own precision', () => {
    const params = decodeRateLimitParams(usdcParams)!
    // getCurrentOutboundCapacity() answers already untrimmed, at the origin
    // token's 6 decimals — the same scale USDC carries on Hydration.
    const fuse = buildFuse({
      limitRaw: params.limit,
      capacityRaw: 93_411_583_448n,
      sourceDecimals: 6,
      assetDecimals: 6,
      durationSec: RATE_LIMIT_REFILL_SEC,
      lastConsumedSec: params.lastTxSec,
    })!
    expect(fuse.limit).toBe('100000000000')
    expect(fuse.capacity).toBe('93411583448')
    expect(fuse.utilizationPct).toBeCloseTo(6.5884, 4)
    expect(fuse.durationSec).toBe(86_400)
    expect(fuse.lastConsumedAt).toBe('2026-08-22T09:05:59.000Z')
  })

  it('widens a trimmed limit to an 18-decimal asset', () => {
    // DAI: 100,000 at 8 trimmed decimals must read as 1e23 raw, not 1e13.
    const fuse = buildFuse({
      limitRaw: 100_000_00000000n * 10n ** 10n,
      capacityRaw: 100_000n * 10n ** 18n,
      sourceDecimals: 18,
      assetDecimals: 18,
      durationSec: RATE_LIMIT_REFILL_SEC,
      lastConsumedSec: 1_785_938_579,
    })!
    expect(fuse.limit).toBe('100000000000000000000000')
    expect(fuse.utilizationPct).toBe(0)
  })

  it('has no fuse where the limit is unknown or zero', () => {
    const base = { capacityRaw: 1n, sourceDecimals: 6, assetDecimals: 6, durationSec: 86_400, lastConsumedSec: null }
    expect(buildFuse({ ...base, limitRaw: null })).toBeNull()
    expect(buildFuse({ ...base, limitRaw: 0n })).toBeNull()
    expect(buildFuse({ ...base, limitRaw: 100n, capacityRaw: null })).toBeNull()
  })

  it('never reports a utilization outside 0…100', () => {
    const over = buildFuse({ limitRaw: 100n, capacityRaw: 250n, sourceDecimals: 6, assetDecimals: 6, durationSec: 86_400, lastConsumedSec: null })!
    expect(over.utilizationPct).toBe(0)
    const spent = buildFuse({ limitRaw: 100n, capacityRaw: 0n, sourceDecimals: 6, assetDecimals: 6, durationSec: 86_400, lastConsumedSec: null })!
    expect(spent.utilizationPct).toBe(100)
  })
})

describe('the limiter’s refill formula', () => {
  const base = { capacityAtLastTx: 90n, limit: 100n, lastTxSec: 1_000, durationSec: 100 }

  it('refills linearly over the window', () => {
    expect(liveCapacity({ ...base, nowSec: 1_005 })).toBe(95n)
  })

  it('never exceeds the limit', () => {
    expect(liveCapacity({ ...base, nowSec: 9_999 })).toBe(100n)
  })

  it('clamps a clock that reads behind the last transfer', () => {
    // Our wall clock and the chain's are not the same clock. A negative elapsed
    // must read as "no refill yet", never as capacity going backwards.
    expect(liveCapacity({ ...base, nowSec: 900 })).toBe(90n)
  })

  it('matches the live Solana reading', () => {
    // PRIME on Solana: limit 449,016.984704 with 444,877.534116 left at the
    // last transfer, so 4,139.450588 was consumed and the whole limit refills
    // over 24 hours — about 13 minutes to get it back.
    const capacity = liveCapacity({
      capacityAtLastTx: 444_877_534_116n,
      limit: 449_016_984_704n,
      lastTxSec: 1_787_385_601,
      nowSec: 1_787_385_601 + 500,
      durationSec: RATE_LIMIT_REFILL_SEC,
    })
    expect(capacity).toBe(444_877_534_116n + (449_016_984_704n * 500n) / 86_400n)
    // And the same leg is full again well inside the window.
    expect(liveCapacity({
      capacityAtLastTx: 444_877_534_116n,
      limit: 449_016_984_704n,
      lastTxSec: 1_787_385_601,
      nowSec: 1_787_385_601 + 800,
      durationSec: RATE_LIMIT_REFILL_SEC,
    })).toBe(449_016_984_704n)
  })
})

describe('Solana rate-limit accounts', () => {
  const account = (discriminator: string, length: number, offset: number) => {
    const bytes = new Uint8Array(length)
    bytes.set(hexToBytes(discriminator), 0)
    const view = new DataView(bytes.buffer)
    view.setBigUint64(offset, 2_595_841_271_636n, true)
    view.setBigUint64(offset + 8, 2_574_852_567_496n, true)
    view.setBigInt64(offset + 16, 1_787_384_016n, true)
    return bytes
  }

  it('reads the outbox account straight after its discriminator', () => {
    expect(parseNttRateLimitState(account(SOLANA_OUTBOX_RATE_LIMIT_DISCRIMINATOR, SOLANA_OUTBOX_RATE_LIMIT_LENGTH, 8), 8)).toEqual({
      limit: 2_595_841_271_636n,
      capacityAtLastTx: 2_574_852_567_496n,
      lastTxSec: 1_787_384_016,
    })
  })

  it('reads the inbox account past its bump byte', () => {
    expect(parseNttRateLimitState(account(SOLANA_INBOX_RATE_LIMIT_DISCRIMINATOR, SOLANA_INBOX_RATE_LIMIT_LENGTH, 9), 9)).toEqual({
      limit: 2_595_841_271_636n,
      capacityAtLastTx: 2_574_852_567_496n,
      lastTxSec: 1_787_384_016,
    })
  })

  it('is null for an account too short to hold the state', () => {
    expect(parseNttRateLimitState(new Uint8Array(16), 8)).toBeNull()
  })

  it('keeps SOL’s native units, which are ten times the trimmed ones', () => {
    // SOL trims at 8 decimals and its mint carries 9, so a limit read from the
    // account is already at the asset's precision and must not be widened again.
    const fuse = buildFuse({
      limitRaw: 2_595_841_271_636n,
      capacityRaw: 2_595_841_271_636n,
      sourceDecimals: 9,
      assetDecimals: 9,
      durationSec: RATE_LIMIT_REFILL_SEC,
      lastConsumedSec: 1_787_384_204,
    })!
    expect(fuse.limit).toBe('2595841271636')
    expect(fuse.utilizationPct).toBe(0)
  })
})

describe('Sui rate limits', () => {
  it('reads the three fields and converts the millisecond stamp', () => {
    expect(parseSuiRateLimit({ limit: '100000000000000', capacity_at_last_tx: '96500000000000', last_tx_timestamp: '1787374001133' })).toEqual({
      limit: 100_000_000_000_000n,
      capacityAtLastTx: 96_500_000_000_000n,
      lastTxSec: 1_787_374_001,
    })
  })

  it('is null for anything that is not a rate limit', () => {
    expect(parseSuiRateLimit(null)).toBeNull()
    expect(parseSuiRateLimit({ limit: 'x' })).toBeNull()
  })

  it('finds Hydration’s inbound limit on the peers table', () => {
    const nodes = [{
      name: { json: 73 },
      value: {
        json: {
          address: { value: { data: 'AAAAAAAAAAAAAAAAl4RD8AyrawlEUUAyHsc6Ih6/9fg=' } },
          token_decimals: 9,
          inbound_rate_limit: { limit: '100000000000000', capacity_at_last_tx: '96500000000000', last_tx_timestamp: '1787374001133' },
        },
      },
    }]
    const peer = parseSuiPeerEntry(nodes, 73)!
    expect(peer.tokenDecimals).toBe(9)
    expect(peer.inboundRateLimit?.limit).toBe(100_000_000_000_000n)
    // A peer the manager does not register is absent, not zero.
    expect(parseSuiPeerEntry(nodes, 2)).toBeNull()
  })

  it('reads the inbox entries by the message id their key carries', () => {
    const entries = parseSuiInboxEntries([
      {
        name: { json: { chain_id: 73, message: { id: { data: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAg=' } } } },
        value: { json: { release_status: { '@variant': 'Released' } } },
      },
      {
        name: { json: { chain_id: 73, message: { id: { data: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM=' } } } },
        value: { json: { release_status: { '@variant': 'ReleaseAfter' } } },
      },
    ])
    expect(entries).toEqual([
      { sourceChainId: 73, messageId: '0x' + '00'.repeat(31) + '08', released: true },
      { sourceChainId: 73, messageId: '0x' + '00'.repeat(31) + '03', released: false },
    ])
  })
})
