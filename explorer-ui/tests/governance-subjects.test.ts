import { describe, expect, it } from 'vitest'
import { forumPostPath, subjectFromParts, subjectPostId } from '../src/governanceSubjects'
import { parseRoute } from '../src/router'

// Every post-id shape the forum store actually holds, sampled from the live api
// (/explorer/forum/discussions?kind=… and the referendum ids) on 2026-11-08: each
// must map to a page, and that page's route must read back to the same post id.
const REAL_IDS = [
  's329', 's248',
  'opengov:450', 'opengov:0', 'democracy:0', 'democracy:207',
  'democracy_proposal:9', 'democracy_proposal:0',
  'external:0x397b09f01b9c299a164b4d164aecb4a460e917f7c8c1e2074d1d453f090bfaa5@6820789',
  'council:250', 'council:100',
  'tc:425', 'tc:10',
  'tc:0x6a209d2f6f90b50a234a84395cacfc57ff0d7854a2a83f0c988fa3b6a88c023d@1839287',
  'treasury:31', 'treasury:0',
  'spend:6', 'spend:0',
  'tip:0x0efd368890dc84b19d4a7eb5c09724a7e03e14b4123653ef9be67df0b8dfdc05@6327088',
]

describe('forum post ids → pages', () => {
  it('gives every real id a page that routes back to it', () => {
    for (const id of REAL_IDS) {
      const path = forumPostPath(id)
      expect(path, id).not.toBeNull()
      const route = parseRoute(path!)
      expect(route.name, `${id} → ${path}`).not.toBe('notfound')
      if (route.name === 'governanceSubject') expect(subjectPostId(route.subject, route.id), path!).toBe(id)
      if (route.name === 'discussion') expect(route.id).toBe(id)
      if (route.name === 'referendum') expect(`${route.pallet}:${route.index}`).toBe(id)
    }
  })

  it('reads the archive routes, and refuses an id of the wrong shape', () => {
    expect(subjectFromParts(['governance', 'motion', 'tc', '425'])?.subject.kind).toBe('tc')
    expect(subjectFromParts(['governance', 'tip', '425'])).toBeNull()
    expect(forumPostPath('nonsense:x')).toBeNull()
  })
})
