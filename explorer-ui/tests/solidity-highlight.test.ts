import { describe, it, expect } from 'vitest'
import { tokenizeSolidity, SOL_HIGHLIGHT_MAX_BYTES, type SolToken } from '../src/utils/solidityHighlight'

const text = (tokens: SolToken[]) => tokens.map(t => t.text).join('')
// A highlighted token is always exactly its own text; plain runs deliberately
// merge (see the merge test below), so a plain word is found inside one.
function kindOf(tokens: SolToken[], needle: string): SolToken['kind'] | undefined {
  const exact = tokens.find(t => t.text === needle)
  if (exact) return exact.kind
  return tokens.some(t => t.kind === 'plain' && t.text.includes(needle)) ? 'plain' : undefined
}

describe('tokenizeSolidity', () => {
  // The whole point of a tokenizer over JsonView's regex-replace: every byte of
  // the source has to come back, in order, whatever the input looks like.
  it('reproduces the source exactly, for every shape it recognises', () => {
    for (const src of [
      '', 'contract A {}\n',
      '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.19;\n',
      'function f(uint256 x) external pure returns (bytes32) { return bytes32(x); }',
      '/** @dev natspec\n * @param a thing\n */\n',
      'string memory s = "a \\"quoted\\" thing";',
      "bytes memory b = hex'deadBEEF';",
      'uint256 constant N = 1_000_000e18;\naddress a = 0xdeCB90b13a893B054F2Cb5b2cFfcbF4E2878076b;',
    ]) {
      expect(text(tokenizeSolidity(src)), `round-trip: ${JSON.stringify(src)}`).toBe(src)
    }
  })

  it('classifies keywords, elementary types, strings, numbers and comments', () => {
    const t = tokenizeSolidity('pragma solidity ^0.8.19;\ncontract C { uint256 public n = 42; }')
    expect(kindOf(t, 'pragma')).toBe('keyword')
    expect(kindOf(t, 'contract')).toBe('keyword')
    expect(kindOf(t, 'public')).toBe('keyword')
    expect(kindOf(t, 'uint256')).toBe('type')
    expect(kindOf(t, '42')).toBe('number')
    expect(kindOf(t, 'C')).toBe('plain')
    expect(kindOf(t, 'n')).toBe('plain')
  })

  it('sizes types by shape, so an unusual-but-legal width still reads as a type', () => {
    const t = tokenizeSolidity('int128 a; bytes17 b; ufixed128x18 c; uint7 d; bytes33 e;')
    for (const w of ['int128', 'bytes17', 'ufixed128x18', 'uint7']) expect(kindOf(t, w), w).toBe('type')
    expect(kindOf(t, 'bytes33')).toBe('plain')   // past the legal range — not a type
  })

  // Context, which is exactly what a regex-replace highlighter gets wrong.
  it('does not see a comment inside a string, or a quote inside a comment', () => {
    const t = tokenizeSolidity('string s = "http://example.com"; // a "quoted" note')
    expect(kindOf(t, '"http://example.com"')).toBe('string')
    expect(kindOf(t, '// a "quoted" note')).toBe('comment')
    expect(t.filter(x => x.kind === 'comment')).toHaveLength(1)
  })

  it('does not let a keyword inside a comment or string colour as code', () => {
    const t = tokenizeSolidity('// return uint256\n')
    expect(t.map(x => x.kind)).not.toContain('keyword')
    expect(t.map(x => x.kind)).not.toContain('type')
  })

  it('consumes an unterminated comment or string to the end instead of dropping it', () => {
    for (const src of ['contract A { /* never closed', 'string s = "never closed', "bytes b = 'oops"]) {
      expect(text(tokenizeSolidity(src))).toBe(src)
    }
    expect(kindOf(tokenizeSolidity('/* open'), '/* open')).toBe('comment')
  })

  it('merges adjacent plain runs so a large file is not one span per character', () => {
    const t = tokenizeSolidity('a + b * (c - d) / e;')
    expect(text(t)).toBe('a + b * (c - d) / e;')
    // Identifiers here are plain too, so the whole line collapses to one token.
    expect(t).toHaveLength(1)
  })

  it('gives up on a pathological file rather than janking, still losing nothing', () => {
    const huge = 'uint256 x;\n'.repeat(Math.ceil(SOL_HIGHLIGHT_MAX_BYTES / 11) + 1)
    const t = tokenizeSolidity(huge)
    expect(t).toEqual([{ kind: 'plain', text: huge }])
  })

  it('is reentrant — the shared regex cannot carry state between calls', () => {
    const src = 'uint256 a = 1;'
    const first = tokenizeSolidity(src)
    expect(tokenizeSolidity(src)).toEqual(first)
    expect(tokenizeSolidity(src)).toEqual(first)
  })
})
