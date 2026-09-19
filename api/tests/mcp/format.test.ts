/**
 * The presentation library's durable behaviour.
 *
 * Two kinds of assertion live here. The first pins the shared rough number
 * scale and the URL shape against their definitions elsewhere in the repo —
 * `api/src/notifications/render.ts` (imported directly, so a drift in either
 * copy fails here) and the literal values AGENTS.md § UI states. The second
 * renders REAL activity rows, copied verbatim out of the live-response samples
 * the MCP design was derived from, and checks that nothing raw leaks into the
 * line an agent reads: no unscaled integer, no AccountId32 hex, no placeholder
 * block height on an unconfirmed row.
 *
 * Fixture provenance (scratchpad `samples/`, probed 2026-09-18, head ≈ 14,743,700):
 *   SWAP             explorer_address_13b6hRR…p3hMN_activity_limit_5.json[0]
 *   DCA_EXECUTION    explorer_tag_treasury_activity_limit_3.json[0]
 *   LIQUIDITY_ADD    explorer_pool_690_activity_limit_3.json[1]
 *   UNCONFIRMED_SWAP explorer_activity_limit_5.json[0]
 *   TRANSFER/VOTE/XCM_OUT — /explorer/activity?type=transfer|vote|xcm, same
 *   session; the recorded sample set holds no row of those three families.
 */

import { describe, it, expect } from 'vitest'
// The server-side reference implementation of the shared scale. Importing it is
// the point: these renderings are deliberately parallel, and a change to one
// that is not made to the other should fail a test rather than ship.
import { compactAmount, compactUsd } from '../../src/notifications/render.ts'
import type { ActivityRow } from '../../src/mcp/types.ts'
import {
  scaleAmount, formatAmount, formatCount, formatNumber, formatUsd, formatPercent, formatPercentChange,
  formatBase1e8, formatBasisPoints, formatHealthFactor, subscriptZero,
} from '../../src/mcp/format/units.ts'
import {
  parseChainTime, formatTime, formatUnixSeconds, relativeAge, formatDuration, blocksToDuration,
  isUnrecordedTime,
} from '../../src/mcp/format/time.ts'
import {
  accountLabel, assetLabel, assetLabelWithId, assetPairLabels, shortAddress, shortHash, explorerLink,
  accountUrl, blockUrl, extrinsicUrl, extrinsicAtUrl, eventUrl, tradeUrl, dcaScheduleUrl,
  dcaExecutionUrl, intentUrl, referendumUrl, poolUrl, v3PoolUrl, assetUrl, holdersUrl,
  tagUrl, xcDestinationUrl, contractUrl, activityUrl,
} from '../../src/mcp/format/refs.ts'
import { budget, bullets, code, escapeCell, h2, h3, joinBlocks, kv, note, section, table } from '../../src/mcp/format/md.ts'
import {
  ACTIVITY_ACTIONS, ACTIVITY_ROW_TYPES, ACTIVITY_TYPES, ACTIVITY_TYPE_NOTES, TYPES_WITH_ACTIONS,
  actionsForType, activityDetail, activityKind, activityLine, activitySlug, activityUrlFor,
  describeActivityFilters, isUnconfirmed, unconfirmedNote,
} from '../../src/mcp/format/activity.ts'
import { JSON_TRUNCATION_KEY, fitJson } from '../../src/mcp/format/json.ts'

const BASE = 'https://hydration-explorer.neckwork.net'
// Fixed so `relativeAge` is a fact about the fixtures, not about the clock.
const NOW = new Date('2026-09-18T11:00:00Z')

/* ============ real rows, verbatim ============ */

const SWAP: ActivityRow = {
  "type": "trade",
  "blockHeight": 14743749,
  "timestamp": "2026-09-18 10:07:42",
  "eventIndex": 46,
  "extrinsicIndex": 2,
  "who": {
    "accountId": "0x7279fcf9694718e1234d102825dccaf332f0ea36edf1ca7c0358c4b68260d24b",
    "address": "13b6hRRYPHTxFzs9prvL2YGHQepvd4YhdDb9Tc7khySp3hMN",
    "emoji": "🌻",
    "tag": null,
    "identity": null,
    "profile": null
  },
  "to": null,
  "asset": null,
  "assetIn": {
    "assetId": 10,
    "iconAssetId": 10,
    "symbol": "USDT",
    "name": "Tether",
    "decimals": 6,
    "parachainId": 1000,
    "origin": {
      "ecosystem": "polkadot",
      "chainId": "1000",
      "assetId": null
    }
  },
  "assetOut": {
    "assetId": 1000794,
    "iconAssetId": 1000794,
    "symbol": "LINK",
    "name": "Chainlink",
    "decimals": 18,
    "parachainId": null,
    "origin": {
      "ecosystem": "ethereum",
      "chainId": "1",
      "assetId": "0x514910771af9ca656af840dff83e8264ecf986ca"
    }
  },
  "amount": null,
  "amountIn": "60178811",
  "amountOut": "5064905271705682716",
  "valueUsd": 60.16500385235045,
  "linkBlock": 14743749,
  "linkIndex": 2,
  "revenue": {
    "protocolUsd": 0.141932279425,
    "lpUsd": 0.075394741669,
    "streams": [
      {
        "stream": "omnipool_asset_fee",
        "usd": 0.075394741669
      },
      {
        "stream": "omnipool_protocol_fee",
        "usd": 0.061576110187
      },
      {
        "stream": "network_fee",
        "usd": 0.004961427569
      }
    ]
  }
}

const DCA_EXECUTION: ActivityRow = {
  "type": "trade",
  "blockHeight": 14743807,
  "timestamp": "2026-09-18 10:09:42",
  "eventIndex": 22,
  "extrinsicIndex": null,
  "who": {
    "accountId": "0x6d6f646c70792f74727372790000000000000000000000000000000000000000",
    "address": "13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB",
    "emoji": "🏦",
    "tag": {
      "id": "treasury",
      "name": "Treasury",
      "color": "",
      "icon": "🏦",
      "memberCount": 7
    },
    "identity": null,
    "profile": null
  },
  "to": null,
  "asset": null,
  "assetIn": {
    "assetId": 1,
    "iconAssetId": 1,
    "symbol": "H2O",
    "name": null,
    "decimals": 12,
    "parachainId": null,
    "origin": null
  },
  "assetOut": {
    "assetId": 0,
    "iconAssetId": 0,
    "symbol": "HDX",
    "name": "Hydration",
    "decimals": 12,
    "parachainId": null,
    "origin": null
  },
  "amount": null,
  "amountIn": "1040000000000",
  "amountOut": "773873066511711",
  "valueUsd": 5.994916857564143,
  "dca": true,
  "dcaScheduleId": 30104,
  "linkBlock": 12108870,
  "linkIndex": null,
  "revenue": {
    "protocolUsd": 0.188371249112,
    "lpUsd": 0.138563861174,
    "streams": [
      {
        "stream": "omnipool_asset_fee",
        "usd": 0.128676720737
      },
      {
        "stream": "omnipool_protocol_fee",
        "usd": 0.059694528375
      }
    ]
  }
}

const TRANSFER: ActivityRow = {
  "type": "transfer",
  "blockHeight": 14744261,
  "timestamp": "2026-09-18 10:25:48",
  "eventIndex": 6,
  "extrinsicIndex": 2,
  "who": {
    "accountId": "0xc8ca46fa2c9e4101f07bacdc140ac0d21c73655b815ec223a2a6f2f1a328ae53",
    "address": "15YGfcskuwQ39VSf325XHcsTudXxZoNA7oEPsCeufySvu5ue",
    "emoji": "🐕",
    "tag": null,
    "identity": null,
    "profile": null
  },
  "to": {
    "accountId": "0x091cbd233fb39516ff1e26a64af98cd466e8a502c0536508cb01e9143a10519c",
    "address": "1Cwy9wXoJvQJ3nPrWwxbVvQD4dffK8AgWD5cbBsExV8su6M",
    "emoji": "🦕",
    "tag": null,
    "identity": null,
    "profile": null
  },
  "asset": {
    "assetId": 5,
    "iconAssetId": 5,
    "symbol": "DOT",
    "name": "Polkadot",
    "decimals": 10,
    "parachainId": null,
    "origin": null
  },
  "assetIn": null,
  "assetOut": null,
  "amount": "44000000000000",
  "amountIn": null,
  "amountOut": null,
  "valueUsd": 5132.132730388401,
  "revenue": {
    "protocolUsd": 0.004074350776,
    "lpUsd": 0,
    "streams": [
      {
        "stream": "network_fee",
        "usd": 0.004074350776
      }
    ]
  }
}

const VOTE: ActivityRow = {
  "type": "vote",
  "blockHeight": 14744595,
  "timestamp": "2026-09-18 10:37:24",
  "eventIndex": 7,
  "extrinsicIndex": 2,
  "who": {
    "accountId": "0xda00b5c3a0576a0765d786ac274743f955d90f0aa982418837fc83ef04973a7b",
    "address": "15vqegskZjZbWfcUi1wvY9Sv5yoVgbhCUUgv7Uy6o1HFcVVw",
    "emoji": "🦔",
    "tag": null,
    "identity": null,
    "profile": null
  },
  "to": null,
  "asset": {
    "assetId": 0,
    "iconAssetId": 0,
    "symbol": "HDX",
    "name": "Hydration",
    "decimals": 12,
    "parachainId": null,
    "origin": null
  },
  "assetIn": null,
  "assetOut": null,
  "amount": "51557496102718464",
  "amountIn": null,
  "amountOut": null,
  "valueUsd": 399.3974152805164,
  "votePallet": "ConvictionVoting",
  "voteAction": "Voted",
  "voteRef": "410",
  "voteSide": "Aye",
  "voteConviction": "Locked3x",
  "voteRefPallet": "opengov",
  "voteRefTitle": "Reduce Omnipool weight cap for aDOT (DOT) from 30% to 10%",
  "linkBlock": 14744595,
  "linkIndex": 2,
  "revenue": {
    "protocolUsd": 0.003778470093,
    "lpUsd": 0,
    "streams": [
      {
        "stream": "network_fee",
        "usd": 0.003778470093
      }
    ]
  }
}

const XCM_OUT: ActivityRow = {
  "type": "xcm",
  "blockHeight": 14744294,
  "timestamp": "2026-09-18 10:26:54",
  "eventIndex": 7,
  "extrinsicIndex": 2,
  "who": {
    "accountId": "0x091cbd233fb39516ff1e26a64af98cd466e8a502c0536508cb01e9143a10519c",
    "address": "1Cwy9wXoJvQJ3nPrWwxbVvQD4dffK8AgWD5cbBsExV8su6M",
    "emoji": "🦕",
    "tag": null,
    "identity": null,
    "profile": null
  },
  "to": null,
  "asset": {
    "assetId": 5,
    "iconAssetId": 5,
    "symbol": "DOT",
    "name": "Polkadot",
    "decimals": 10,
    "parachainId": null,
    "origin": null
  },
  "assetIn": null,
  "assetOut": null,
  "amount": "44000000000000",
  "amountIn": null,
  "amountOut": null,
  "valueUsd": 5132.132730388401,
  "xcmDir": "out",
  "xcmExecuted": true,
  "xcmFees": [
    {
      "kind": "delivery",
      "asset": {
        "assetId": 0,
        "iconAssetId": 0,
        "symbol": "HDX",
        "name": "Hydration",
        "decimals": 12,
        "parachainId": null,
        "origin": null
      },
      "amount": "584286344416",
      "valueUsd": 0.004526256575348847
    }
  ],
  "destChain": "Bifrost",
  "destParachainId": 2030,
  "destAccount": {
    "kind": "AccountId32",
    "accountId": "0x091cbd233fb39516ff1e26a64af98cd466e8a502c0536508cb01e9143a10519c",
    "raw": "0x091cbd233fb39516ff1e26a64af98cd466e8a502c0536508cb01e9143a10519c",
    "address": "1Cwy9wXoJvQJ3nPrWwxbVvQD4dffK8AgWD5cbBsExV8su6M",
    "subscanUrl": "https://bifrost.subscan.io/account/bvuX7Bx74AmEQDBHiE6ruWx5yVRzQuHp9XsJh3g2644Zk6m",
    "emoji": "🦕",
    "tag": null,
    "identity": null,
    "profile": null
  },
  "linkBlock": 14744294,
  "linkIndex": 2,
  "revenue": {
    "protocolUsd": 0.004526256575,
    "lpUsd": 0,
    "streams": [
      {
        "stream": "network_fee",
        "usd": 0.004526256575
      }
    ]
  }
}

const LIQUIDITY_ADD: ActivityRow = {
  "type": "liquidity",
  "blockHeight": 14742679,
  "timestamp": "2026-09-18 09:27:00",
  "eventIndex": 16,
  "extrinsicIndex": 2,
  "who": {
    "accountId": "0x4554480033a7ec1055edd4cc35ef289156c7a7a0780434740000000000000000",
    "address": "0x33a7ec1055edd4cc35ef289156c7a7a078043474",
    "emoji": "💐",
    "tag": null,
    "identity": null,
    "profile": null
  },
  "to": null,
  "asset": {
    "assetId": 690,
    "iconAssetId": 69,
    "iconAssetIds": [
      15,
      5
    ],
    "symbol": "2-Pool-GDOT",
    "name": null,
    "decimals": 18,
    "parachainId": null,
    "origin": null
  },
  "assetIn": null,
  "assetOut": null,
  "amount": "99933867443901074862",
  "valueUsd": 126.09405656718427,
  "amountIn": null,
  "amountOut": null,
  "liqAction": "Add",
  "linkBlock": 14742679,
  "linkIndex": 2
}

const UNCONFIRMED_SWAP: ActivityRow = {
  "blockHeight": 14743723,
  "timestamp": "2026-09-18 10:06:54",
  "eventIndex": 74,
  "extrinsicIndex": null,
  "linkBlock": null,
  "linkIndex": null,
  "finalized": false,
  "type": "trade",
  "who": {
    "accountId": "0x6d6f646c66656570726f632f0000000000000000000000000000000000000000",
    "address": "13UVJyLkaPAE2HDTAaSadmwptPVwzY621KiKZ1ZrKYaXga2w",
    "emoji": "🦁",
    "tag": {
      "id": "fee-processor",
      "name": "Fee Processor",
      "color": "var(--accent)",
      "icon": "🦁",
      "memberCount": 1
    },
    "identity": null,
    "profile": null
  },
  "to": null,
  "asset": null,
  "assetIn": {
    "assetId": 222,
    "iconAssetId": 222,
    "symbol": "HOLLAR",
    "name": "Hydrated Dollar",
    "decimals": 18,
    "parachainId": null,
    "origin": null
  },
  "assetOut": {
    "assetId": 0,
    "iconAssetId": 0,
    "symbol": "HDX",
    "name": "Hydration",
    "decimals": 12,
    "parachainId": null,
    "origin": null
  },
  "amount": null,
  "amountIn": "284302451217553232",
  "amountOut": "36709253085197",
  "valueUsd": 0.2839752814556701,
  "assetRefs": [
    222,
    0
  ],
  "dca": false
}

/* ============ the shared rough number scale ============ */

describe('rough display scale', () => {
  it('renders the scale AGENTS.md § UI states', () => {
    expect(formatNumber(500)).toBe('500')
    expect(formatNumber(537)).toBe('537')
    expect(formatNumber(4870)).toBe('4.87k')
    expect(formatNumber(40000)).toBe('40k')
    expect(formatNumber(112000)).toBe('112k')
    expect(formatNumber(4590000)).toBe('4.59M')
    // Below 1, ~3 significant decimals.
    expect(formatNumber(0.12)).toBe('0.12')
    expect(formatNumber(0.0034)).toBe('0.0034')
    // Very small fractions collapse into subscript-zero notation.
    expect(formatNumber(0.0000007191)).toBe('0.0₅7191')
    // Tiering happens on the ROUNDED value, so the carry band reads as the next unit.
    expect(formatNumber(999600000)).toBe('1B')
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(null)).toBe('—')
    expect(formatNumber(Number.NaN)).toBe('—')
    expect(formatNumber(-4870)).toBe('-4.87k')
  })

  it('agrees with the notification renderer on every one of them', () => {
    for (const v of [500, 537, 4870, 40000, 112000, 4590000, 0.12, 0.0034, 0.0000007191, 999600000, 0, -4870, 1234567890123]) {
      expect(formatNumber(v)).toBe(compactAmount(v))
    }
  })

  it('renders USD with the dollar tier and agrees with the notification renderer', () => {
    expect(formatUsd(0.12)).toBe('$0.12')
    expect(formatUsd(4870)).toBe('$4.87k')
    expect(formatUsd(4590000)).toBe('$4.59M')
    expect(formatUsd(null)).toBe('—')
    // A signed value signs the figure, not the digits.
    expect(formatUsd(-1200)).toBe('-$1.2k')
    for (const v of [0.12, 12.345, 99.9, 4870, 4590000, 0.001234, -1200, 0]) {
      expect(formatUsd(v)).toBe(compactUsd(v))
    }
  })

  it('pins subscript-zero notation on its own', () => {
    expect(subscriptZero(0.0000007191)).toBe('0.0₅7191')
    expect(subscriptZero(0.004526)).toBe('0.0₁4526')
  })

  it('renders percentages in the unit each field actually uses', () => {
    // sharePct / ltv style: already 0–100.
    expect(formatPercent(62.9)).toBe('62.90%')
    expect(formatPercent(62.9, 1)).toBe('62.9%')
    // change24h style: a signed fraction.
    expect(formatPercentChange(0.064053)).toBe('+6.41%')
    expect(formatPercentChange(-0.012)).toBe('-1.20%')
    expect(formatPercent(null)).toBe('—')
  })
})

/* ============ raw amounts ============ */

describe('scaleAmount', () => {
  it('keeps the leading digits of a 128-bit amount', () => {
    const u128Max = '340282366920938463463374607431768211455'
    expect(scaleAmount(u128Max, 18)).toBe(340282366920938463463.374607431768211455)
    expect(formatNumber(scaleAmount(u128Max, 18))).toBe('3.40e+20')

    const wide = '123456789012345678901234567890'
    const scaled = scaleAmount(wide, 12)
    expect(scaled).not.toBeNull()
    // 123456789012345678.90123456789 — the digits a double can hold are the LEADING ones.
    expect(scaled!.toPrecision(16)).toBe('1.234567890123457e+17')
    expect(formatNumber(scaled)).toBe('123Q')
  })

  it('does not manufacture digits the way Number(raw) / 10 ** decimals does', () => {
    // Both roundings in the naive route compound; splitting with BigInt and
    // parsing the composed decimal rounds exactly once.
    const raw = '299999999999999999999999'
    expect(scaleAmount(raw, 23)).toBe(3)
    expect(Number(raw) / 10 ** 23).not.toBe(3)
  })

  it('distinguishes absent from zero, and refuses a non-integer string', () => {
    expect(scaleAmount(null, 12)).toBeNull()
    expect(scaleAmount(undefined, 12)).toBeNull()
    expect(scaleAmount('', 12)).toBeNull()
    expect(scaleAmount('abc', 12)).toBeNull()
    expect(scaleAmount('0', 12)).toBe(0)
    expect(scaleAmount('-44000000000000', 10)).toBe(-4400)
    expect(scaleAmount('4200', 0)).toBe(4200)
  })

  it('scales each leg by its own decimals and appends the symbol', () => {
    expect(formatAmount('14502813108208', 12, 'HDX')).toBe('14.5 HDX')
    expect(formatAmount('284302451217553232', 18, 'HOLLAR')).toBe('0.284 HOLLAR')
    expect(formatAmount('60178811', 6, 'USDT')).toBe('60.2 USDT')
    expect(formatAmount('44000000000000', 10, 'DOT')).toBe('4.4k DOT')
    // No figure means no unit either: "— HDX" would read as zero HDX.
    expect(formatAmount(null, 12, 'HDX')).toBe('—')
  })
})

describe('money-market encodings', () => {
  it('renders a 1e8 base figure as USD, so it can never be read at the wrong scale', () => {
    // The whole point of the helper: these are dollars, and a bare "334k" beside
    // a token amount invites a reader to take it as tokens.
    expect(formatBase1e8('33374486091105')).toBe('$334k')
    expect(formatBase1e8('145614391095')).toBe('$1.46k')
    expect(formatBase1e8('0')).toBe('$0')
    expect(formatBase1e8(null)).toBe('—')
    // A sentinel is a value in this encoding, not a parse failure — and an
    // unbounded figure is said in words rather than printed as a number.
    expect(formatBase1e8('inf')).toBe('unbounded')
  })

  it('keeps enough health-factor precision to see the liquidation boundary', () => {
    expect(formatHealthFactor('inf')).toBe('∞ (no debt)')
    // Two decimals would render all three of these as "1.00", which is exactly
    // the distance a caller asking about liquidation risk needs to see.
    expect(formatHealthFactor('1000454324113333835')).toBe('1.0005')
    expect(formatHealthFactor('1004900000000000000')).toBe('1.0049')
    expect(formatHealthFactor('999900000000000000')).toBe('0.9999')
    expect(formatHealthFactor('1210263104132797440')).toBe('1.2103')
    expect(formatHealthFactor('0')).toBe('0.0000')
    // Far from the boundary the fourth decimal is noise.
    expect(formatHealthFactor('51914445360548548600')).toBe('51.91')
    // A position the service could price but not rate.
    expect(formatHealthFactor('unknown')).toBe('unknown')
    expect(formatHealthFactor(null)).toBe('—')
  })

  it('reads ltv and liquidation threshold as basis points', () => {
    expect(formatBasisPoints('8800')).toBe('88.00%')
    expect(formatBasisPoints('8500')).toBe('85.00%')
    expect(formatBasisPoints(null)).toBe('—')
  })
})

/* ============ time ============ */

describe('chain timestamps', () => {
  it('reads a ClickHouse timestamp as UTC', () => {
    const d = parseChainTime('2026-09-18 09:41:12')
    expect(d).not.toBeNull()
    expect(d!.toISOString()).toBe('2026-09-18T09:41:12.000Z')
    // Pinned against UTC rather than the process zone: a timezone-naive parse
    // reads the same string as LOCAL time and shifts every age by the offset.
    expect(d!.getTime()).toBe(Date.UTC(2026, 8, 18, 9, 41, 12))
    // A value that already carries a zone keeps it — appending 'Z' blindly
    // would turn '…+02:00' into an invalid date rather than a corrected one.
    expect(parseChainTime('2026-09-18 09:41:12+02:00')!.toISOString()).toBe('2026-09-18T07:41:12.000Z')
    expect(parseChainTime('2026-09-18')!.toISOString()).toBe('2026-09-18T00:00:00.000Z')
    expect(parseChainTime('')).toBeNull()
    expect(parseChainTime(null)).toBeNull()
  })

  it('states the zone it printed', () => {
    expect(formatTime('2026-09-18 09:41:12')).toBe('2026-09-18 09:41:12 UTC')
    expect(formatTime(null)).toBe('—')
    // Revenue and staker points, and a candle's intervalStart, are unix seconds.
    expect(formatUnixSeconds(1758000000)).toBe('2025-09-16 05:20:00 UTC')
    expect(formatUnixSeconds(null)).toBe('—')
  })

  it('ages a row in one unit', () => {
    const now = new Date('2026-09-18T10:00:00Z')
    expect(relativeAge('2026-09-18 09:59:50', now)).toBe('just now')
    expect(relativeAge('2026-09-18 09:57:00', now)).toBe('3m ago')
    expect(relativeAge('2026-09-18 08:00:00', now)).toBe('2h ago')
    expect(relativeAge('2026-09-13 10:00:00', now)).toBe('5d ago')
    expect(relativeAge('2026-09-18 10:03:00', now)).toBe('in 3m')
    expect(relativeAge(null, now)).toBe('—')
  })

  it('spells a span with at most two terms', () => {
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(3900)).toBe('1h 5m')
    expect(formatDuration(86400 * 3 + 3600 * 4)).toBe('3d 4h')
    expect(formatDuration(null)).toBe('—')
  })

  it('converts a block count at the nominal slot time', () => {
    // 14,400 blocks is a pallet's "day" at the nominal 6s rate it was written for.
    expect(blocksToDuration(14400, 6)).toBe('1d')
    expect(blocksToDuration(14400, 2)).toBe('8h')
    expect(blocksToDuration(100, 0)).toBe('—')
  })
})

/* ============ entity labels ============ */

describe('labels', () => {
  it('names an asset, and never prints a cross-chain sentinel id', () => {
    const hdx = { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12 }
    expect(assetLabel(hdx)).toBe('HDX')
    expect(assetLabelWithId(hdx)).toBe('HDX (#0)')
    // A cross-chain destination's assetId is a negative sentinel: route by its
    // platform, and never show the number.
    const wnear = { assetId: -1, symbol: 'wNEAR', name: 'Wrapped NEAR', decimals: 24 }
    expect(assetLabelWithId(wnear)).toBe('wNEAR (cross-chain)')
    expect(assetLabelWithId(wnear)).not.toContain('-1')
    expect(assetLabel(null)).toBe('—')
  })

  it('prefers a real name over an address, and never shows AccountId32 hex', () => {
    const address = '13b6hRRYPHTxFzs9prvL2YGHQepvd4YhdDb9Tc7khySp3hMN'
    const accountId = '0x7279fcf9694718e1234d102825dccaf332f0ea36edf1ca7c0358c4b68260d24b'
    expect(shortAddress(address)).toBe('13b6hR…p3hMN')
    expect(shortHash('0xdc773062b3cee9f8c89da28610cf091c80c0da0f0ce5457f762d1b6db75453f9')).toBe('0xdc7730…5453f9')

    expect(accountLabel({ accountId, address, emoji: '🌻', tag: null })).toBe('🌻 13b6hR…p3hMN')
    expect(accountLabel({ accountId, address, emoji: '🌻', tag: null }, { withAddress: true })).toBe('🌻 13b6hR…p3hMN')
    expect(accountLabel({
      accountId, address, emoji: '🌻', tag: null,
      identity: { display: 'lolmcshizz', verified: true },
    })).toBe('🌻 lolmcshizz ✓')
    expect(accountLabel({
      accountId, address, emoji: '🏦',
      tag: { id: 'treasury', name: 'Treasury', color: '', icon: '🏦' },
    }, { withAddress: true })).toBe('🏦 Treasury (13b6hR…p3hMN)')
    // A pallet account spells its PalletId, so it is named rather than elided.
    expect(accountLabel({
      accountId: '0x6d6f646c70792f74727372790000000000000000000000000000000000000000',
      address: '13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB', emoji: '🏦', tag: null,
    })).toBe('⚙️ py/trsry')
    // Handed a bare public key with nothing to resolve it, say so rather than
    // passing the hex off as an address.
    expect(accountLabel(accountId)).toBe('id 0x7279fc…60d24b')
    expect(accountLabel(null)).toBe('—')
  })
})

/* ============ canonical URLs ============ */

describe('canonical URLs match explorer-ui/src/router.tsx paths', () => {
  const addr = '13b6hRRYPHTxFzs9prvL2YGHQepvd4YhdDb9Tc7khySp3hMN'
  const hash = '0xdc773062b3cee9f8c89da28610cf091c80c0da0f0ce5457f762d1b6db75453f9'

  it('builds every route the tools link to', () => {
    expect(accountUrl(BASE, addr)).toBe(`${BASE}/account/${addr}`)
    expect(blockUrl(BASE, 14743669)).toBe(`${BASE}/block/14743669`)
    expect(extrinsicUrl(BASE, hash)).toBe(`${BASE}/extrinsic/${hash}`)
    expect(extrinsicAtUrl(BASE, 14743669, 2)).toBe(`${BASE}/extrinsic/14743669-2`)
    expect(eventUrl(BASE, 14743669, 48)).toBe(`${BASE}/event/14743669-48`)
    expect(activityUrl(BASE, 'swap', '14743669-e46')).toBe(`${BASE}/swap/14743669-e46`)
    expect(tradeUrl(BASE, 14743669, 2)).toBe(`${BASE}/swap/14743669-2`)
    expect(tradeUrl(BASE, 14743716, 87, { event: true })).toBe(`${BASE}/swap/14743716-e87`)
    expect(dcaScheduleUrl(BASE, 30104)).toBe(`${BASE}/dca/30104`)
    expect(dcaExecutionUrl(BASE, 14743837, 23)).toBe(`${BASE}/dca/14743837-e23`)
    expect(intentUrl(BASE, '33008562192747753225502851072109')).toBe(`${BASE}/intent/33008562192747753225502851072109`)
    expect(referendumUrl(BASE, 'opengov', 410)).toBe(`${BASE}/referendum/opengov/410`)
    expect(poolUrl(BASE, 690)).toBe(`${BASE}/pool/690`)
    // A concentrated-liquidity pool is addressed by its contract, lower-cased.
    expect(v3PoolUrl(BASE, '0x5C6208A3C316A801F8996750AA7B6F45FC988548')).toBe(`${BASE}/pool/0x5c6208a3c316a801f8996750aa7b6f45fc988548`)
    expect(assetUrl(BASE, 0)).toBe(`${BASE}/asset/0`)
    expect(holdersUrl(BASE, 0)).toBe(`${BASE}/holders/0`)
    expect(tagUrl(BASE, 'money-market')).toBe(`${BASE}/tag/money-market`)
    expect(xcDestinationUrl(BASE, 'zec')).toBe(`${BASE}/asset/xc/zec`)
    // A contract's page IS its account page — there is no /contract route.
    expect(contractUrl(BASE, '0xdee629af973ebf5bf261ace12ffd1900ac715f5e')).toBe(`${BASE}/account/0xdee629af973ebf5bf261ace12ffd1900ac715f5e`)
  })

  it('normalizes the base and escapes what a path segment needs', () => {
    expect(blockUrl(`${BASE}/`, 1)).toBe(`${BASE}/block/1`)
    expect(tagUrl(BASE, 'a b')).toBe(`${BASE}/tag/a%20b`)
    expect(explorerLink('HDX', `${BASE}/asset/0`)).toBe(`[HDX](${BASE}/asset/0)`)
  })
})

/* ============ markdown ============ */

describe('markdown builders', () => {
  it('heads, bullets, sections and blocks', () => {
    expect(h2('Balances')).toBe('## Balances')
    expect(h3('Reserves')).toBe('### Reserves')
    expect(bullets(['one', null, '', 'two'])).toBe('- one\n- two')
    expect(bullets([])).toBe('_none_')
    expect(section('Balances', 'body')).toBe('## Balances\nbody')
    expect(section('Balances', '')).toBe('')
    expect(joinBlocks('a', '', null, 'b')).toBe('a\n\nb')
    expect(code('x = 1', 'ts')).toBe('```ts\nx = 1\n```')
    expect(note('nothing yet')).toBe('_nothing yet_')
  })

  it('drops a kv pair with no value rather than asserting an empty one', () => {
    expect(kv([['Fee', '0.004 HDX'], ['Tip', null], ['Error', '']])).toBe('- **Fee:** 0.004 HDX')
  })

  it('says "none" instead of rendering an empty table', () => {
    expect(table(['Asset', 'Amount'], [])).toBe('_none_')
    expect(table(['Asset', 'Amount'], [], 'no open orders')).toBe('_none_ — no open orders')
  })

  it('right-aligns numeric columns', () => {
    const out = table(['Asset', 'Value'], [['HDX', '$4.87k'], ['DOT', '$112']])
    expect(out.split('\n')[1]).toBe('| --- | ---: |')
    expect(out.split('\n')[2]).toBe('| HDX | $4.87k |')
  })

  it('keeps a pipe or a newline from shearing a row', () => {
    expect(escapeCell('a|b')).toBe('a\\|b')
    expect(escapeCell('a\nb')).toBe('a b')
    const out = table(['Name'], [['Utility|Batch']])
    expect(out.split('\n')[2]).toBe('| Utility\\|Batch |')
  })

  it('trims at a line boundary and states what it dropped', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n')
    const out = budget(text, 300, 'Narrow with limit= or a from/to window.')
    expect(out.length).toBeLessThan(text.length)
    // Nothing is cut mid-line: every kept line is a whole one from the input.
    const keptLines = out.split('\n\n_Truncated')[0].split('\n')
    for (const line of keptLines) expect(text.split('\n')).toContain(line)
    expect(out).toContain('_Truncated:')
    expect(out).toContain('lines) not shown.')
    expect(out).toContain('Narrow with limit=')
    // Under budget, nothing is touched and nothing is claimed.
    expect(budget(text, 100000)).toBe(text)
    expect(budget(text, 100000)).not.toContain('Truncated')
  })
})

/* ============ the activity vocabulary ============ */

describe('activity vocabulary', () => {
  it('exports the 13 query types and the 12 row types, which are not the same list', () => {
    expect(ACTIVITY_TYPES).toHaveLength(13)
    expect(ACTIVITY_TYPES).toContain('all')
    expect(ACTIVITY_TYPES).toContain('stake')
    expect(ACTIVITY_ROW_TYPES).toHaveLength(12)
    expect(ACTIVITY_ROW_TYPES).not.toContain('all')
    // `stake` is the query word; rows arrive typed `staking`.
    expect(ACTIVITY_ROW_TYPES).toContain('staking')
    expect(ACTIVITY_TYPES).not.toContain('staking')
  })

  it('exports the per-type action table', () => {
    expect(ACTIVITY_ACTIONS.mm).toEqual(['Supply', 'Withdraw', 'Borrow', 'Repay', 'LiquidationCall', 'ClaimRewards'])
    expect(ACTIVITY_ACTIONS.xcm).toEqual(['out', 'in'])
    expect(ACTIVITY_ACTIONS.vote).toEqual(['Aye', 'Nay'])
    expect(ACTIVITY_ACTIONS.trade).toContain('intent-fill')
    expect(ACTIVITY_ACTIONS.liquidity).toContain('CollectFees')
  })

  it('names the three traps an agent cannot discover by calling', () => {
    expect(ACTIVITY_TYPE_NOTES).toContain('type=dca')
    expect(ACTIVITY_TYPE_NOTES).toContain('FAMILY')
    expect(ACTIVITY_TYPE_NOTES).toContain('empty page')
  })

  it('maps a query type to the action vocabulary that actually applies to it', () => {
    // `type=dca` selects the trade family, so it takes the trade vocabulary —
    // measured against the live route, `type=dca&action=dca` returns rows.
    expect(actionsForType('dca')).toEqual(ACTIVITY_ACTIONS.trade)
    expect(actionsForType('mm')).toEqual(ACTIVITY_ACTIONS.mm)
    // A type with no action vocabulary must report none rather than an empty
    // list a caller could read as "anything goes".
    expect(actionsForType('transfer')).toBeNull()
    expect(actionsForType('all')).toBeNull()
    expect(actionsForType(undefined)).toBeNull()
    expect(TYPES_WITH_ACTIONS).toContain('dca')
    expect(TYPES_WITH_ACTIONS).toContain('trade')
    expect(TYPES_WITH_ACTIONS).not.toContain('transfer')
  })

  it('echoes what was filtered, and flags the filters that fail silently', () => {
    const line = describeActivityFilters({ account: '13b6hRR…', type: 'dca', token: 'HDX', limit: 25 })
    expect(line).toContain('type=dca')
    expect(line).toContain('token=HDX')
    expect(line).toContain('An unrecognised `token` matches nothing upstream')
    // With no soft filter set there is nothing to warn about.
    expect(describeActivityFilters({ type: 'transfer', limit: 25 })).not.toContain('unrecognised')
  })

  it('never echoes an `action` the upstream ignored', () => {
    // Measured: /explorer/activity?limit=3&action=nonsense answers three
    // ordinary transfers. Echoed as `action=nonsense` above them, a model
    // concludes those three rows matched it.
    const ignored = describeActivityFilters({ action: 'nonsense', limit: 3 })
    expect(ignored).not.toContain('action=nonsense,')
    expect(ignored).toContain('NOT APPLIED')
    expect(ignored).toContain('unless a `type` is set')
    // With a type it IS applied, and is echoed as such with no caveat.
    const applied = describeActivityFilters({ type: 'mm', action: 'Borrow', limit: 3 })
    expect(applied).toContain('action=Borrow')
    expect(applied).not.toContain('NOT APPLIED')
  })

  it('repeats the type=dca trap beside the rows, not only in the tool description', () => {
    const line = describeActivityFilters({ type: 'dca', limit: 5 })
    expect(line).toContain('TRADE family')
    expect(line).toContain('DCA execution')
    expect(describeActivityFilters({ type: 'trade', limit: 5 })).not.toContain('TRADE family')
  })

  it('tells the two unconfirmed states apart, because only one lacks a block height', () => {
    const pooled: ActivityRow = { ...UNCONFIRMED_SWAP, mempool: true, finalized: false, blockHeight: 0 }
    const ahead: ActivityRow = { ...UNCONFIRMED_SWAP, mempool: false, finalized: false, blockHeight: 14_747_843 }

    const both = unconfirmedNote([pooled, ahead])!
    expect(both).toContain('TRANSACTION POOL')
    expect(both).toContain('zero placeholder')
    expect(both).toContain('REAL block')
    expect(both).toContain('genuine')

    // A page of rows that are merely above the finalized head must NOT be told
    // it carries no real block height: those heights are quotable.
    const aheadOnly = unconfirmedNote([ahead])!
    expect(aheadOnly).toContain('genuine')
    expect(aheadOnly).not.toContain('placeholder')

    expect(unconfirmedNote([SWAP])).toBeNull()
  })
})

/* ============ the JSON budget ============ */

describe('fitJson', () => {
  const size = (v: unknown) => JSON.stringify(v, null, 2).length

  it('returns a document that already fits, untouched', () => {
    const doc = { a: 1, rows: [1, 2, 3] }
    expect(fitJson(doc, 10_000)).toBe(doc)
  })

  it('shrinks by whole records and stays parseable', () => {
    const doc = { meta: 'x', rows: Array.from({ length: 500 }, (_, i) => ({ i, label: `row ${i}`, value: i * 1.5 })) }
    expect(size(doc)).toBeGreaterThan(5_000)
    const fitted = fitJson(doc, 5_000) as Record<string, unknown>
    // The reply is JSON a caller can parse — the whole point of trimming here
    // rather than letting the transport cut the string.
    expect(() => JSON.parse(JSON.stringify(fitted, null, 2))).not.toThrow()
    expect(size(fitted)).toBeLessThanOrEqual(5_000)
    // Whole rows, never half of one.
    const rows = fitted.rows as { i: number }[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(500)
    for (const row of rows) expect(Object.keys(row)).toEqual(['i', 'label', 'value'])
    expect(fitted.meta).toBe('x')
  })

  it('carries a machine-readable truncation signal inside the document', () => {
    const doc = { rows: Array.from({ length: 400 }, (_, i) => ({ i, pad: 'x'.repeat(40) })) }
    const fitted = fitJson(doc, 3_000) as Record<string, unknown>
    const marker = fitted[JSON_TRUNCATION_KEY] as { truncated: boolean; droppedRecords: { path: string; dropped: number }[] }
    expect(marker.truncated).toBe(true)
    expect(marker.droppedRecords.some(r => r.path === 'rows' && r.dropped > 0)).toBe(true)
  })

  it('never mutates the caller\'s document, which may be a cached upstream body', () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ i, pad: 'y'.repeat(40) }))
    const doc = { rows }
    fitJson(doc, 2_000)
    expect(rows).toHaveLength(300)
  })

  it('falls back to the marker alone rather than to something that will not parse', () => {
    // No arrays to trim and one enormous string: there is nothing to shorten by
    // whole records, and a hard cut would leave the caller with broken JSON.
    const fitted = fitJson({ blob: 'z'.repeat(50_000) }, 500) as Record<string, unknown>
    expect(() => JSON.parse(JSON.stringify(fitted, null, 2))).not.toThrow()
    expect(size(fitted)).toBeLessThanOrEqual(500)
    expect((fitted[JSON_TRUNCATION_KEY] as { truncated: boolean }).truncated).toBe(true)
  })
})

/* ============ symbols are not unique ============ */

describe('assetPairLabels', () => {
  it('prints the ids when two legs share a symbol, and only then', () => {
    const a = { assetId: 22, symbol: 'USDC', decimals: 6 }
    const b = { assetId: 1000766, symbol: 'USDC', decimals: 6 }
    // `USDC → USDC` for two different registry assets reads as a no-op.
    expect(assetPairLabels(a, b)).toEqual(['USDC (#22)', 'USDC (#1000766)'])
    const dot = { assetId: 5, symbol: 'DOT', decimals: 10 }
    expect(assetPairLabels(a, dot)).toEqual(['USDC', 'DOT'])
    // The same asset on both sides is not a collision.
    expect(assetPairLabels(a, a)).toEqual(['USDC', 'USDC'])
  })
})

/* ============ the genesis timestamp ============ */

describe('the unix epoch is an absence, not a date', () => {
  it('refuses to render the genesis placeholder as a moment in 1970', () => {
    // The explorer answers "1970-01-01 00:00:00" for block 0, which has no
    // timestamp. Printed literally it reads as a real date 56 years ago.
    expect(isUnrecordedTime('1970-01-01 00:00:00')).toBe(true)
    expect(formatTime('1970-01-01 00:00:00')).toBe('—')
    expect(relativeAge('1970-01-01 00:00:00', NOW)).toBe('—')
    // A real chain timestamp is unaffected.
    expect(isUnrecordedTime('2026-09-18 10:07:42')).toBe(false)
    expect(formatTime('2026-09-18 10:07:42')).toBe('2026-09-18 10:07:42 UTC')
  })
})

/* ============ exact integers ============ */

describe('formatCount', () => {
  it('spells a count or a block height in full, because neither is a magnitude', () => {
    expect(formatCount(14_744_614)).toBe('14,744,614')
    expect(formatCount(994_520)).toBe('994,520')
    expect(formatCount(0)).toBe('0')
    expect(formatCount(null)).toBe('—')
    expect(formatCount(Number.NaN)).toBe('—')
  })
})

/* ============ real rows ============ */

/*
 * The other half of the feed.
 *
 * `mm`, `staking`, `bond`, `intent`, `otc` and `xcswap` are six of the twelve
 * row types, and each has its own label map and its own slug rule. Without a
 * row apiece, replacing any of those branches with a constant changes no test:
 * that was measured, not assumed. They are minimal by design — the labelling
 * and the link are what varies per type; the scaling and address rendering are
 * already pinned by the rows above.
 */
const ACTOR = SWAP.who

const MM_LIQUIDATION: ActivityRow = {
  type: 'mm', blockHeight: 14_742_100, timestamp: '2026-09-18 09:20:00',
  eventIndex: 31, extrinsicIndex: 4, who: ACTOR, to: null,
  asset: { assetId: 10, symbol: 'USDT', name: null, decimals: 6, parachainId: null, origin: null },
  assetIn: null, assetOut: null, amount: '250000000', valueUsd: 250,
  mmAction: 'LiquidationCall', linkBlock: 14_742_100, linkIndex: 4,
} as ActivityRow

const STAKING_CLAIM: ActivityRow = {
  type: 'staking', blockHeight: 14_742_200, timestamp: '2026-09-18 09:21:00',
  eventIndex: 7, extrinsicIndex: 1, who: ACTOR, to: null,
  asset: { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: null, origin: null },
  assetIn: null, assetOut: null, amount: '51600000000000000', valueUsd: 4_031.7,
  stakingAction: 'Claim', linkBlock: 14_742_200, linkIndex: 1,
} as ActivityRow

const BOND_REDEEM: ActivityRow = {
  type: 'bond', blockHeight: 14_742_300, timestamp: '2026-09-18 09:22:00',
  eventIndex: 12, extrinsicIndex: 3, who: ACTOR, to: null,
  asset: { assetId: 1_000_060, symbol: 'DOT Bond', name: null, decimals: 10, parachainId: null, origin: null },
  assetIn: null, assetOut: null, amount: '44000000000000', valueUsd: 5_128,
  bondAction: 'Redeem', linkBlock: 14_742_300, linkIndex: 3,
} as ActivityRow

const INTENT_PARTIAL_FILL: ActivityRow = {
  type: 'intent', blockHeight: 14_742_400, timestamp: '2026-09-18 09:23:00',
  eventIndex: 20, extrinsicIndex: 2, who: ACTOR, to: null,
  assetIn: { assetId: 10, symbol: 'USDT', name: null, decimals: 6, parachainId: null, origin: null },
  assetOut: { assetId: 5, symbol: 'DOT', name: null, decimals: 10, parachainId: null, origin: null },
  asset: null, amount: null, amountIn: '60200000', amountOut: '515000000000', valueUsd: 60.2,
  intentKind: 'swap', intentAction: 'PartialFill', linkBlock: 14_742_400, linkIndex: 2,
} as ActivityRow

const OTC_PULL: ActivityRow = {
  type: 'otc', blockHeight: 14_742_500, timestamp: '2026-09-18 09:24:00',
  eventIndex: 9, extrinsicIndex: 1, who: ACTOR, to: null,
  asset: { assetId: 5, symbol: 'DOT', name: null, decimals: 10, parachainId: null, origin: null },
  assetIn: null, assetOut: null, amount: '44000000000000', valueUsd: 5_128,
  otcAction: 'Pull', linkBlock: 14_742_500, linkIndex: 1,
} as ActivityRow

const XCSWAP_SENT: ActivityRow = {
  type: 'xcswap', blockHeight: 14_742_600, timestamp: '2026-09-18 09:25:00',
  eventIndex: 18, extrinsicIndex: 2, who: ACTOR, to: null,
  assetIn: { assetId: 10, symbol: 'USDT', name: null, decimals: 6, parachainId: null, origin: null },
  // The destination is NOT a registry asset: it travels as its own symbol,
  // amount and decimals, so assetOut/amountOut stay null and the out leg comes
  // from the xcswapDest* fields instead.
  assetOut: null, asset: null, amount: null, amountIn: '100000000', amountOut: null,
  xcswapDestSymbol: 'SOL', xcswapDestAmount: '921000000', xcswapDestDecimals: 9,
  xcswapRecipient: '5jbsKQxSs6bZTcLqFJeKcSYhCH9JQvHRbGdaUZmcwyRgVGKt',
  valueUsd: 100, linkBlock: 14_742_600, linkIndex: 2,
} as ActivityRow

const ALL_FIXTURES: [string, ActivityRow][] = [
  ['swap', SWAP], ['dca', DCA_EXECUTION], ['transfer', TRANSFER], ['vote', VOTE],
  ['xcm', XCM_OUT], ['liquidity', LIQUIDITY_ADD], ['unconfirmed', UNCONFIRMED_SWAP],
  ['mm', MM_LIQUIDATION], ['staking', STAKING_CLAIM], ['bond', BOND_REDEEM],
  ['intent', INTENT_PARTIAL_FILL], ['otc', OTC_PULL], ['xcswap', XCSWAP_SENT],
]

describe('activityLine over real rows', () => {
  it('renders a swap with both legs scaled by their own decimals', () => {
    const line = activityLine(SWAP, BASE, NOW)
    expect(line).toContain('Swap')
    // USDT has 6 decimals, LINK 18 — one page of this feed mixes both.
    expect(line).toContain('60.2 USDT → 5.06 LINK')
    expect(line).toContain('$60.2')
    expect(line).toContain(`${BASE}/swap/14743749-e46`)
    expect(line).toContain('🌻 13b6hR…p3hMN')
  })

  it('says a DCA execution is one, names its schedule, and links the schedule', () => {
    const line = activityLine(DCA_EXECUTION, BASE, NOW)
    expect(line).toContain('DCA execution')
    expect(line).toContain('schedule #30104')
    // The hub asset is H2O everywhere; LRNA is its legacy name.
    expect(line).toContain('1.04 H2O → 774 HDX')
    expect(line).not.toContain('LRNA')
    // A DCA row links to its standing order, not to one fill.
    expect(activityUrlFor(DCA_EXECUTION, BASE)).toBe(`${BASE}/dca/30104`)
    expect(activitySlug(DCA_EXECUTION)).toBe('dca')
  })

  it('renders a transfer with both parties', () => {
    const line = activityLine(TRANSFER, BASE, NOW)
    expect(line).toContain('Transfer')
    expect(line).toContain('🐕 15YGfc…vu5ue → 🦕 1Cwy9w…8su6M')
    expect(line).toContain('4.4k DOT')
    expect(line).toContain('$5.13k')
    expect(line).toContain(`${BASE}/transfer/14744261-e6`)
  })

  it('renders a vote with its referendum, side and conviction', () => {
    const line = activityLine(VOTE, BASE, NOW)
    expect(line).toContain('Aye on opengov #410')
    expect(line).toContain('Locked3x')
    expect(line).toContain('Reduce Omnipool weight cap')
    expect(line).toContain('51.6k HDX')
    expect(line).toContain(`${BASE}/vote/14744595-e7`)
  })

  it('renders a cross-chain row with its direction and destination chain', () => {
    const line = activityLine(XCM_OUT, BASE, NOW)
    expect(line).toContain('out to Bifrost')
    expect(line).toContain('4.4k DOT')
    expect(activitySlug(XCM_OUT)).toBe('cross-chain')
    // The destination account keys on its canonical accountId, never on a bare H160.
    expect(line).not.toContain('0x091cbd')
  })

  it('renders a liquidity row with its action and pool', () => {
    const line = activityLine(LIQUIDITY_ADD, BASE, NOW)
    expect(line).toContain('Add liquidity')
    expect(line).toContain('pool 2-Pool-GDOT')
    expect(line).toContain('99.9 2-Pool-GDOT')
    expect(activitySlug(LIQUIDITY_ADD)).toBe('add-liquidity')
    expect(activityUrlFor(LIQUIDITY_ADD, BASE)).toBe(`${BASE}/add-liquidity/14742679-e16`)
  })

  it('marks an unconfirmed row and never presents it as settled', () => {
    expect(isUnconfirmed(UNCONFIRMED_SWAP)).toBe(true)
    const line = activityLine(UNCONFIRMED_SWAP, BASE, NOW)
    expect(line).toContain('**unconfirmed**')
    expect(isUnconfirmed(SWAP)).toBe(false)
    expect(activityLine(SWAP, BASE, NOW)).not.toContain('unconfirmed')
  })

  it('never prints a mempool row’s placeholder block height as real', () => {
    // A pool transaction has no block yet: blockHeight/index are 0 placeholders
    // and the row is addressed by its hash.
    const pending: ActivityRow = {
      ...UNCONFIRMED_SWAP,
      mempool: true, finalized: false, blockHeight: 0, eventIndex: null, extrinsicIndex: null,
      linkBlock: null, linkIndex: null,
      hash: '0xdc773062b3cee9f8c89da28610cf091c80c0da0f0ce5457f762d1b6db75453f9',
    }
    const line = activityLine(pending, BASE, NOW)
    expect(line).toContain('**unconfirmed**')
    expect(line).not.toContain('/block/0')
    expect(line).not.toContain('-e0')
    expect(activityUrlFor(pending, BASE)).toBe(`${BASE}/extrinsic/${pending.hash}`)
    // The detail form omits the height rather than asserting block zero.
    expect(activityDetail(pending, BASE, { now: NOW })).not.toContain('**Block:**')
  })

  // One case per remaining family. Each pins the label AND the slug, because the
  // two are separate maps in activity.ts and a wrong slug is a link to a page
  // that does not exist — silent, and only visible to whoever clicks it.
  it('names and links the money-market, staking and bond families', () => {
    expect(activityKind(MM_LIQUIDATION)).toBe('Liquidate')
    expect(activitySlug(MM_LIQUIDATION)).toBe('liquidate')
    expect(activityUrlFor(MM_LIQUIDATION, BASE)).toBe(`${BASE}/liquidate/14742100-e31`)
    expect(activityLine(MM_LIQUIDATION, BASE, NOW)).toContain('250 USDT')

    // 'Supply' is called Lend in product copy, and its slug differs from its label.
    expect(activityKind({ ...MM_LIQUIDATION, mmAction: 'Supply' })).toBe('Lend')
    expect(activitySlug({ ...MM_LIQUIDATION, mmAction: 'Supply' })).toBe('lend')
    // An action the maps do not know is reported as itself, never as a default.
    expect(activityKind({ ...MM_LIQUIDATION, mmAction: 'Borrow' })).toBe('Borrow')
    expect(activitySlug({ ...MM_LIQUIDATION, mmAction: 'Borrow' })).toBe('borrow')

    expect(activityKind(STAKING_CLAIM)).toBe('Claim')
    expect(activitySlug(STAKING_CLAIM)).toBe('staking')
    expect(activityLine(STAKING_CLAIM, BASE, NOW)).toContain('51.6k HDX')

    expect(activityKind(BOND_REDEEM)).toBe('Bond redeem')
    expect(activitySlug(BOND_REDEEM)).toBe('bond-redeem')
    expect(activityKind({ ...BOND_REDEEM, bondAction: 'Issue' })).toBe('Bond issue')
    expect(activitySlug({ ...BOND_REDEEM, bondAction: 'Issue' })).toBe('bond-issue')
  })

  it('names and links the intent, OTC and cross-chain-swap families', () => {
    // A partial fill IS a fill: the wording distinguishes them, the slug does not.
    expect(activityKind(INTENT_PARTIAL_FILL)).toBe('Limit order partially filled')
    expect(activitySlug(INTENT_PARTIAL_FILL)).toBe('intent-fill')
    expect(activitySlug({ ...INTENT_PARTIAL_FILL, intentAction: 'Fill' })).toBe('intent-fill')
    expect(activitySlug({ ...INTENT_PARTIAL_FILL, intentAction: 'Cancel' })).toBe('intent-cancel')
    expect(activityKind({ ...INTENT_PARTIAL_FILL, intentKind: 'dca', intentAction: 'DcaTrade' })).toBe('DCA intent trade')
    expect(activityLine(INTENT_PARTIAL_FILL, BASE, NOW)).toContain('60.2 USDT → 51.5 DOT')

    // Product copy calls an OTC cancellation a Pull, and the slug follows it.
    expect(activityKind(OTC_PULL)).toBe('OTC pull')
    expect(activitySlug(OTC_PULL)).toBe('otc-pull')
    expect(activitySlug({ ...OTC_PULL, otcAction: 'Fill' })).toBe('otc-fill')
    expect(activitySlug({ ...OTC_PULL, otcAction: 'Place' })).toBe('otc-place')

    // The action is a swap in every state — it is a swap the moment it is placed.
    // The guarantee that an unsettled order is never read as a completed one is
    // kept by the LINE, which always states the delivery outcome (asserted
    // below); calling an unsettled order a completed swap is the one reading of
    // this family an agent must not be given.
    expect(activityKind(XCSWAP_SENT)).toBe('Cross-chain swap')
    expect(activityKind({ ...XCSWAP_SENT, xcswapStatus: 'SUCCESS' })).toBe('Cross-chain swap')
    expect(activityKind({ ...XCSWAP_SENT, xcswapStatus: 'REFUNDED' })).toBe('Cross-chain swap refunded')
    expect(activityKind({ ...XCSWAP_SENT, xcswapStatus: 'FAILED' })).toBe('Cross-chain swap failed')
    // The out leg is built from xcswapDest*, not from an assetOut that is not
    // there, and the foreign recipient is elided rather than printed whole.
    const line = activityLine(XCSWAP_SENT, BASE, NOW)
    // A row with no settlement record at all still says it has not been
    // delivered — the state a freshly placed order is in.
    expect(line).toContain('NOT yet delivered')
    expect(activityLine({ ...XCSWAP_SENT, xcswapStatus: 'PENDING_DEPOSIT' }, BASE, NOW)).toContain('NOT yet delivered')
    expect(activityLine({ ...XCSWAP_SENT, xcswapStatus: 'SUCCESS' }, BASE, NOW)).toContain('destination success')
    expect(line).toContain('100 USDT → 0.921 SOL')
    expect(line).not.toContain('5jbsKQxSs6bZTcLqFJeKcSYhCH9JQvHRbGdaUZmcwyRgVGKt')
    expect(line).toContain('→ 5jbsKQ')
  })

  it('leaks no raw integer amount and no AccountId32 hex into any line', () => {
    for (const [name, row] of ALL_FIXTURES) {
      const line = activityLine(row, BASE, NOW)
      for (const raw of [row.amount, row.amountIn, row.amountOut]) {
        // Anything long enough to be a raw planck figure must not survive.
        if (raw && raw.length > 6) expect(line, name).not.toContain(raw)
      }
      for (const account of [row.who, row.to]) {
        if (account) expect(line, name).not.toContain(account.accountId)
      }
      // Every line ends in a page a human can open.
      expect(line, name).toContain(`](${BASE}/`)
    }
  })
})

describe('activityDetail', () => {
  it('spreads a row out and attributes its revenue', () => {
    const out = activityDetail(SWAP, BASE, { now: NOW })
    expect(out).toContain('**Action:** Swap')
    expect(out).toContain('**Status:** finalized')
    expect(out).toContain('**Time:** 2026-09-18 10:07:42 UTC')
    expect(out).toContain('**Block:** 14,743,749')
    expect(out).toContain('**Amounts:** 60.2 USDT → 5.06 LINK')
    expect(out).toContain('**Protocol revenue:** $0.142')
    expect(out).toContain('omnipool_asset_fee')
  })

  it('never reads an absent revenue figure as "earned nothing"', () => {
    expect(LIQUIDITY_ADD.revenue).toBeUndefined()
    const out = activityDetail(LIQUIDITY_ADD, BASE, { now: NOW })
    expect(out).not.toContain('**Revenue**')
    expect(out).toContain('not shown')
  })

  it('distinguishes revenue booked on another row of the extrinsic from revenue not booked at all', () => {
    // The explorer attaches an extrinsic's revenue to exactly ONE of its rows —
    // the earliest — so a sibling row carrying none is attribution, not a gap in
    // the model. Reported as "not booked yet" it would claim the block is above
    // the revenue watermark, which is a statement about the whole block.
    const earner: ActivityRow = { ...SWAP, eventIndex: 64 }
    const sibling: ActivityRow = { ...SWAP, eventIndex: 116, revenue: undefined }
    const attributed = activityDetail(sibling, BASE, { now: NOW, extrinsicRows: [earner, sibling] })
    expect(attributed).toContain('booked on ANOTHER row')
    expect(attributed).toContain('double-count')
    expect(attributed).not.toContain('not booked for this block yet')

    // With no sibling carrying an attribution the block really is unbooked.
    const unbooked = activityDetail(sibling, BASE, { now: NOW, extrinsicRows: [sibling] })
    expect(unbooked).toContain('not booked for this block yet')
    expect(unbooked).not.toContain('booked on ANOTHER row')

    // And with no siblings loaded at all, neither claim may be made.
    const unknown = activityDetail(sibling, BASE, { now: NOW })
    expect(unknown).toContain('cannot say which')
  })

  it('itemises what an outbound cross-chain send cost beyond its payload', () => {
    const out = activityDetail(XCM_OUT, BASE, { now: NOW })
    expect(out).toContain('Cross-chain costs')
    expect(out).toContain('delivery fee 0.584 HDX')
  })
})
