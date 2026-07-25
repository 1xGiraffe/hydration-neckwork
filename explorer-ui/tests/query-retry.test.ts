import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/api/explorer'
import { shouldRetryQuery } from '../src/queryRetry'

// A 4xx is the server's verdict, not a blip. Retrying a deep-page 400 twice left the
// activity table on skeleton rows for ~12s before the honest error surfaced.
describe('shouldRetryQuery', () => {
  it('never retries a client error', () => {
    for (const status of [400, 401, 404, 422]) {
      expect(shouldRetryQuery(0, new ApiError(status, 'nope')), String(status)).toBe(false)
    }
  })

  it('still retries server errors and transport failures', () => {
    expect(shouldRetryQuery(0, new ApiError(500, 'boom'))).toBe(true)
    expect(shouldRetryQuery(0, new ApiError(503, 'boom'))).toBe(true)
    expect(shouldRetryQuery(0, new TypeError('network down'))).toBe(true)
  })

  it('still gives up after two attempts', () => {
    expect(shouldRetryQuery(1, new ApiError(500, 'boom'))).toBe(true)
    expect(shouldRetryQuery(2, new ApiError(500, 'boom'))).toBe(false)
  })
})
