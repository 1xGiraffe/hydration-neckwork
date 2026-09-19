import { z } from 'zod'
import type { ZodRawShape } from 'zod'
import type { UpstreamClient } from './upstream.ts'

// What every tool handler is handed. It carries no database client and no
// explorer service — the upstream HTTP client is the tool tree's entire reach.
export interface ToolContext {
  upstream: UpstreamClient
  explorerBaseUrl: string   // no trailing slash
  publicUrl: string         // this service's own origin, no trailing slash
  maxTextChars: number
}

export type ToolErrorCode = 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'NOT_YET_INDEXED' | 'UPSTREAM_UNAVAILABLE' | 'TOO_LARGE' | 'INTERNAL_ERROR'

export interface ToolError { code: ToolErrorCode; message: string }

// The uniform output contract: a rendered reading, the structured record behind
// it, and any partial failures. A tool that answered in part returns both the
// payload it has and the errors explaining the gap, rather than failing whole.
export interface ToolOutput { markdown: string; json: unknown; errors?: ToolError[] }

export interface ToolDefinition {
  name: string
  title: string
  description: string        // the long agent-facing description
  inputSchema: ZodRawShape   // SDK-style raw shape, NOT a ZodObject
  handler(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>
}

// Every tool takes the same rendering switch, declared once so the wording an
// agent reads is identical across the surface and the registry test can assert
// its presence.
export const formatParam = z.enum(['markdown', 'json']).optional().describe("Response rendering. 'markdown' (default) is a compact, token-efficient reading of the data; 'json' returns the raw structured record.")
