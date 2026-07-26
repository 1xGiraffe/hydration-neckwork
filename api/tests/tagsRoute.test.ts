import { describe, expect, it, vi } from 'vitest'

// The tag directory is a size-ranked list, not a membership dump: enumerating
// every member turned a ~3 kB response into ~132 kB of barely-compressible
// addresses. Members stay on `/explorer/tag/:id`.
async function tagsResponse(tags: { tagId: string; members: string[] }[]) {
  vi.resetModules()
  vi.doMock('../src/services/tagService.ts', () => ({
    allTags: () => tags.map(t => ({ name: t.tagId, color: '#fff', note: '', icon: '', ...t })),
  }))
  const { default: Fastify } = await import('fastify')
  const { tagRoutes } = await import('../src/routes/tags.ts')
  const app = Fastify()
  await app.register(tagRoutes)
  const response = await app.inject('/explorer/tags')
  await app.close()
  vi.doUnmock('../src/services/tagService.ts')
  return response
}

describe('/explorer/tags', () => {
  it('reports member counts and never the member list', async () => {
    const response = await tagsResponse([
      { tagId: 'xyk-pools', members: Array.from({ length: 729 }, (_, i) => `0x${String(i).padStart(64, '0')}`) },
      { tagId: 'omnipool', members: ['0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000'] },
      { tagId: 'empty', members: [] },
    ])

    expect(response.statusCode).toBe(200)
    const body = response.json() as { tagId: string; memberCount: number }[]
    expect(body.map(t => [t.tagId, t.memberCount])).toEqual([['xyk-pools', 729], ['omnipool', 1], ['empty', 0]])
    expect(body.every(t => !('members' in t))).toBe(true)
  })

  it('grows only by the digits of the count, not by membership', async () => {
    const big = (n: number) => Array.from({ length: n }, (_, i) => `0x${String(i).padStart(64, '0')}`)
    const small = await tagsResponse([{ tagId: 'a', members: big(10) }])
    const large = await tagsResponse([{ tagId: 'a', members: big(10_000) }])
    expect(large.body.length - small.body.length).toBe('10000'.length - '10'.length)
  })
})
