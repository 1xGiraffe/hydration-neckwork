import { mcpConfig } from './config.ts'
import { buildMcpApp } from './app.ts'
import { createUpstreamClient, type UpstreamLogger } from './upstream.ts'

// The MCP server runs as its own process (compose service `api-mcp`) from the
// same image as `api`. It holds no database connection at all: its entire data
// reach is HTTP to the explorer api, which is what makes the import isolation
// in api/tests/mcp/isolation.test.ts total rather than a convention.
// The client has to exist before the app (the boot probe below uses it) but
// must log through the app's logger once there is one, so an allow-list refusal
// is a structured line beside every other line this container writes rather
// than a bare console.warn. Until then it falls back to the console.
let appLogger: UpstreamLogger | undefined
const upstream = createUpstreamClient({
  baseUrl: mcpConfig.explorerApiUrl,
  timeoutMs: mcpConfig.upstreamTimeoutMs,
  maxConcurrency: mcpConfig.maxUpstreamConcurrency,
  queueTimeoutMs: mcpConfig.upstreamQueueTimeoutMs,
  maxQueueDepth: mcpConfig.upstreamQueueDepth,
  cheapLaneSlots: mcpConfig.upstreamCheapLaneSlots,
  defaultTtlMs: mcpConfig.cacheTtlMs,
  userAgent: `hydration-mcp/1.0 (+${mcpConfig.publicUrl})`,
  logger: { warn: (details, message) => { (appLogger ?? console).warn(details, message) } },
})

const app = await buildMcpApp({ upstream })
appLogger = app.log

async function start(): Promise<void> {
  try {
    // One probe, reported and then let go. The explorer api may still be
    // starting — compose orders `api-mcp` after it but cannot wait for it to be
    // serving — and refusing to listen would take this service down for a
    // condition that resolves itself within seconds.
    try {
      await upstream.get('/health', undefined, { ttlMs: 0, timeoutMs: 5_000 })
      app.log.info(`[mcp] upstream explorer api answered at ${mcpConfig.explorerApiUrl}`)
    } catch (err) {
      app.log.warn({ err }, `[mcp] upstream explorer api at ${mcpConfig.explorerApiUrl} did not answer the boot probe; serving anyway and retrying per request`)
    }
    await app.listen({ port: mcpConfig.port, host: mcpConfig.host })
    console.log(`[mcp] Server listening on ${mcpConfig.host}:${mcpConfig.port}, published as ${mcpConfig.publicUrl}`)
  } catch (err) {
    app.log.error(err)
    await app.close().catch(closeError => {
      app.log.error(closeError)
    })
    process.exit(1)
  }
}

let shuttingDown = false
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  app.log.info({ signal }, 'shutting down')
  try {
    await app.close()
  } catch (err) {
    app.log.error(err)
    process.exitCode = 1
  }
  process.exit(process.exitCode ?? 0)
}

process.once('SIGTERM', () => { void shutdown('SIGTERM') })
process.once('SIGINT', () => { void shutdown('SIGINT') })

void start()
