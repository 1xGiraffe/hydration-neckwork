import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { TOOL_DEFINITIONS } from './registry.ts'
import type { ToolContext, ToolDefinition, ToolError, ToolOutput } from './toolTypes.ts'

// The server identity a client shows the user. The version is a literal, not a
// read of ../../package.json: the mcp tree is a total import leaf
// (api/tests/mcp/isolation.test.ts), and the api package version tracks the
// whole repository rather than this tool contract anyway. Bump it when the tool
// surface changes shape.
const SERVER_NAME = 'hydration-explorer'
const SERVER_VERSION = '1.0.0'

const TRUNCATION_NOTE = '\n\n_[truncated: the answer exceeded this server\'s text budget. Narrow the request — a smaller `limit`, a tighter window, or fewer `include` sections — to see the rest.]_'

/**
 * Renders a tool's output into the single text block the MCP reply carries.
 *
 * Deliberately one block and no `structuredContent`: a client that forwards
 * both puts the same answer in the model's context twice, doubling the token
 * cost of every call. `format: "json"` is how a caller asks for the structured
 * record instead of the reading.
 */
export function renderToolText(output: ToolOutput, wantsJson: boolean, maxTextChars: number): { text: string; isError: boolean } {
  const errors = output.errors ?? []
  if (wantsJson) return renderJson(output.json, errors, maxTextChars)

  let payload = (output.markdown ?? '').trim()
  const errorBlock = errors.length > 0
    ? `\n\n**Errors**\n${errors.map(e => `- \`${e.code}\` ${e.message}`).join('\n')}`
    : ''

  const budget = Math.max(0, maxTextChars - errorBlock.length - TRUNCATION_NOTE.length)
  if (payload.length > maxTextChars - errorBlock.length) {
    payload = payload.slice(0, budget) + TRUNCATION_NOTE
  }

  const text = payload ? `${payload}${errorBlock}` : errorBlock.trim()
  return {
    text: text || 'No data.',
    // An error verdict only when there is nothing to read: a partial answer
    // with its gaps named is still an answer.
    isError: payload.length === 0 && errors.length > 0,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `format: "json"` promises a document the caller can parse. So the partial
 * failures a markdown answer appends as an `**Errors**` section have to travel
 * INSIDE the document here, and an over-budget answer cannot be cut mid-string
 * the way prose can — either shape would hand back something `JSON.parse`
 * rejects, which is worse than a smaller answer.
 */
function renderJson(json: unknown, errors: readonly ToolError[], maxTextChars: number): { text: string; isError: boolean } {
  const empty = json == null
  const body = errors.length === 0
    ? json
    : isPlainObject(json) ? { ...json, errors }
    // A tool whose record is an array or a bare value still needs somewhere to
    // put them, so those shapes nest under `data` rather than losing the errors.
    : { data: json ?? null, errors }

  let text = JSON.stringify(body, null, 2) ?? 'null'
  if (text.length > maxTextChars) {
    // Last resort: the tools size their own records to fit, so reaching this
    // means one grew past the budget. Answer with a valid document saying so
    // rather than a truncated one that will not parse.
    text = JSON.stringify({
      errors: [...errors, {
        code: 'TOO_LARGE' as const,
        message: `the structured record is ${text.length.toLocaleString('en-US')} characters, past this server's ${maxTextChars.toLocaleString('en-US')}-character budget. Narrow the request — a smaller \`limit\`, fewer \`include\` sections, or a tighter window — or read it as markdown, which trims to fit.`,
      }],
    }, null, 2)
    return { text, isError: true }
  }
  return { text, isError: empty && errors.length > 0 }
}

function toolCallback(def: ToolDefinition, ctx: ToolContext) {
  return async (args: Record<string, unknown> | undefined) => {
    const input = args ?? {}
    try {
      const output = await def.handler(input, ctx)
      const { text, isError } = renderToolText(output, input.format === 'json', ctx.maxTextChars)
      return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) }
    } catch (err) {
      // The client gets a code and a plain sentence; the stack, the upstream URL
      // and anything else about this deployment's internals stay in the log.
      console.error(`[mcp] tool ${def.name} failed`, err)
      return {
        content: [{
          type: 'text' as const,
          text: `**Errors**\n- \`INTERNAL_ERROR\` ${def.name} failed while building its answer. This is a fault on the Hydration MCP server, not in the request; retrying once is reasonable.`,
        }],
        isError: true,
      }
    }
  }
}

/**
 * Builds a fresh MCP server with every registered tool bound to `ctx`.
 *
 * One per request: the transport is stateless (spec § 2), so nothing survives
 * between calls and any number of agents can connect without server memory.
 */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })

  for (const def of TOOL_DEFINITIONS) {
    server.registerTool(def.name, {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      // Every tool reads; none writes, none mutates, and all of them reach an
      // external system (the chain index), which is what openWorldHint states.
      annotations: {
        title: def.title,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    }, toolCallback(def, ctx))
  }

  return server
}
