import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, userApi } from '../src/api/explorer'
import { PAGE_SIZE } from '../src/utils/activityPaging'

// What the activity feeds actually put on the wire. Two invariants live here, and
// both are invisible from the rendered page: a page size that disagrees with the
// pager's step silently repeats rows, and a filter the page shows but never sends
// returns rows the reader's own query string says are excluded.

function captureUrls(): string[] {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn((url: string | URL | Request) => {
    urls.push(String(url))
    return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
  }))
  return urls
}

const limitOf = (url: string) => new URL(url, 'http://x').searchParams.get('limit')
const paramOf = (url: string, key: string) => new URL(url, 'http://x').searchParams.get(key)

describe('the account/tag activity feeds page in PAGE_SIZE-sized steps', () => {
  afterEach(() => vi.unstubAllGlobals())

  // The hooks let the client default decide the page size, and a signed-in reader
  // is served by the /user twin. A twin that answered with a bigger page than the
  // pager steps by repeated rows 25-39 on page 2 and dropped the › arrow (the arrow
  // compares rows-on-page against PAGE_SIZE), for authed viewers only.
  it('asks both the public and the viewer endpoint for exactly one pager page', async () => {
    const urls = captureUrls()

    await api.accountActivity('15abc')
    await userApi.accountActivity('15abc')
    await api.tagActivity('tag-1')
    await userApi.tagActivity('tag-1')

    expect(urls).toHaveLength(4)
    for (const url of urls) expect(limitOf(url), url).toBe(String(PAGE_SIZE))
  })

  it('keeps the list-tag twin on the same page size', async () => {
    const urls = captureUrls()

    await userApi.listTagActivity('list-1', 'tag-1')

    expect(limitOf(urls[0])).toBe(String(PAGE_SIZE))
  })
})

describe('the asset-pinned activity feed sends every filter its page shows', () => {
  afterEach(() => vi.unstubAllGlobals())

  // The asset page's pager bound is fetched under the full filter set, so a filter
  // that reached only the count narrowed the pages while leaving the rows alone.
  it('carries the value floor and the protocol-revenue floor', async () => {
    const urls = captureUrls()

    await api.assetActivity(0, 'all', 0, undefined, undefined, undefined, undefined, '500', '100')

    expect(paramOf(urls[0], 'min')).toBe('500')
    expect(paramOf(urls[0], 'minRevenue')).toBe('100')
  })

  it('omits a floor that is not set rather than sending an empty one', async () => {
    const urls = captureUrls()

    await api.assetActivity(0)

    expect(paramOf(urls[0], 'min')).toBeNull()
    expect(paramOf(urls[0], 'minRevenue')).toBeNull()
  })
})
