import { describe, expect, it } from 'vitest'
import { parsePort } from '../src/config.ts'

describe('parsePort', () => {
  it('uses the default for missing or blank values', () => {
    expect(parsePort(undefined)).toBe(3000)
    expect(parsePort('  ')).toBe(3000)
  })

  it('accepts valid port numbers', () => {
    expect(parsePort('8080')).toBe(8080)
    expect(parsePort(' 443 ')).toBe(443)
  })

  it('rejects partial, fractional, and out-of-range values', () => {
    expect(() => parsePort('3000junk')).toThrow(/integer/)
    expect(() => parsePort('3.5')).toThrow(/integer/)
    expect(() => parsePort('0')).toThrow(/between/)
    expect(() => parsePort('65536')).toThrow(/between/)
  })
})
