import { describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Writable } from 'node:stream'
import { registerErrorPolicy } from '../src/routes/errorPolicy.ts'

// The explorer api's error replies: an unexpected 5xx says nothing about the
// internals that failed (the detail stays in the log), while every answer a client
// reads on purpose — a 4xx, a deliberate 5xx refusal — is exactly what Fastify's
// default handler gives.

const INTERNAL = 'Code: 60. DB::Exception: Unknown table price_data.secret_table (clickhouse:8123, version 24.8) SELECT * FROM price_data.secret_table'

function routes(app: FastifyInstance): void {
  app.get('/internal', async () => { throw new Error(INTERNAL) })
  app.get('/internal-coded', async () => { throw Object.assign(new Error(INTERNAL), { code: '60' }) })
  app.get('/after-status', async (_req, reply) => { reply.code(502); throw new Error(INTERNAL) })
  app.get('/fastify-500', async () => { throw Object.assign(new Error(INTERNAL), { statusCode: 500, code: 'FST_ERR_SOMETHING' }) })
  app.get('/too-broad', async () => {
    throw Object.assign(new Error('Requested activity page requires too many candidate rows; narrow the filters or date range'), {
      code: 'ACTIVITY_QUERY_TOO_BROAD', statusCode: 503,
    })
  })
  app.get('/validated', { schema: { querystring: { type: 'object', properties: { n: { type: 'integer' } } } } }, async () => ({ ok: true }))
  app.get('/teapot', async () => { throw Object.assign(new Error('pick a different pot'), { statusCode: 418 }) })
  app.get('/declared-404', async (_req, reply) => { reply.code(404); throw new Error('nothing at that height') })
  app.post('/body', async req => req.body)
}

async function build(policy: boolean, logs: string[] = []): Promise<FastifyInstance> {
  const stream = new Writable({ write(chunk, _enc, done) { logs.push(String(chunk)); done() } })
  const app = Fastify({ logger: { level: 'info', stream } })
  if (policy) registerErrorPolicy(app)
  await app.register(async scoped => routes(scoped))
  await app.ready()
  return app
}

describe('explorer api error policy', () => {
  it.each(['/internal', '/internal-coded', '/fastify-500'])('answers an unexpected 500 (%s) generically and logs the detail', async url => {
    const logs: string[] = []
    const app = await build(true, logs)
    const res = await app.inject(url)
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' })
    expect(res.body).not.toContain('secret_table')
    expect(res.body).not.toContain('8123')
    expect(logs.join('')).toContain('secret_table')
  })

  it('keeps a status the handler set before failing, without the detail', async () => {
    const app = await build(true)
    const res = await app.inject('/after-status')
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ statusCode: 502, error: 'Bad Gateway', message: 'Bad Gateway' })
  })

  it('passes a deliberate 5xx refusal through with its code and message', async () => {
    const [withPolicy, without] = await Promise.all([build(true), build(false)])
    const res = await withPolicy.inject('/too-broad')
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ code: 'ACTIVITY_QUERY_TOO_BROAD', message: expect.stringContaining('narrow the filters') })
    expect(res.json()).toEqual((await without.inject('/too-broad')).json())
  })

  it.each([
    ['GET', '/validated?n=abc', undefined],
    ['GET', '/teapot', undefined],
    ['GET', '/declared-404', undefined],
    ['POST', '/body', '{not json'],
  ] as const)('answers a 4xx (%s %s) exactly as the default handler does', async (method, url, payload) => {
    const [withPolicy, without] = await Promise.all([build(true), build(false)])
    const request = { method, url, payload, headers: payload ? { 'content-type': 'application/json' } : {} }
    const res = await withPolicy.inject(request)
    const expected = await without.inject(request)
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.statusCode).toBeLessThan(500)
    expect(res.statusCode).toBe(expected.statusCode)
    expect(res.body).toBe(expected.body)
  })
})
