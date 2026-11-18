import { describe, expect, it } from 'vitest'
import { IMAGE_UNAVAILABLE, localizeComments, localizeImages } from '../../src/mcp/format/forum.ts'
import type { ForumComment } from '../../src/mcp/types.ts'

// Imported forum bodies point their images at Subsquare's hosts. MCP output serves
// the re-hosted copies from our own /ipfs/<cid> (the `media` map the explorer api
// sends, built by forumRead's mediaMapFor), and never a Subsquare image link.

const BASE = 'https://explorer.example'
const SQ = 'https://subsquare.infura-ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const SQ2 = 'https://static.subsquare.io/x/y.png'

describe('forum images in MCP output', () => {
  it('maps re-hosted images to our copy and drops unmapped Subsquare images', () => {
    const media = { [SQ]: '/ipfs/bafkreiexample' }
    const body = `look ![chart](${SQ}) and ![other](${SQ2}) <img src="${SQ2}" alt="x"> raw ${SQ2} and ![ok](https://i.imgur.com/a.png)`
    const out = localizeImages(body, media, BASE)
    expect(out).toContain(`![chart](${BASE}/ipfs/bafkreiexample)`)
    expect(out).not.toMatch(/subsquare/)
    expect(out.split(IMAGE_UNAVAILABLE)).toHaveLength(4)
    expect(out).toContain('![ok](https://i.imgur.com/a.png)')
  })

  it('rewrites comments and their replies, leaving hidden ones alone', () => {
    const c = (body: string | null, replies: ForumComment[] = []): ForumComment => ({
      commentId: 'c', parentId: null, replyToId: null, author: null, body, bodyFormat: 'markdown', hidden: body == null, hiddenReason: null,
      deleted: false, createdAt: '', editedAt: null, position: null, media: {}, replies,
    })
    const [top] = localizeComments([c(`![a](${SQ})`, [c(`see ${SQ}`)]), c(null)], BASE)
    expect(top.body).toBe(IMAGE_UNAVAILABLE)
    expect(top.replies[0].body).toBe(`see ${IMAGE_UNAVAILABLE}`)
  })
})
