import { afterEach, describe, expect, it } from 'vitest'
import {
  accountIcon,
  applySnakewatchEmojiSource,
  clearSnakewatchEmojiSourceForTest,
  hydrationAddress,
  parseSnakewatchEmojiSource,
  parseSuffixEmojiQuery,
  polkadotAddress,
  shortAccount,
} from '../src/services/omniwatchIdentity.ts'

afterEach(() => {
  clearSnakewatchEmojiSourceForTest()
})

describe('omniwatch identity helpers', () => {
  it('encodes 32-byte account ids as Polkadot SS58 addresses', () => {
    expect(polkadotAddress('0x0000000000000000000000000000000000000000000000000000000000000000'))
      .toBe('111111111111111111111111111111111HC1')
    expect(polkadotAddress('0x6d6f646c70792f74727372790000000000000000000000000000000000000000'))
      .toBe('13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB')
  })

  it('uses the SS58 address for short labels', () => {
    const address = '13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB'
    expect(shortAccount(address)).toBe('sTB')
  })

  it('honors Snakewatch custom emoji overrides where renderable', () => {
    expect(accountIcon('7Hsq5RH9xUtPWFZMGXtoVWNd4CEjpJWsidf7bcGwNwdxp9Ha')).toEqual({ emoji: '🍺' })
    expect(accountIcon('7JnnrDVoGrXA68TuQMVasG8TD8D2iagjmBA3bSEYyBHphbvy')).toEqual({ emoji: '🌴' })
  })

  it('preserves Discord custom emoji metadata until image urls are supplied', () => {
    expect(accountIcon('7MsLP8yfa4dzCAyBX5jxDk2UR7DEATQYNcfpMxgnRDWx6Xin')).toMatchObject({
      emojiName: 'buffdoge',
      emojiUrl: 'https://cdn.discordapp.com/emojis/989553819539103764.webp?size=32',
    })
    expect(accountIcon('7KATdGae91uodYHAhxuA7Re7ijGTDAFFa9ykVhUhJf9kEAR5')).toMatchObject({
      emojiName: 'HOLLAR',
      emojiUrl: 'https://cdn.discordapp.com/emojis/1419786409664970834.webp?size=32',
    })
    expect(accountIcon('7KQx4f7yU3hqZHfvDVnSfe6mpgAT8Pxyr67LXHV6nsbZo3Tm')).toMatchObject({
      emojiName: 'polkadot',
      emojiUrl: 'https://cdn.discordapp.com/emojis/1064520790978080818.webp?size=32',
    })
  })

  it('matches overrides by Hydration address while displaying Polkadot address', () => {
    const rawAccount = '0xbcf96ceba85fb928b544872bec7e62d3490a439a16b7879578708bb711791f0e'

    expect(hydrationAddress(rawAccount)).toBe('7MsLP8yfa4dzCAyBX5jxDk2UR7DEATQYNcfpMxgnRDWx6Xin')
    expect(polkadotAddress(rawAccount)).toBe('15Gn6dsGMjYCMUUxTYKTRyGhhYChhujkVMmYbuApFM4ENGfx')
    expect(accountIcon(rawAccount)).toMatchObject({
      emojiName: 'buffdoge',
      emojiUrl: 'https://cdn.discordapp.com/emojis/989553819539103764.webp?size=32',
    })
  })

  it('matches Snakewatch fallback emoji generation', () => {
    expect(accountIcon('16VM29LrX9SFma5e3aTVTdTPvnbEQjEp8xBXUVC73J8xpDAe')).toEqual({ emoji: '🐮' })
  })

  it('parses and applies maintained Snakewatch emojify source', () => {
    const source = `
      const emojis = ['🍎', '🍌'];
      const degens = {
        '7MsLP8yfa4dzCAyBX5jxDk2UR7DEATQYNcfpMxgnRDWx6Xin': '<:fresh:123456789012345678>',
        '7Hsq5RH9xUtPWFZMGXtoVWNd4CEjpJWsidf7bcGwNwdxp9Ha': '🍸',
      };
    `

    const parsed = parseSnakewatchEmojiSource(source)
    expect(parsed.emojis).toEqual(['🍎', '🍌'])
    expect(parsed.degensByHydrationAddress.size).toBe(2)

    applySnakewatchEmojiSource(source)
    expect(accountIcon('7MsLP8yfa4dzCAyBX5jxDk2UR7DEATQYNcfpMxgnRDWx6Xin')).toMatchObject({
      emojiName: 'fresh',
      emojiUrl: 'https://cdn.discordapp.com/emojis/123456789012345678.webp?size=32',
    })
    expect(accountIcon('7Hsq5RH9xUtPWFZMGXtoVWNd4CEjpJWsidf7bcGwNwdxp9Ha')).toEqual({ emoji: '🍸' })
  })
})

describe('parseSuffixEmojiQuery — combined "3-letter code + emoji name" queries', () => {
  it('parses "pmo pig" as suffix pmo + the pig glyphs', () => {
    const combos = parseSuffixEmojiQuery('pmo pig')
    expect(combos).toHaveLength(1)
    expect(combos[0].suffix).toBe('pmo')
    expect(combos[0].glyphs).toContain('🐷')
    expect(combos[0].glyphs).toContain('🐽')
  })

  it('accepts either token order', () => {
    const combos = parseSuffixEmojiQuery('pig pmo')
    expect(combos).toHaveLength(1)
    expect(combos[0].suffix).toBe('pmo')
    expect(combos[0].glyphs).toContain('🐷')
  })

  it('keeps both readings when both tokens are emoji names', () => {
    const combos = parseSuffixEmojiQuery('cat dog')
    expect(combos.map(c => c.suffix).sort()).toEqual(['cat', 'dog'])
  })

  it('rejects single tokens, 3+ tokens, and non-matching pairs', () => {
    expect(parseSuffixEmojiQuery('pig')).toEqual([])
    expect(parseSuffixEmojiQuery('a b c')).toEqual([])
    expect(parseSuffixEmojiQuery('x7K zzzzz')).toEqual([])
    expect(parseSuffixEmojiQuery('toolongcode pig')).toEqual([])
  })
})
