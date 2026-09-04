import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError } from '../src/api/explorer'
import { BLOCK_WAIT_ATTEMPTS, BLOCK_WAIT_INTERVAL_MS, detailWait, isAwaitingBlock, shouldRetryQuery } from '../src/queryRetry'
import { pendingRowsRefetchMs } from '../src/hooks/useExplorerData'
import { AwaitingBlockCard } from '../src/components/ui'
import { blockOf, parseId } from '../src/utils/activityIds'

// A detail page linked straight from a wallet asks about a block the explorer's
// finalized index does not hold yet (35-65s of finality). The server says which
// kind of miss it is; these pin the client half of that contract.
const notIndexedYet = new ApiError(404, 'Trade not found', { error: 'Trade not found', blockIndexed: false, headBound: 14_185_809 })
const noSuchRow = new ApiError(404, 'Trade not found', { error: 'Trade not found', blockIndexed: true, headBound: 14_185_800 })
const plain404 = new ApiError(404, 'Trade not found', { error: 'Trade not found' })

describe('waiting for a block instead of settling on its 404', () => {
  it('recognises only the "block not indexed yet" miss', () => {
    expect(isAwaitingBlock(notIndexedYet)).toBe(true)
    expect(isAwaitingBlock(noSuchRow)).toBe(false)
    // An API that does not describe its miss (or a hash lookup, which has no
    // block to describe) is treated as final rather than waited on blindly.
    expect(isAwaitingBlock(plain404)).toBe(false)
    expect(isAwaitingBlock(new Error('network'))).toBe(false)
  })

  it('refuses to wait for a height the chain has not produced', () => {
    // A truncated or mistyped link (14185809 → 141858090…) is not "early", and
    // `headBound` in the same body is what says so.
    expect(isAwaitingBlock(notIndexedYet, 14_185_809)).toBe(true)
    expect(isAwaitingBlock(notIndexedYet, 99_000_000)).toBe(false)
    // The head moves under an in-flight request, so a few blocks past the
    // reported bound still counts as about to exist — much further does not.
    expect(isAwaitingBlock(notIndexedYet, 14_185_815)).toBe(true)
    expect(isAwaitingBlock(notIndexedYet, 14_185_900)).toBe(false)
  })

  it('keeps asking while the block is missing, and fails fast on a bad id', () => {
    const wait = detailWait(14_185_809)
    expect(wait.retry(0, notIndexedYet)).toBe(true)
    expect(wait.retry(BLOCK_WAIT_ATTEMPTS - 1, notIndexedYet)).toBe(true)
    // Bounded: a page must not spin for minutes if the block never arrives.
    expect(wait.retry(BLOCK_WAIT_ATTEMPTS, notIndexedYet)).toBe(false)
    expect(wait.retry(0, noSuchRow)).toBe(false)
    expect(wait.retry(0, plain404)).toBe(false)
    // Beyond the chain's own head: no waiting at all.
    expect(detailWait(99_000_000).retry(0, notIndexedYet)).toBe(false)
  })

  it('leaves every other failure on the shared policy', () => {
    const server = new ApiError(500, 'boom')
    const wait = detailWait(14_185_809)
    expect(wait.retry(0, server)).toBe(shouldRetryQuery(0, server))
    expect(wait.retry(5, server)).toBe(shouldRetryQuery(5, server))
  })

  it('waits on a fixed cadence for a block, and backs off for anything else', () => {
    const wait = detailWait(14_185_809)
    expect(wait.retryDelay(0, notIndexedYet)).toBe(BLOCK_WAIT_INTERVAL_MS)
    expect(wait.retryDelay(7, notIndexedYet)).toBe(BLOCK_WAIT_INTERVAL_MS)
    expect(wait.retryDelay(0, new ApiError(500, 'boom'))).toBe(1000)
    // The waiting window must cover the measured finality tail (p90 57s).
    expect(BLOCK_WAIT_ATTEMPTS * BLOCK_WAIT_INTERVAL_MS).toBeGreaterThan(90_000)
  })

  it('says what it is waiting for', () => {
    const html = renderToStaticMarkup(<AwaitingBlockCard height={14_185_809} />)
    expect(html).toContain('Waiting for block')
    expect(html).toContain('14,185,809')
    expect(html).toContain('finalized blocks')
    expect(html).not.toContain('not found')
  })
})

describe('a list served from the pending layer keeps refetching', () => {
  it('polls while any row is unfinalized and stops once they all settle', () => {
    expect(pendingRowsRefetchMs([{ finalized: false }, {}])).toBe(2_500)
    expect(pendingRowsRefetchMs([{}, {}])).toBe(false)
    expect(pendingRowsRefetchMs([])).toBe(false)
    expect(pendingRowsRefetchMs(undefined)).toBe(false)
  })
})

describe('activity id parsing', () => {
  it('reads the block out of both id forms', () => {
    expect(blockOf('14185809-2')).toBe(14_185_809)
    expect(blockOf('14185809-e5')).toBe(14_185_809)
    expect(blockOf('nonsense')).toBeNull()
    expect(blockOf(null)).toBeNull()
  })

  it('keeps the extrinsic/event distinction the pages resolve rows by', () => {
    expect(parseId('14185809-2')).toEqual({ height: 14_185_809, eventIndex: null, extrinsicIndex: 2 })
    expect(parseId('14185809-e5')).toEqual({ height: 14_185_809, eventIndex: 5, extrinsicIndex: null })
  })
})
