import { afterEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { liveRoutes } from '../src/routes/live.ts'
import { MAX_LIVE_STREAMS_PER_CLIENT, liveHeadClientCount, stopLiveHeadService } from '../src/services/liveHeadService.ts'

// The /explorer/live stream over a real socket: a hijacked SSE reply never ends,
// so it cannot be exercised through inject.

let app: FastifyInstance | null = null
const open: http.ClientRequest[] = []

afterEach(async () => {
  for (const req of open.splice(0)) req.destroy()
  stopLiveHeadService()
  await app?.close()
  app = null
})

async function start(): Promise<number> {
  // Trusting loopback lets a test name the client address through X-Forwarded-For.
  app = Fastify({ trustProxy: ['loopback'] })
  await app.register(liveRoutes)
  await app.listen({ port: 0, host: '127.0.0.1' })
  return (app.server.address() as AddressInfo).port
}

function connect(port: number, client: string): Promise<{ status: number; req: http.ClientRequest; body: Promise<string> }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/explorer/live', headers: { 'x-forwarded-for': client } }, res => {
      let text = ''
      res.setEncoding('utf8')
      const body = new Promise<string>(done => {
        res.on('data', chunk => { text += chunk; if ((res.statusCode ?? 0) === 200) done(text) })
        res.on('end', () => done(text))
      })
      resolve({ status: res.statusCode ?? 0, req, body })
    })
    req.on('error', reject)
    open.push(req)
  })
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise(r => setTimeout(r, 5))
  expect(check()).toBe(true)
}

describe('/explorer/live', () => {
  it('streams to a client within its cap and refuses the next one with 429', async () => {
    const port = await start()
    const admitted = []
    for (let i = 0; i < MAX_LIVE_STREAMS_PER_CLIENT; i += 1) admitted.push(await connect(port, '192.0.2.1'))
    for (const s of admitted) {
      expect(s.status).toBe(200)
      expect(await s.body).toContain('retry: 3000')
    }
    expect(liveHeadClientCount('192.0.2.1')).toBe(MAX_LIVE_STREAMS_PER_CLIENT)

    const refused = await connect(port, '192.0.2.1')
    expect(refused.status).toBe(429)
    expect(JSON.parse(await refused.body)).toEqual({ error: 'Too many live streams' })

    // Another address still gets its own stream.
    expect((await connect(port, '192.0.2.2')).status).toBe(200)
  })

  it('releases a slot when the client disconnects', async () => {
    const port = await start()
    const first = await connect(port, '192.0.2.1')
    expect(first.status).toBe(200)
    expect(liveHeadClientCount('192.0.2.1')).toBe(1)
    first.req.destroy()
    await until(() => liveHeadClientCount('192.0.2.1') === 0)
    expect(liveHeadClientCount()).toBe(0)
  })
})
