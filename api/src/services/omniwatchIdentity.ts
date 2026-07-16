import { createHash } from 'node:crypto'

const EMOJIS = [
  '🐵', '🐒', '🦍', '🦧', '🐶', '🐕', '🦮', '🐕‍🦺', '🐩', '🐺', '🦊', '🦝',
  '🐱', '🐈', '🐈‍⬛', '🦁', '🐯', '🐅', '🐆', '🐴', '🐎', '🦄', '🦓', '🦌',
  '🐮', '🐂', '🐃', '🐄', '🐷', '🐖', '🐗', '🐽', '🐏', '🐑', '🐐', '🐪',
  '🐫', '🦙', '🦒', '🐘', '🦏', '🦛', '🐭', '🐁', '🐀', '🐹', '🐰', '🐇',
  '🐿', '🦔', '🦇', '🐻', '🐻‍❄️', '🐨', '🐼', '🦥', '🦦', '🦨', '🦘', '🦡',
  '🐾', '🦃', '🐔', '🐓', '🐣', '🐤', '🐥', '🐦', '🐧', '🕊', '🦅', '🦆',
  '🦢', '🦉', '🦩', '🦚', '🦜', '🐸', '🐊', '🐢', '🦎', '🐍', '🐲', '🐉',
  '🦕', '🦖', '🐬', '🐟', '🐠', '🐡', '🦈', '🐙', '🐚', '🐌', '🦋', '🐛',
  '🐜', '🐝', '🐞', '🦗', '🕷', '🦂', '🦟', '🦠', '💐', '🌸', '💮', '🏵',
  '🌹', '🥀', '🌺', '🌻', '🌼', '🌷', '🌱', '🌲', '🌳', '🌴', '🌵', '🌾',
  '🌿', '☘', '🍀', '🍁', '🍂', '🍃', '🍄',
] as const

// Spelled-out names for the deterministic emoji set (plus the custom-override
// glyphs), so an account can be found by the name the UI shows — e.g. 🍄 →
// "Mushroom", 🦈 → "Shark". Mirrors explorer-ui's EMOJI_NAMES.
const EMOJI_NAMES: Record<string, string> = {
  '🐵': 'Monkey', '🐒': 'Monkey', '🦍': 'Gorilla', '🦧': 'Orangutan', '🐶': 'Dog', '🐕': 'Dog', '🦮': 'Guide Dog', '🐕‍🦺': 'Service Dog', '🐩': 'Poodle', '🐺': 'Wolf', '🦊': 'Fox', '🦝': 'Raccoon',
  '🐱': 'Cat', '🐈': 'Cat', '🐈‍⬛': 'Black Cat', '🦁': 'Lion', '🐯': 'Tiger', '🐅': 'Tiger', '🐆': 'Leopard', '🐴': 'Horse', '🐎': 'Horse', '🦄': 'Unicorn', '🦓': 'Zebra', '🦌': 'Deer',
  '🐮': 'Cow', '🐂': 'Ox', '🐃': 'Buffalo', '🐄': 'Cow', '🐷': 'Pig', '🐖': 'Pig', '🐗': 'Boar', '🐽': 'Pig', '🐏': 'Ram', '🐑': 'Sheep', '🐐': 'Goat', '🐪': 'Camel',
  '🐫': 'Camel', '🦙': 'Llama', '🦒': 'Giraffe', '🐘': 'Elephant', '🦏': 'Rhino', '🦛': 'Hippo', '🐭': 'Mouse', '🐁': 'Mouse', '🐀': 'Rat', '🐹': 'Hamster', '🐰': 'Rabbit', '🐇': 'Rabbit',
  '🐿': 'Chipmunk', '🦔': 'Hedgehog', '🦇': 'Bat', '🐻': 'Bear', '🐻‍❄️': 'Polar Bear', '🐨': 'Koala', '🐼': 'Panda', '🦥': 'Sloth', '🦦': 'Otter', '🦨': 'Skunk', '🦘': 'Kangaroo', '🦡': 'Badger',
  '🐾': 'Paws', '🦃': 'Turkey', '🐔': 'Chicken', '🐓': 'Rooster', '🐣': 'Chick', '🐤': 'Chick', '🐥': 'Chick', '🐦': 'Bird', '🐧': 'Penguin', '🕊': 'Dove', '🦅': 'Eagle', '🦆': 'Duck',
  '🦢': 'Swan', '🦉': 'Owl', '🦩': 'Flamingo', '🦚': 'Peacock', '🦜': 'Parrot', '🐸': 'Frog', '🐊': 'Crocodile', '🐢': 'Turtle', '🦎': 'Lizard', '🐍': 'Snake', '🐲': 'Dragon', '🐉': 'Dragon',
  '🦕': 'Sauropod', '🦖': 'T-Rex', '🐬': 'Dolphin', '🐟': 'Fish', '🐠': 'Fish', '🐡': 'Pufferfish', '🦈': 'Shark', '🐙': 'Octopus', '🐚': 'Shell', '🐌': 'Snail', '🦋': 'Butterfly', '🐛': 'Bug',
  '🐜': 'Ant', '🐝': 'Bee', '🐞': 'Ladybug', '🦗': 'Cricket', '🕷': 'Spider', '🦂': 'Scorpion', '🦟': 'Mosquito', '🦠': 'Microbe', '💐': 'Bouquet', '🌸': 'Blossom', '💮': 'Flower', '🏵': 'Rosette',
  '🌹': 'Rose', '🥀': 'Wilted Rose', '🌺': 'Hibiscus', '🌻': 'Sunflower', '🌼': 'Daisy', '🌷': 'Tulip', '🌱': 'Seedling', '🌲': 'Evergreen', '🌳': 'Tree', '🌴': 'Palm Tree', '🌵': 'Cactus', '🌾': 'Rice',
  '🌿': 'Herb', '☘': 'Shamrock', '🍀': 'Clover', '🍁': 'Maple Leaf', '🍂': 'Fallen Leaf', '🍃': 'Leaf', '🍄': 'Mushroom', '🍺': 'Beer', '🏦': 'Bank',
}

// The spelled-out name for an emoji glyph (variation selectors ignored), or null.
export function emojiNameFor(emoji: string): string | null {
  return EMOJI_NAMES[emoji] ?? EMOJI_NAMES[emoji.replace(/️/g, '')] ?? null
}

// Reverse lookup for search: every emoji glyph whose spelled-out name matches the
// query (case-insensitive), ranked exact → prefix → substring — so "Mushroom"
// and "mush" both resolve to 🍄, and "dog" surfaces Dog before Guide/Service Dog.
// Substring matching needs ≥3 chars to avoid noise (e.g. "at" → Cat/Rat/Bat).
export function emojisMatchingName(query: string): string[] {
  const ql = query.trim().toLowerCase()
  if (ql.length < 2) return []
  const exact: string[] = [], prefix: string[] = [], sub: string[] = []
  for (const [emoji, name] of Object.entries(EMOJI_NAMES)) {
    const nl = name.toLowerCase()
    if (nl === ql) exact.push(emoji)
    else if (nl.startsWith(ql)) prefix.push(emoji)
    else if (ql.length >= 3 && nl.includes(ql)) sub.push(emoji)
  }
  return [...new Set([...exact, ...prefix, ...sub])]
}

// Two-token account queries combining the pill's colored 3-letter code with the
// avatar's spelled-out emoji name, in either order ("pmo pig" / "pig pmo").
// Returns every plausible (suffix, glyphs) reading — both when both tokens are
// emoji names ("cat dog") — so the search can try each against its indexes.
export function parseSuffixEmojiQuery(query: string): { suffix: string; glyphs: string[] }[] {
  const tokens = query.trim().split(/\s+/)
  if (tokens.length !== 2) return []
  const out: { suffix: string; glyphs: string[] }[] = []
  for (const [suffix, name] of [[tokens[0], tokens[1]], [tokens[1], tokens[0]]] as const) {
    if (!/^[0-9A-Za-z]{2,6}$/.test(suffix)) continue
    const glyphs = emojisMatchingName(name)
    if (glyphs.length) out.push({ suffix, glyphs })
  }
  return out
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const POLKADOT_SS58_PREFIX = 0
const HYDRATION_SS58_PREFIX = 63
const SS58_CHECKSUM_PREFIX = Buffer.from('SS58PRE')
const SNAKEWATCH_EMOJIFY_URL = 'https://raw.githubusercontent.com/galacticcouncil/snakewatch/refs/heads/main/src/utils/emojify.js'
const SNAKEWATCH_EMOJIFY_CACHE_MS = 60 * 60 * 1000

interface CustomIconOverride {
  address: string
  emoji?: string
  discordName?: string
  discordId?: string
}

export interface AccountIcon {
  emoji: string
  emojiName?: string
  emojiUrl?: string
}

interface SnakewatchEmojiSource {
  emojis: readonly string[]
  degensByHydrationAddress: Map<string, string>
}

const CUSTOM_ICON_OVERRIDES: CustomIconOverride[] = [
  { address: '7MsLP8yfa4dzCAyBX5jxDk2UR7DEATQYNcfpMxgnRDWx6Xin', discordName: 'buffdoge', discordId: '989553819539103764' },
  { address: '7Hsq5RH9xUtPWFZMGXtoVWNd4CEjpJWsidf7bcGwNwdxp9Ha', emoji: '🍺' },
  { address: '7NYZSi7PtWM6QP7p6kzYsN92gxNjikApsvstz6H9y8tjbVrZ', discordName: 'thuglife', discordId: '989554541357834261' },
  { address: '7Ljigfve9PdRqvSjiRGUjVf37rbX3n89ZmaitD2hQQhtLBMN', discordName: 'heimdall', discordId: '1005035405864869939' },
  { address: '7KZST3yphBsPdRCjUNjP1yTx8RNJaiecHsRyYTgaGHdpG1ZJ', discordName: 'kraken', discordId: '1068218238074376193' },
  { address: '7KejvRw4GZvVjFQEDefAsBRd9iaTjVeUWczB44Mgu8Bue8JW', discordName: 'Parakeet', discordId: '1074721851550466219' },
  { address: '7LU16Y84xGTMHxbKp2DDmmeSks8Zitzf1prf2P226Fs1FrWA', discordName: 'Charizard', discordId: '1074723144209809519' },
  { address: '7HcZDdrcvbjL8CeqK7J8oypnBMCfrHPTcpH6QvM2xXbRDyZt', discordName: 'bulbasaur', discordId: '1064486523715719208' },
  { address: '7MAvv6YQeXULbpNAKWceqA6voTLoioDzm71ggvWzstyPDepm', discordName: 'sir', discordId: '1069817913088946276' },
  { address: '7JnnrDVoGrXA68TuQMVasG8TD8D2iagjmBA3bSEYyBHphbvy', emoji: '🌴' },
  { address: '7LxFHadXE2giKvJsi7ybcvjriXjazAtGwBE1ptnUxLWDv4uy', emoji: '🍄' },
  { address: '7L53bUTBopuwFt3mKUfmkzgGLayYa1Yvn1hAg9v5UMrQzTfh', emoji: '🏦' },
  { address: '7LGWvFudYrVdJYxG8ekhFSpgzfN4e7BbTzTKpi3wAr1BPrsB', discordName: 'Dragonite', discordId: '1074723182944198666' },
  { address: '7Nws2zozshPbEmKXRaFch2H21PPT5jT76mckZGRd1iokfAUQ', discordName: 'Venusaur', discordId: '1074723145518432268' },
  { address: '7L1jebaeGNykbey5gZhZCD4PLVLtjPm5RKpKXRYV4NXsF6TM', emoji: '🦍' },
  { address: '7KQx4f7yU3hqZHfvDVnSfe6mpgAT8Pxyr67LXHV6nsbZo3Tm', discordName: 'polkadot', discordId: '1064520790978080818' },
  { address: '7LcF8b5GSvajXkSChhoMFcGDxF9Yn9unRDceZj1Q6NYox8HY', discordName: 'polkadot', discordId: '1064520790978080818' },
  { address: '7KCp4eenFS4CowF9SpQE5BBCj5MtoBA3K811tNyRmhLfH1aV', discordName: 'polkadot', discordId: '1064520790978080818' },
  { address: '7N4oFqXKgeTXo6CMSY9BVZdHP5J3RhQXY77Fe7qmQwjcxa1w', discordName: 'polkadot', discordId: '1064520790978080818' },
  { address: '7LCt6dFmtiRrwZv2YyEgQWW3GxsGX3Krmgzv9Xj7GQ9tG2j8', discordName: 'moonbeam', discordId: '1390048945023094966' },
  { address: '7KuHrDdWdFs53fRPpzZXngS6wdymqAQ398VYUuyYkQwXpE4j', discordName: 'polkadot', discordId: '1064520790978080818' },
  { address: '7KATdGae91uodYHAhxuA7Re7ijGTDAFFa9ykVhUhJf9kEAR5', discordName: 'HOLLAR', discordId: '1419786409664970834' },
  { address: '7Jc3x1xkaLKjgzPEN9Yy1sxbYP84kAEkn39VKr5BAmHMNMuw', discordName: 'HDX', discordId: '1419786558357377185' },
]

let customIconOverridesByHydrationAddress: Map<string, CustomIconOverride> | null = null
let snakewatchEmojiSource: SnakewatchEmojiSource | null = null
let snakewatchEmojiSourceExpiresAt = 0
let snakewatchEmojiSourceLoad: Promise<void> | null = null

export function shortAccount(account: string): string {
  return account.slice(-3)
}

function accountIdBytes(account: string): Uint8Array | null {
  const hex = account.startsWith('0x') ? account.slice(2) : account
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

export function accountIdHex(account: string): string | null {
  const bytes = accountIdBytes(account) ?? ss58AccountIdBytes(account)
  return bytes ? `0x${Buffer.from(bytes).toString('hex')}` : null
}

function base58Encode(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++

  const hex = Buffer.from(bytes).toString('hex')
  let value = hex.length > 0 ? BigInt(`0x${hex}`) : 0n
  let encoded = ''

  while (value > 0n) {
    const remainder = Number(value % 58n)
    encoded = BASE58_ALPHABET[remainder] + encoded
    value /= 58n
  }

  return '1'.repeat(zeros) + encoded
}

function base58Decode(value: string): Uint8Array | null {
  let decoded = 0n

  for (const char of value) {
    const index = BASE58_ALPHABET.indexOf(char)
    if (index === -1) return null
    decoded = decoded * 58n + BigInt(index)
  }

  const bytes: number[] = []
  while (decoded > 0n) {
    bytes.unshift(Number(decoded & 0xffn))
    decoded >>= 8n
  }

  let zeros = 0
  while (zeros < value.length && value[zeros] === '1') zeros++

  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes])
}

function ss58AccountIdBytes(account: string): Uint8Array | null {
  const decoded = base58Decode(account)
  if (!decoded || decoded.length < 35) return null

  const prefixLength = decoded[0] < 64 ? 1 : 2
  if (decoded.length !== prefixLength + 32 + 2) return null

  const payload = decoded.subarray(0, prefixLength + 32)
  const expectedChecksum = createHash('blake2b512')
    .update(Buffer.concat([SS58_CHECKSUM_PREFIX, Buffer.from(payload)]))
    .digest()
    .subarray(0, 2)
  const checksum = decoded.subarray(prefixLength + 32)
  if (checksum[0] !== expectedChecksum[0] || checksum[1] !== expectedChecksum[1]) return null

  return decoded.subarray(prefixLength, prefixLength + 32)
}

function customIconOverrideFor(account: string): CustomIconOverride | null {
  const hydrationAccount = hydrationAddress(account)

  if (!customIconOverridesByHydrationAddress) {
    customIconOverridesByHydrationAddress = new Map()
    for (const override of CUSTOM_ICON_OVERRIDES) {
      customIconOverridesByHydrationAddress.set(override.address, override)
    }
  }

  return customIconOverridesByHydrationAddress.get(hydrationAccount) ?? null
}

function snakewatchDegenFor(account: string): string | null {
  return snakewatchEmojiSource?.degensByHydrationAddress.get(hydrationAddress(account)) ?? null
}

function ss58Address(account: string, prefix: number): string {
  const publicKey = accountIdBytes(account) ?? ss58AccountIdBytes(account)
  if (!publicKey) return account

  const payload = Buffer.concat([
    Buffer.from([prefix]),
    Buffer.from(publicKey),
  ])
  const checksum = createHash('blake2b512')
    .update(Buffer.concat([SS58_CHECKSUM_PREFIX, payload]))
    .digest()
    .subarray(0, 2)

  return base58Encode(Buffer.concat([payload, checksum]))
}

export function hydrationAddress(account: string): string {
  return ss58Address(account, HYDRATION_SS58_PREFIX)
}

export function polkadotAddress(account: string): string {
  return ss58Address(account, POLKADOT_SS58_PREFIX)
}

function defaultAccountEmoji(account: string, emojis: readonly string[] = snakewatchEmojiSource?.emojis ?? EMOJIS): string {
  const hex = accountIdHex(account)?.slice(2) ?? ''
  if (/^[0-9a-fA-F]+$/.test(hex) && hex.length > 0) {
    const index = (Number(`0x${hex}`) / 2) % emojis.length
    return emojis[index] ?? emojis[0] ?? EMOJIS[0]
  }

  let hash = 0
  for (let i = 0; i < account.length; i++) {
    hash = (hash * 31 + account.charCodeAt(i)) >>> 0
  }
  return emojis[hash % emojis.length] ?? EMOJIS[0]
}

function discordEmojiUrl(discordId: string, animated = false): string {
  return `https://cdn.discordapp.com/emojis/${discordId}.${animated ? 'gif' : 'webp'}?size=32`
}

function iconFromSnakewatchValue(value: string, fallback: string): AccountIcon {
  const customEmoji = value.match(/^<(a?):([^:>]+):(\d+)>$/)
  if (customEmoji) {
    const [, animated, name, id] = customEmoji
    return {
      emoji: fallback,
      emojiName: name,
      emojiUrl: discordEmojiUrl(id, animated === 'a'),
    }
  }

  return value ? { emoji: value } : { emoji: fallback }
}

function unescapeJsString(value: string): string {
  return value
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

export function parseSnakewatchEmojiSource(source: string): SnakewatchEmojiSource {
  const emojisMatch = source.match(/const\s+emojis\s*=\s*\[([\s\S]*?)\]\s*;/)
  const degensMatch = source.match(/const\s+degens\s*=\s*\{([\s\S]*?)\}\s*;/)
  if (!emojisMatch || !degensMatch) {
    throw new Error('Snakewatch emojify source did not contain emojis and degens literals')
  }

  const emojis: string[] = []
  for (const match of emojisMatch[1].matchAll(/'((?:\\.|[^'\\])*)'/g)) {
    emojis.push(unescapeJsString(match[1]))
  }
  if (emojis.length === 0) throw new Error('Snakewatch emojify source did not contain any emojis')

  const degensByHydrationAddress = new Map<string, string>()
  for (const match of degensMatch[1].matchAll(/'((?:\\.|[^'\\])*)'\s*:\s*'((?:\\.|[^'\\])*)'/g)) {
    degensByHydrationAddress.set(hydrationAddress(unescapeJsString(match[1])), unescapeJsString(match[2]))
  }

  return { emojis, degensByHydrationAddress }
}

export function applySnakewatchEmojiSource(source: string): SnakewatchEmojiSource {
  const parsed = parseSnakewatchEmojiSource(source)
  snakewatchEmojiSource = parsed
  snakewatchEmojiSourceExpiresAt = Date.now() + SNAKEWATCH_EMOJIFY_CACHE_MS
  return parsed
}

export function clearSnakewatchEmojiSourceForTest() {
  snakewatchEmojiSource = null
  snakewatchEmojiSourceExpiresAt = 0
  snakewatchEmojiSourceLoad = null
}

export async function ensureSnakewatchEmojiSourceLoaded(): Promise<void> {
  if (snakewatchEmojiSource && Date.now() < snakewatchEmojiSourceExpiresAt) return
  if (snakewatchEmojiSourceLoad) return snakewatchEmojiSourceLoad

  snakewatchEmojiSourceLoad = (async () => {
    try {
      const response = await fetch(SNAKEWATCH_EMOJIFY_URL, {
        signal: AbortSignal.timeout(3000),
      })
      if (!response.ok) throw new Error(`Snakewatch emojify fetch failed: ${response.status}`)
      applySnakewatchEmojiSource(await response.text())
    } catch (error) {
      if (!snakewatchEmojiSource) {
        snakewatchEmojiSourceExpiresAt = Date.now() + 5 * 60 * 1000
      }
      console.warn(error instanceof Error ? error.message : 'Snakewatch emojify fetch failed')
    } finally {
      snakewatchEmojiSourceLoad = null
    }
  })()

  return snakewatchEmojiSourceLoad
}

export function accountIcon(account: string): AccountIcon {
  const fallback = defaultAccountEmoji(account)
  const snakewatchDegen = snakewatchDegenFor(account)
  if (snakewatchDegen != null) return iconFromSnakewatchValue(snakewatchDegen, fallback)

  const override = customIconOverrideFor(account)
  if (override?.emoji) return { emoji: override.emoji }

  if (override?.discordName && override.discordId) {
    return {
      emoji: fallback,
      emojiName: override.discordName,
      emojiUrl: discordEmojiUrl(override.discordId),
    }
  }

  return { emoji: fallback }
}
