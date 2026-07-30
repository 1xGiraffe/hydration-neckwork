import type { FastifyInstance } from 'fastify'
import { allTags } from '../services/tagService.ts'

// Read-only tag endpoints. Tags are a fixed, code-defined set seeded on startup
// (see tagService.seedDefaultTags); there is intentionally no create/edit/delete API.
export async function tagRoutes(fastify: FastifyInstance) {
  // The directory only ranks tags by size, so send the size. Enumerating the
  // members instead meant ~900 high-entropy address pairs — 128 kB of the
  // 132 kB response, and barely compressible — to render a column of counts.
  // The per-tag page (`/explorer/tag/:id`) is where members are listed.
  fastify.get('/explorer/tags', async () =>
    allTags().map(t => ({
      tagId: t.tagId, name: t.name, color: t.color, note: t.note, icon: t.icon,
      memberCount: t.members.length,
    })))
}
