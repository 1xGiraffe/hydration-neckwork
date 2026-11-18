import { describe, expect, it } from 'vitest'
import { imageCidsOf } from '../src/services/forumWrite.ts'

// A purge must find every image the purged item showed — an upload's literal
// /ipfs/<cid>, an imported image through the sync's re-hosting map, and the banner —
// or those images stay pinned and served.
describe('the images a purged item showed', () => {
  it('resolves literal paths, mapped imported URLs and the banner', () => {
    const own = 'b' + 'a'.repeat(58)
    const rehosted = 'b' + 'c'.repeat(58)
    const bannerRehosted = 'b' + 'd'.repeat(58)
    const subsquareBanner = 'Qm' + '1'.repeat(44)
    const map = new Map([
      ['https://i.ibb.co/x/shot.png', rehosted],
      [`https://subsquare.infura-ipfs.io/ipfs/${subsquareBanner}`, bannerRehosted],
    ])
    const body = `see ![a](/ipfs/${own}) and <img src="https://i.ibb.co/x/shot.png" alt="y"> and ![b](https://nowhere/unmapped.png)`
    expect(imageCidsOf(body, map, subsquareBanner).sort()).toEqual([own, rehosted, bannerRehosted].sort())
    // A banner pinned under its own CID is that CID.
    expect(imageCidsOf('', new Map(), own)).toEqual([own])
  })
})
