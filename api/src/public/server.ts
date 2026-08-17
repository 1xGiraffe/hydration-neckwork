import { parsePort } from '../config.ts'
import { createClickHouseClient } from '../db/client.ts'
import { loadExplorerAssets, stopExplorerAssetsRefresh } from '../services/explorerAssets.ts'
import { buildPublicApp } from './app.ts'

// The public REST API runs as its own process (compose service `api-public`) from
// the same image as `api`, so a public consumer's load and the explorer's never
// share an event loop or a rate-limit budget.
const port = parsePort(process.env.PUBLIC_API_PORT, 'PUBLIC_API_PORT')
const host = process.env.PUBLIC_API_HOST?.trim() || '0.0.0.0'

const client = createClickHouseClient()
const app = await buildPublicApp({ client })

// Drain in-flight requests and close the ClickHouse keep-alive pool when Docker
// replaces the container, so deploys don't leave half-open requests.
app.addHook('onClose', async () => {
  stopExplorerAssetsRefresh()
  await client.close()
})

async function start(): Promise<void> {
  try {
    // Every timestamp on this surface is produced by appending 'Z' to a
    // ClickHouse DateTime string (iso() in public/schemas/common.ts), which is
    // only correct while the session timezone is UTC. Fail fast rather than
    // silently publishing timestamps in another zone as if they were UTC.
    const tzRes = await client.query({ query: 'SELECT timezone() AS tz', format: 'JSONEachRow' })
    const [{ tz }] = await tzRes.json<{ tz: string }>()
    if (tz !== 'UTC') {
      app.log.error(
        `[public-api] ClickHouse session timezone is '${tz}', not 'UTC'. iso() in public/schemas/common.ts treats DateTime strings as UTC and would publish shifted timestamps.`,
      )
      process.exit(1)
    }
    // GET /v1/assets serves the shared registry snapshot from memory; load it
    // before accepting traffic so the first request is not an empty registry.
    // The snapshot then refreshes itself every 5 minutes.
    await loadExplorerAssets(client)
    await app.listen({ port, host })
    console.log(`[public-api] Server listening on ${host}:${port}`)
  } catch (err) {
    app.log.error(err)
    await app.close().catch(async closeError => {
      app.log.error(closeError)
      await client.close().catch(() => {})
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
