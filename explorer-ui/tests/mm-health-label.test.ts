import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/components/positions/BorrowTab.tsx', import.meta.url), 'utf8')

// "Lowest HF" is only true of a row that SUMS several members, where the figure
// shown is the worst of them. The label used to key off `simAccount`, which was a
// proxy for "this is an aggregate" — it held only because the tag aggregate was
// the one thing carrying a DefiSim target. Once per-account rows started carrying
// one too (so each could link to its own address), every single account's card
// claimed to be showing the lowest of several. The rule lives on the Borrow tab,
// the money-market position's one surface.
describe('the money-market health label', () => {
  it('keys on how many members the row sums, not on the DefiSim target', () => {
    expect(src).toContain("{(mm.memberCount ?? 0) > 1 ? 'Lowest HF' : 'HF'}")
    expect(src).toContain("(mm.memberCount ?? 0) > 1 ? 'Lowest member health factor'")
    expect(src).not.toContain("mm.simAccount ? 'Lowest")
  })
})
