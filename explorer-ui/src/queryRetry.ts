import { ApiError } from './api/explorer'

// A 4xx is the server's verdict on this exact request, so retrying only makes the user
// wait for the same answer: a deep-page 400 sat on skeleton rows for ~12s before the
// error row appeared. Server errors and transport failures are still worth a retry.
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false
  return failureCount < 2
}

// One 4xx is not always the server's final verdict: a detail page addressed by
// block coordinates can be opened — from a wallet, a notification, a shared
// link — before the block reaches the index at all. `raw-live` follows the
// FINALIZED head, so that window is 35-65s wide, and settling on the first 404
// leaves the page permanently wrong until the reader reloads by hand.
//
// The API says which miss it is: a coordinate 404 carries `blockIndexed` and
// `headBound` (describeLookupMiss). `blockIndexed: false` means the block has
// not landed — keep asking. `true` means the block is there and holds no such
// row — a bad id, fail now. A body without the fields (an older API, a hash
// lookup) is treated as final, so this only waits when the server said waiting
// is the right thing.
export const BLOCK_WAIT_INTERVAL_MS = 4_000
// Long enough to cover the measured tail (finality p90 57s, max 65s) with room
// for a slow flush, short enough that a page cannot spin for minutes.
export const BLOCK_WAIT_ATTEMPTS = 30
// The head moves while a request is in flight, so a height a few blocks past
// the reported bound is still "about to exist".
const HEAD_BOUND_SLACK = 8

/**
 * True while the query's failure means "this block is not indexed yet".
 * Pass the addressed height when it is known: a height beyond anything the
 * chain has produced is a mistyped or truncated link, not an early one, and
 * must fail immediately rather than wait out the window.
 */
export function isAwaitingBlock(error: unknown, height?: number | null): boolean {
  if (!(error instanceof ApiError) || error.status !== 404) return false
  if (error.body.blockIndexed !== false) return false
  const bound = error.body.headBound
  if (height != null && bound != null && height > bound + HEAD_BOUND_SLACK) return false
  return true
}

/**
 * The waiting rule as react-query options, for every lookup addressed by block
 * coordinates. `height` is the block the page is asking about, when the hook
 * knows it (a hash lookup does not, and never gets a described miss either).
 */
export function detailWait(height?: number | null): {
  retry: (failureCount: number, error: unknown) => boolean
  retryDelay: (failureCount: number, error: unknown) => number
} {
  return {
    retry: (failureCount, error) =>
      isAwaitingBlock(error, height) ? failureCount < BLOCK_WAIT_ATTEMPTS : shouldRetryQuery(failureCount, error),
    retryDelay: (failureCount, error) =>
      isAwaitingBlock(error, height) ? BLOCK_WAIT_INTERVAL_MS : Math.min(1000 * 2 ** failureCount, 30_000),
  }
}
