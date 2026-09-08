import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TypeKind } from '@subsquid/substrate-runtime/lib/metadata'
import { sts } from '../../src/types/support.ts'
import { broadcast } from '../../src/types/events.ts'
import * as v323 from '../../src/types/v323.ts'
import * as v443 from '../../src/types/v443.ts'

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

// The Filler enum as a block's metadata describes it: unit variants plus the
// pool-id carrying ones (u32). `.is()` matches a typegen arm structurally against
// this, and a closed enum must name every variant with nothing left over — which is
// how one new variant in spec 443 made every older Swapped3 arm decline.
const U32 = 0
const FILLER_TI = 1
const fillerMetadata = (variants: string[]): sts.ScaleType[] => [
  { kind: TypeKind.Primitive, primitive: 'U32' },
  {
    kind: TypeKind.Variant,
    variants: variants.map((name, index) => ({
      index,
      name,
      fields: ['OTC', 'Stableswap', 'XYK'].includes(name) ? [{ type: U32 }] : [],
    })),
  },
]
const FILLER_323 = ['AAVE', 'HSM', 'LBP', 'OTC', 'Omnipool', 'Stableswap', 'XYK']
const FILLER_443 = [...FILLER_323, 'UniswapV3']

describe('Broadcast.Swapped3 typegen arms', () => {
  it('has a v443 arm whose Filler knows UniswapV3', () => {
    expect(broadcast.swapped3.v443).toBeDefined()
    const spec443 = fillerMetadata(FILLER_443)
    expect(sts.match(spec443, FILLER_TI, v443.Filler)).toBe(true)
    expect(sts.match(spec443, FILLER_TI, v323.Filler)).toBe(false)
    // a precise pin on 443, not an open enum that would also claim the 323 shape
    expect(sts.match(fillerMetadata(FILLER_323), FILLER_TI, v443.Filler)).toBe(false)
  })

  it('tries every declared Swapped3 arm in decodeTradeEvent, newest first', () => {
    const arms = [...read('src/types/broadcast/events.ts').matchAll(/^\s{4}(v\d+): new EventType\(\s*\n\s*'Broadcast\.Swapped3'/gm)].map(m => m[1])
    expect(arms).toEqual(expect.arrayContaining(['v313', 'v323', 'v443']))
    const src = read('src/blocks/extractVolume.ts')
    const positions = arms.map(v => ({ v, at: src.indexOf(`broadcast.swapped3.${v}.is(event)`) }))
    for (const p of positions) expect(p.at, `decodeTradeEvent never tries ${p.v}`).toBeGreaterThan(-1)
    const byVersionDesc = [...positions].sort((a, b) => Number(b.v.slice(1)) - Number(a.v.slice(1)))
    for (let i = 1; i < byVersionDesc.length; i++) {
      expect(byVersionDesc[i - 1].at, 'newer arms must be tried before older ones').toBeLessThan(byVersionDesc[i].at)
    }
  })
})
