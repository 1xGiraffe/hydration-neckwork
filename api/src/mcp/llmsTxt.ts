import type { ToolDefinition } from './toolTypes.ts'

// The orientation an automated client reads before deciding what to call
// (llmstxt.org). It is a MAP, not a second copy of the schemas: the framing,
// the endpoint, and one line per tool. The schemas travel over the protocol
// itself, where they are always current.

// The long description opens with the sentence that says what the tool
// answers; everything after it is parameter lore a map does not need.
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const match = /^(.+?[.!?])(\s|$)/.exec(flat)
  const sentence = (match ? match[1] : flat).trim()
  return sentence.length > 240 ? `${sentence.slice(0, 237)}...` : sentence
}

export function renderLlmsTxt(tools: readonly ToolDefinition[], publicUrl: string): string {
  const origin = publicUrl.replace(/\/+$/, '')
  const lines: string[] = [
    '# Hydration Explorer MCP',
    '',
    '> Live Hydration chain data for coding agents, already interpreted: amounts scaled and named, rows classified into the user\'s highest-level economic action, accounts and assets resolved, every record carrying its canonical Explorer URL. Read-only, public chain data only.',
    '',
    '## Endpoint',
    '',
    `- **URL**: \`${origin}/mcp\``,
    '- **Transport**: Streamable HTTP, stateless. Every JSON-RPC message is a POST; there is no session to resume, so GET and DELETE answer 405.',
    '- **Auth**: none by default. A deployment that sets access keys answers 401 and expects `Authorization: Bearer <key>`.',
    `- **Client config**: \`${origin}/mcp.json\` is copy-ready. Getting started: \`${origin}/start\`.`,
    '',
    '## Connecting',
    '',
    '```sh',
    `claude mcp add --transport http hydration ${origin}/mcp`,
    '```',
    '',
    '## Conventions',
    '',
    '- Every tool takes `format`: `markdown` (default, compact and token-budgeted) or `json` (the structured record).',
    '- Answers are read-only and idempotent. Nothing here writes to the chain.',
    '- Amounts arrive scaled and symbol-named with their USD value; the raw integer is in the `json` form.',
    '- Rows marked **unconfirmed** are mempool or unfinalized projections, not chain facts yet.',
    '- A miss distinguishes "not indexed yet" (retry; the index trails the finalized head by 35-65 seconds) from "never existed" (fail fast).',
    '',
    '## Tools',
    '',
  ]

  if (tools.length === 0) {
    lines.push('_No tools are registered on this deployment._')
  } else {
    for (const tool of tools) lines.push(`- \`${tool.name}\` — ${firstSentence(tool.description) || tool.title}`)
  }

  lines.push('')
  return lines.join('\n')
}
