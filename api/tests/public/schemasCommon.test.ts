import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { z } from 'zod'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import {
  csv,
  errorEnvelope,
  iso,
  zAssetId,
  zBucket,
  zHexAddress,
  zIsoTimestamp,
  zLimitOffset,
  zPage,
  zPeriod,
} from '../../src/public/schemas/common.ts'

// The wire conventions every /v1 route composes from
// (docs/superpowers/specs/2026-08-12-public-rest-api-design.md, "Wire
// conventions"). These helpers are the shared seam for every later route group,
// so their behavior is pinned here rather than rediscovered per endpoint.
const HEX_20 = `0x${'ab'.repeat(20)}`
const HEX_32 = `0x${'cd'.repeat(32)}`

describe('zHexAddress', () => {
  it('accepts 20-byte H160 and 32-byte substrate keys', () => {
    expect(zHexAddress.parse(HEX_20)).toBe(HEX_20)
    expect(zHexAddress.parse(HEX_32)).toBe(HEX_32)
  })

  it('normalizes mixed case to the canonical lowercase form', () => {
    expect(zHexAddress.parse(HEX_20.toUpperCase().replace('0X', '0x'))).toBe(HEX_20)
    expect(zHexAddress.parse(`0x${'AbCd'.repeat(16)}`)).toBe(`0x${'abcd'.repeat(16)}`)
  })

  it('rejects other lengths, missing prefixes, SS58, and non-hex', () => {
    for (const bad of [
      `0x${'ab'.repeat(24)}`, // 24 bytes — between the two valid widths
      `0x${'ab'.repeat(19)}`,
      `0x${'ab'.repeat(21)}`,
      `0x${'ab'.repeat(31)}`,
      'ab'.repeat(20), // no 0x
      `0x${'zz'.repeat(20)}`,
      '7MSgC4huhkCcMEqEqYkbnjHnHwaLnfWY5FdCRLnvbfPnzeFP', // SS58 is never accepted
      '',
    ]) {
      expect(zHexAddress.safeParse(bad).success, `expected ${JSON.stringify(bad)} to be rejected`).toBe(false)
    }
  })

  it('stays usable in a response schema — the lowercase check must not become a transform', () => {
    // Pins the measured failure mode: fastify-type-provider-zod v7 serializes by
    // ENCODING the response schema, and a `.transform()` is unidirectional, so
    // rewriting zHexAddress with one turns every response carrying an address
    // into a 500 ("Encountered unidirectional transform during encode").
    // `.toLowerCase()` is an overwrite check, which encodes fine.
    const app = Fastify()
    app.setValidatorCompiler(validatorCompiler)
    app.setSerializerCompiler(serializerCompiler)
    app.get('/probe', { schema: { response: { 200: z.object({ account: zHexAddress }) } } }, async () => ({ account: HEX_32 }))
    return app.inject('/probe').then(async res => {
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ account: HEX_32 })
      await app.close()
    })
  })

  it('normalizes case on the way in through a request schema', async () => {
    const app = Fastify()
    app.setValidatorCompiler(validatorCompiler)
    app.setSerializerCompiler(serializerCompiler)
    app.get('/probe', {
      schema: { querystring: z.object({ account: zHexAddress }), response: { 200: z.object({ account: zHexAddress }) } },
    }, async req => ({ account: (req.query as { account: string }).account }))

    const ok = await app.inject(`/probe?account=${HEX_20.toUpperCase().replace('0X', '0x')}`)
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ account: HEX_20 })

    const bad = await app.inject('/probe?account=nope')
    expect(bad.statusCode).toBe(400)
    await app.close()
  })
})

describe('zAssetId', () => {
  it('accepts decimal id strings only', () => {
    expect(zAssetId.parse('0')).toBe('0')
    expect(zAssetId.parse('1000765')).toBe('1000765')
    for (const bad of ['', '5.0', '-1', '0x5', ' 5', '5 ', 'five']) {
      expect(zAssetId.safeParse(bad).success, `expected ${JSON.stringify(bad)} to be rejected`).toBe(false)
    }
  })
})

describe('iso and zIsoTimestamp', () => {
  it('converts ClickHouse DateTime strings as UTC', () => {
    // ClickHouse hands back a zone-less 'YYYY-MM-DD hh:mm:ss'; the session
    // timezone is asserted UTC at boot, which is what makes this correct.
    expect(iso('2026-06-24 12:00:00')).toBe('2026-06-24T12:00:00.000Z')
    expect(iso('2026-06-24 12:00:00.250')).toBe('2026-06-24T12:00:00.250Z')
  })

  it('accepts Dates, epoch millis, and already-zoned strings', () => {
    expect(iso(new Date(0))).toBe('1970-01-01T00:00:00.000Z')
    expect(iso(0)).toBe('1970-01-01T00:00:00.000Z')
    expect(iso('2026-06-24T12:00:00.000Z')).toBe('2026-06-24T12:00:00.000Z')
    // An explicit offset is respected rather than re-stamped as UTC.
    expect(iso('2026-06-24T14:00:00+02:00')).toBe('2026-06-24T12:00:00.000Z')
  })

  it('refuses to invent a timestamp it cannot parse', () => {
    expect(() => iso('not a date')).toThrow(RangeError)
    expect(() => iso('')).toThrow(RangeError)
  })

  it('emits exactly the format zIsoTimestamp validates', () => {
    expect(zIsoTimestamp.parse(iso('2026-06-24 12:00:00'))).toBe('2026-06-24T12:00:00.000Z')
    for (const bad of ['2026-06-24 12:00:00', '2026-06-24T12:00:00Z', '2026-06-24', '']) {
      expect(zIsoTimestamp.safeParse(bad).success, `expected ${JSON.stringify(bad)} to be rejected`).toBe(false)
    }
  })
})

describe('zPeriod and zBucket', () => {
  it('accept the documented enum values', () => {
    for (const period of ['1h', '24h', '7d', '30d', '1y', 'all']) expect(zPeriod.parse(period)).toBe(period)
    for (const bucket of ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']) expect(zBucket.parse(bucket)).toBe(bucket)
  })

  it('reject values outside them', () => {
    for (const bad of ['2h', '1H', '12h', 'ALL', '']) {
      expect(zPeriod.safeParse(bad).success, `period ${JSON.stringify(bad)}`).toBe(false)
    }
    for (const bad of ['2h', '3d', '1M', '']) {
      expect(zBucket.safeParse(bad).success, `bucket ${JSON.stringify(bad)}`).toBe(false)
    }
  })
})

describe('zLimitOffset', () => {
  it('defaults to the first page of 20', () => {
    expect(zLimitOffset.parse({})).toEqual({ limit: 20, offset: 0 })
  })

  it('coerces query strings to integers', () => {
    expect(zLimitOffset.parse({ limit: '200', offset: '1000000' })).toEqual({ limit: 200, offset: 1_000_000 })
  })

  it('rejects out-of-range and non-numeric paging instead of silently clamping', () => {
    // A rejected page is a 400; a clamped one would serve page 1 as if it were
    // the page asked for, which hides a consumer's paging bug.
    for (const bad of [{ limit: '201' }, { limit: '0' }, { limit: 'abc' }, { limit: '1.5' }, { offset: '1000001' }, { offset: '-1' }]) {
      expect(zLimitOffset.safeParse(bad).success, `expected ${JSON.stringify(bad)} to be rejected`).toBe(false)
    }
  })
})

describe('zPage', () => {
  it('wraps items with the total before paging', () => {
    const page = zPage(z.object({ id: zAssetId }))
    expect(page.parse({ items: [{ id: '5' }], totalCount: 42 })).toEqual({ items: [{ id: '5' }], totalCount: 42 })
    expect(page.safeParse({ items: [] }).success).toBe(false)
    expect(page.safeParse({ items: [], totalCount: -1 }).success).toBe(false)
    expect(page.safeParse({ items: [{ id: 'x' }], totalCount: 1 }).success).toBe(false)
  })
})

describe('csv', () => {
  it('splits comma lists and drops blanks', () => {
    expect(csv('5, 10,,')).toEqual(['5', '10'])
    expect(csv('supply,borrow')).toEqual(['supply', 'borrow'])
    expect(csv('5')).toEqual(['5'])
  })

  it('treats absent and empty parameters as no filter', () => {
    expect(csv(undefined)).toEqual([])
    expect(csv(null)).toEqual([])
    expect(csv('')).toEqual([])
    expect(csv(' , ')).toEqual([])
  })
})

describe('errorEnvelope', () => {
  it('is the single error shape on the surface', () => {
    expect(errorEnvelope('not_found', 'no route GET /nope')).toEqual({
      error: { code: 'not_found', message: 'no route GET /nope' },
    })
  })
})
