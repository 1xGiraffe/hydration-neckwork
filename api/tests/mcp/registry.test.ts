import { describe, expect, it } from 'vitest'
import { EXPECTED_TOOL_NAMES, TOOL_DEFINITIONS } from '../../src/mcp/registry.ts'
import { formatParam } from '../../src/mcp/toolTypes.ts'
import { renderLlmsTxt } from '../../src/mcp/llmsTxt.ts'

// The tool surface is the contract a client codes against, so the registry is
// pinned rather than merely described: the registered list must equal
// EXPECTED_TOOL_NAMES exactly and in order. Adding, removing or reordering a
// tool is a change to a published contract, so it fails here until the
// declaration is updated to match.
describe('tool registry', () => {
  it('declares the thirteen names the design pins, uniquely', () => {
    expect(EXPECTED_TOOL_NAMES).toHaveLength(13)
    expect(new Set(EXPECTED_TOOL_NAMES).size).toBe(EXPECTED_TOOL_NAMES.length)
  })

  it('registers exactly the expected names, in order, each once', () => {
    const names = TOOL_DEFINITIONS.map(t => t.name)
    expect(new Set(names).size, `duplicate tool names: ${names.join(', ')}`).toBe(names.length)
    // Unconditional. A check that only compares the lists when their lengths
    // already agree lets a dropped tool through in silence, which is the one
    // regression this test exists to catch.
    expect(names, 'the registered tools must match EXPECTED_TOOL_NAMES exactly and in order').toEqual([...EXPECTED_TOOL_NAMES])
  })

  it('gives every tool a title and an agent-facing description', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.title.trim(), `${tool.name} needs a title`).not.toBe('')
      // The description is the only place an agent learns what a tool answers
      // and which traps it must not walk into; a one-liner is never enough.
      expect(tool.description.trim().length, `${tool.name}'s description is too short to orient an agent`).toBeGreaterThanOrEqual(80)
    }
  })

  it('gives every tool the shared format switch', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(Object.keys(tool.inputSchema), `${tool.name} must accept 'format'`).toContain('format')
      // The same instance, so the wording an agent reads is identical on every
      // tool rather than thirteen near-copies that drift.
      expect(tool.inputSchema.format, `${tool.name} must reuse formatParam from toolTypes.ts`).toBe(formatParam)
    }
  })

  it('exposes a handler on every tool', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(typeof tool.handler, `${tool.name} needs a handler`).toBe('function')
    }
  })
})

describe('llms.txt', () => {
  const rendered = renderLlmsTxt(TOOL_DEFINITIONS, 'https://hydration-mcp.neckwork.net/')

  it('names every registered tool', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(rendered, `${tool.name} is missing from /llms.txt`).toContain(`\`${tool.name}\``)
    }
  })

  it('names the endpoint and normalizes the origin', () => {
    expect(rendered).toContain('https://hydration-mcp.neckwork.net/mcp')
    expect(rendered).not.toContain('neckwork.net//mcp')
  })

  it('stays a map rather than a second copy of the schemas', () => {
    // A budget, not a style rule: an agent reads this before deciding what to
    // call, and the schemas already travel over the protocol itself.
    expect(rendered.length).toBeLessThan(8_000)
  })
})
