import { parsePort } from '../config.ts'
import { createClickHouseClient } from '../db/client.ts'
import { loadExplorerAssets, stopExplorerAssetsRefresh } from '../services/explorerAssets.ts'
import { buildDataApp } from './app.ts'
import { flushUsage, startUsageFlush, stopUsageFlush } from './services/auth.ts'

// The Data API runs as its own process (compose service `api-data`) from the
// same image as `api`, so external developers' load never shares an event loop,
// in-process cache or rate-limit state with the explorer or the public API.
const port = parsePort(process.env.DATA_API_PORT, 'DATA_API_PORT')
const host = process.env.DATA_API_HOST?.trim() || '0.0.0.0'

const client = createClickHouseClient()
const app = await buildDataApp({ client })

app.addHook('onClose', async () => {
  stopUsageFlush()
  // Final usage flush so a deploy loses no metered requests; best-effort — the
  // schema's replace-by-running-total makes a lost final flush cost at most
  // one interval.
  await flushUsage().catch(() => {})
  stopExplorerAssetsRefresh()
  await client.close()
})

async function start(): Promise<void> {
  try {
    // Every timestamp on this surface is produced by appending 'Z' to a
    // ClickHouse DateTime string (iso() in data/schemas/common.ts), which is
    // only correct while the session timezone is UTC — same boot assert as the
    // public service.
    const tzRes = await client.query({ query: 'SELECT timezone() AS tz', format: 'JSONEachRow' })
    const [{ tz }] = await tzRes.json<{ tz: string }>()
    if (tz !== 'UTC') {
      app.log.error(
        `[data-api] ClickHouse session timezone is '${tz}', not 'UTC'. iso() in data/schemas/common.ts treats DateTime strings as UTC and would publish shifted timestamps.`,
      )
      process.exit(1)
    }
    // /v1/assets serves the shared registry snapshot from memory; load it
    // before accepting traffic (it refreshes itself every 5 minutes).
    await loadExplorerAssets(client)
    startUsageFlush()
    await app.listen({ port, host })
    console.log(`[data-api] Server listening on ${host}:${port}`)
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
