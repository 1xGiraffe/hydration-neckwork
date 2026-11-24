import { createServer } from 'node:http'
import { FETCHER_PORT, fetcherHandler } from '../governance/subsquare/imageFetcher.js'

// The `governance-image-fetcher` service (docker-compose.yml): the SSRF-guarded fetch of
// imported images, isolated on a network that reaches the internet and no other service.
// See src/governance/subsquare/imageFetcher.ts.

const server = createServer(fetcherHandler())
server.requestTimeout = 45_000
server.headersTimeout = 10_000
server.listen(FETCHER_PORT, '0.0.0.0', () => console.log(`[image-fetcher] listening on :${FETCHER_PORT}`))
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(() => process.exit(0)))
