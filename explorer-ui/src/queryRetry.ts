import { ApiError } from './api/explorer'

// A 4xx is the server's verdict on this exact request, so retrying only makes the user
// wait for the same answer: a deep-page 400 sat on skeleton rows for ~12s before the
// error row appeared. Server errors and transport failures are still worth a retry.
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false
  return failureCount < 2
}
