import { describe, it, expect, beforeEach } from 'vitest'
import { tagDisplayIcon } from '../src/services/userLibraryService.ts'
import { accountIcon } from '../src/services/omniwatchIdentity.ts'
import { initUserProfileService, setProfileAvatar, clearProfileAvatar } from '../src/services/userProfileService.ts'
import { fakeClient } from './helpers/userFakes.ts'

// tagDisplayIcon is the small pure helper behind B2: mirrors tagService.ts's
// iconFor (SYSTEM tags) for user tags, plus one extra precedence step user
// tags get that system tags don't — a member's own uploaded profile avatar,
// since a user-curated library is far more likely to hold another explorer
// user's account than a system tag is.
const M1 = '0x' + '11'.repeat(32)
const M2 = '0x' + '22'.repeat(32)
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])

describe('tagDisplayIcon', () => {
  it('keeps an explicit icon regardless of members', () => {
    expect(tagDisplayIcon('🔥', [])).toBe('🔥')
    expect(tagDisplayIcon('🔥', [M1])).toBe('🔥')
  })

  it('falls back to the tag glyph when unset with no members', () => {
    expect(tagDisplayIcon('', [])).toBe('🏷️')
  })

  it('derives from the FIRST member (order[0]), not any other member', () => {
    expect(tagDisplayIcon('', [M1, M2])).toBe(accountIcon(M1).emojiUrl || accountIcon(M1).emoji)
    expect(tagDisplayIcon('', [M2, M1])).toBe(accountIcon(M2).emojiUrl || accountIcon(M2).emoji)
  })

  describe('profile avatar precedence', () => {
    beforeEach(() => { initUserProfileService(fakeClient()) })

    it('prefers a first member\'s uploaded avatar over their omniwatch emoji', async () => {
      const profile = await setProfileAvatar(M1, PNG.toString('base64'))
      expect(tagDisplayIcon('', [M1, M2])).toBe(`/api/explorer/profile-avatar/${M1}?v=${profile.avatarVersion}`)
    })

    it('falls through to the omniwatch emoji once the avatar is cleared', async () => {
      await setProfileAvatar(M1, PNG.toString('base64'))
      await clearProfileAvatar(M1)
      expect(tagDisplayIcon('', [M1, M2])).toBe(accountIcon(M1).emojiUrl || accountIcon(M1).emoji)
    })

    it('an explicit icon still wins over a member\'s avatar', async () => {
      await setProfileAvatar(M1, PNG.toString('base64'))
      expect(tagDisplayIcon('👀', [M1])).toBe('👀')
    })
  })
})
