import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import { userRoutes } from '../src/routes/user.ts'
import { initUserAuthService, resetUserAuthForTests, issueSession } from '../src/services/userAuthService.ts'
import { initUserListService, loadUserLists, ensurePersonalList, createTag, setTagMembers } from '../src/services/userListService.ts'
import { fakeClient } from './helpers/userFakes.ts'
import { groupHolderBalanceClaims } from '../src/services/explorerService.ts'
import type { HoldersPage, ViewerFold, AccountRef } from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// ---- route layer: gate on a session, pick exactly one entry point ----

const { getHoldersMock, getHoldersForViewerFoldMock } = vi.hoisted(() => {
  const asset = { assetId: 0, symbol: 'HDX' }
  return {
    getHoldersMock: vi.fn(async (_assetId: number, _limit: number, _offset: number): Promise<HoldersPage> => ({ asset, holders: [], total: 0, totalUsd: 0 } as unknown as HoldersPage)),
    getHoldersForViewerFoldMock: vi.fn(async (_assetId: number, _limit: number, _offset: number, _fold: ViewerFold): Promise<HoldersPage> => ({
      asset,
      holders: [{
        rank: 1, account: null, balance: '10', lastBlock: 1,
        tag: { tagId: 'tag-x', name: 'Whales', color: '#22c55e', icon: '🐳', memberCount: 2, userTagId: 'tag-x', listId: 'lib1' },
      }],
      total: 1, totalUsd: 0,
    } as unknown as HoldersPage)),
  }
})

vi.mock('../src/services/explorerService.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/explorerService.ts')>()
  return { ...actual, getHolders: getHoldersMock, getHoldersForViewerFold: getHoldersForViewerFoldMock }
})

const VIEWER = '0x' + 'aa'.repeat(32)
const MEMBER = '0x' + '11'.repeat(32)

async function build() {
  const f = Fastify()
  await f.register(userRoutes)
  return f
}

describe('GET /user/holders/:assetId', () => {
  beforeEach(async () => {
    resetUserAuthForTests()
    await initUserAuthService(fakeClient())
    initUserListService(fakeClient())
    await loadUserLists()
    getHoldersMock.mockClear()
    getHoldersForViewerFoldMock.mockClear()
  })

  it('401s an anonymous request and 400s a bad asset id', async () => {
    const f = await build()
    expect((await f.inject({ method: 'GET', url: '/user/holders/0' })).statusCode).toBe(401)
    const token = await issueSession(VIEWER)
    expect((await f.inject({ method: 'GET', url: '/user/holders/xyz', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(400)
  })

  it('stamps no-store and rejects an out-of-range offset like the public route', async () => {
    const token = await issueSession(VIEWER)
    const f = await build()
    const ok = await f.inject({ method: 'GET', url: '/user/holders/0', headers: { authorization: `Bearer ${token}` } })
    expect(ok.headers['cache-control']).toBe('no-store')
    const bad = await f.inject({ method: 'GET', url: '/user/holders/0?offset=-1', headers: { authorization: `Bearer ${token}` } })
    expect(bad.statusCode).toBe(400)
  })

  it('a tagless viewer gets the shared result — never the fold path', async () => {
    const token = await issueSession(VIEWER)
    const f = await build()
    const r = await f.inject({ method: 'GET', url: '/user/holders/0', headers: { authorization: `Bearer ${token}` } })
    expect(r.statusCode).toBe(200)
    expect(r.json().holders).toEqual([])
    expect(getHoldersMock).toHaveBeenCalledTimes(1)
    expect(getHoldersForViewerFoldMock).not.toHaveBeenCalled()
  })

  it('a tagged viewer gets the fold — assetId/limit/offset passed straight through', async () => {
    const lib = await ensurePersonalList(VIEWER)
    const tag = await createTag(VIEWER, lib.listId, { name: 'Whales', color: '#22c55e', icon: '🐳' })
    await setTagMembers(VIEWER, lib.listId, tag.tagId, [MEMBER], [])
    const token = await issueSession(VIEWER)

    const f = await build()
    const r = await f.inject({ method: 'GET', url: '/user/holders/5?offset=50&limit=25', headers: { authorization: `Bearer ${token}` } })
    expect(r.statusCode).toBe(200)
    expect(r.json().holders[0].tag.userTagId).toBe('tag-x')
    expect(getHoldersMock).not.toHaveBeenCalled()
    const [assetId, limit, offset, fold] = getHoldersForViewerFoldMock.mock.calls[0]
    expect([assetId, limit, offset]).toEqual([5, 25, 50])
    expect(fold.ids).toEqual([MEMBER])
    expect(fold.keys).toEqual([`u:${tag.tagId}`])
  })
})

// ---- TS-side grouping: a fold-substituted tag collapses members exactly once ----

describe('groupHolderBalanceClaims under a viewer fold refFor', () => {
  const plainRef = (accountId: string): AccountRef => ({
    accountId, address: accountId, emoji: '', tag: null, identity: null, profile: null,
  } as unknown as AccountRef)

  it('collapses fold-tagged members into one summed row and leaves others individual', () => {
    const A = '0x' + '11'.repeat(32), B = '0x' + '22'.repeat(32), C = '0x' + '33'.repeat(32)
    const foldTag = { id: 'user-tag-1', name: 'Mine', color: '#fff', icon: '⭐', memberCount: 2 }
    const refFor = (accountId: string): AccountRef =>
      accountId === A || accountId === B ? { ...plainRef(accountId), tag: foldTag } : plainRef(accountId)

    const rows = groupHolderBalanceClaims([
      { accountId: A, bal: 60n, lastBlock: 10 },
      { accountId: B, bal: 40n, lastBlock: 20 },
      { accountId: C, bal: 70n, lastBlock: 5 },
    ], refFor)

    expect(rows).toHaveLength(2)
    // 60+40 = 100 outranks 70; balance stays an exact integer sum.
    expect(rows[0].tag).toMatchObject({ tagId: 'user-tag-1', name: 'Mine', memberCount: 2 })
    expect(rows[0].account).toBeNull()
    expect(rows[0].balance).toBe('100')
    expect(rows[0].lastBlock).toBe(20)
    expect(rows[1].account?.accountId).toBe(C)
    expect(rows[1].tag).toBeNull()
    expect(rows.map(r => r.rank)).toEqual([1, 2])
  })
})

// ---- the anonymous SQL path cannot drift (accountsViewerFold.test.ts style) ----

describe('the holders viewer fold cannot drift the anonymous path', () => {
  function getHoldersBody(): string {
    const at = explorerService.indexOf('export async function getHolders(')
    expect(at).toBeGreaterThan(-1)
    return explorerService.slice(at, explorerService.indexOf('\n}\n', at))
  }

  it('getHolders takes viewerFold as an additive, optional 4th parameter', () => {
    expect(explorerService).toContain(
      'export async function getHolders(assetId: number, limit: number, offset = 0, viewerFold?: ViewerFold): Promise<HoldersPage> {',
    )
  })

  it('the group-key and label_id splices degrade to the exact original expressions absent a fold', () => {
    const body = getHoldersBody()
    expect(body).toContain("? `if(${foldKey} != '', ${foldKey}, if(t.label_id = '', latest.account_id, t.label_id))`\n      : `if(t.label_id = '', latest.account_id, t.label_id)`")
    expect(body).toContain("? `if(${foldKey} != '', '', t.label_id)`\n      : `t.label_id`")
    expect(body).toContain('${groupKeySql} AS group_key,')
    expect(body).toContain('${labelIdSql} AS label_id,')
    // Still the exact original grouping clause.
    expect(body).toContain('GROUP BY group_key, label_id')
  })

  it('query_params only grows when a fold is present, and the anonymous cache key is unchanged', () => {
    const body = getHoldersBody()
    expect(body).toContain("...(viewerFold ? { fold_ids: viewerFold.ids, fold_keys: viewerFold.keys } : {})")
    // The shared key every anonymous request uses, byte-identical to before;
    // per-viewer entries carry their own prefix + fingerprint.
    expect(body).toContain('`explorer:holders:${assetId}:${limit}:${offset}`')
    expect(body).toContain('`user-holders:${viewerFold.fingerprint}:${assetId}:${limit}:${offset}`')
  })

  it('all three holder paths fold symmetrically', () => {
    const body = getHoldersBody()
    // (a) plain SQL: splice; (b) folded display assets and (c) aTokens: the
    // fold rides into the TS groupers, and viewer markers are stamped after.
    expect(body).toContain('getFoldedDisplayAssetHolders(assetId, foldedShareIds, viewerFold)')
    expect(body).toContain('getATokenHolders(assetId, 1_000_000, viewerFold)')
    const marks = body.match(/markViewerHolderTags\(/g) ?? []
    expect(marks.length).toBe(2)
  })

  it('the TS groupers cache viewer-independent data, never a folded grouping', () => {
    // The cached unit must not embed refFor's output: claims/held are shared
    // across viewers, grouping runs per call.
    expect(explorerService).toContain('`explorer:atoken-held:${aTokenAssetId}`')
    expect(explorerService).toContain('`explorer:folded-display-claims:${displayAssetId}`')
    expect(explorerService).not.toContain('`explorer:atoken-holders:')
    expect(explorerService).not.toContain('`explorer:folded-display-holders:')
  })
})
