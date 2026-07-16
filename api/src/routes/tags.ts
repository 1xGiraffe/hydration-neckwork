import type { FastifyInstance } from 'fastify'
import { allTags } from '../services/tagService.ts'
import { polkadotAddress } from '../services/addressIdentity.ts'

// Read-only tag endpoints. Tags are a fixed, code-defined set seeded on startup
// (see tagService.seedDefaultTags); there is intentionally no create/edit/delete API.
export async function tagRoutes(fastify: FastifyInstance) {
  fastify.get('/explorer/tags', async () =>
    allTags().map(t => ({
      tagId: t.tagId, name: t.name, color: t.color, note: t.note, icon: t.icon,
      members: t.members.map(accountId => ({ accountId, address: polkadotAddress(accountId) })),
    })))
}
