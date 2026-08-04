// Solidity syntax highlighting for the Contract tab's source viewer.
//
// Hand-rolled for the same reason JsonView is: the palette has to be the page's
// own tokens, and a highlighting library would ship a theme we would then have to
// override anyway (plus a chunk, for one view). Unlike JsonView this does NOT
// regex-replace into HTML — a `//` inside a string literal or a quote inside a
// comment makes that approach lose text — it is one left-to-right pass emitting
// tokens the component renders as spans, so the source is reproduced exactly.

export type SolTokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'type' | 'plain'
export interface SolToken { kind: SolTokenKind; text: string }

// Ordered alternation — the first arm that matches at a position wins, which is
// what makes context work: a `//` inside a string is consumed by the string arm
// before the comment arm ever sees it, and vice versa. The unterminated cases
// (`|$` on the block comment, the optional closing quotes) consume to end of
// input rather than dropping the tail, so a truncated file still renders whole.
const SOL_TOKEN = new RegExp([
  /\/\*[\s\S]*?(?:\*\/|$)/.source,          // block comment (incl. natspec /** */)
  /\/\/[^\n]*/.source,                      // line comment
  /"(?:\\[\s\S]|[^"\\\n])*"?/.source,       // double-quoted string
  /'(?:\\[\s\S]|[^'\\\n])*'?/.source,       // single-quoted string
  /0[xX][0-9a-fA-F_]+/.source,              // hex literal (address, bytes32, …)
  /\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?/.source,  // decimal / scientific
  /[A-Za-z_$][A-Za-z0-9_$]*/.source,        // identifier or word
].map(s => `(?:${s})`).join('|'), 'g')

const KEYWORDS = new Set([
  'pragma', 'solidity', 'import', 'contract', 'interface', 'library', 'abstract', 'is',
  'function', 'modifier', 'event', 'error', 'struct', 'enum', 'constructor', 'fallback', 'receive',
  'using', 'public', 'private', 'internal', 'external', 'pure', 'view', 'payable',
  'virtual', 'override', 'immutable', 'constant', 'returns', 'return',
  'if', 'else', 'for', 'while', 'do', 'break', 'continue', 'new', 'delete',
  'emit', 'revert', 'require', 'assert', 'try', 'catch', 'throw',
  'memory', 'storage', 'calldata', 'indexed', 'anonymous', 'unchecked', 'assembly',
  'mapping', 'type', 'let', 'as', 'from', 'global',
  'true', 'false', 'this', 'super', 'selfdestruct',
  'wei', 'gwei', 'ether', 'seconds', 'minutes', 'hours', 'days', 'weeks', 'years',
])

// Elementary value types, including every sized form (uint8…uint256, bytes1…32,
// fixed/ufixed). Matched by shape rather than enumerated, so an unusual-but-legal
// width still colours as a type.
const TYPE_RE = /^(?:address|bool|string|byte|bytes(?:[1-9]|1\d|2\d|3[0-2])?|u?int(?:\d+)?|u?fixed(?:\d+x\d+)?)$/

function wordKind(word: string): SolTokenKind {
  if (KEYWORDS.has(word)) return 'keyword'
  if (TYPE_RE.test(word)) return 'type'
  return 'plain'
}

function kindOf(text: string): SolTokenKind {
  const c = text[0]
  if (c === '/') return 'comment'
  if (c === '"' || c === "'") return 'string'
  if (c >= '0' && c <= '9') return 'number'
  return wordKind(text)
}

// Above this, highlighting is skipped and the source renders plain. Nothing on
// chain comes close (largest verified source measured: 36 kB), so this only
// exists so a pathological future file degrades instead of janking the tab.
export const SOL_HIGHLIGHT_MAX_BYTES = 400_000

export function tokenizeSolidity(source: string): SolToken[] {
  if (!source) return []
  if (source.length > SOL_HIGHLIGHT_MAX_BYTES) return [{ kind: 'plain', text: source }]
  const out: SolToken[] = []
  // Adjacent plain runs (whitespace, operators, an identifier between them) merge
  // into one token, so a 36 kB file is a few thousand spans rather than tens of
  // thousands of one-character ones.
  const push = (kind: SolTokenKind, text: string) => {
    if (!text) return
    const last = out[out.length - 1]
    if (kind === 'plain' && last?.kind === 'plain') last.text += text
    else out.push({ kind, text })
  }
  let cursor = 0
  SOL_TOKEN.lastIndex = 0
  for (let m = SOL_TOKEN.exec(source); m; m = SOL_TOKEN.exec(source)) {
    if (m.index > cursor) push('plain', source.slice(cursor, m.index))
    push(kindOf(m[0]), m[0])
    cursor = m.index + m[0].length
  }
  if (cursor < source.length) push('plain', source.slice(cursor))
  return out
}
