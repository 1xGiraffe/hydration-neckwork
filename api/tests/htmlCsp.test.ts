import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { API_HTML_CSP, registerHtmlCsp } from '../src/routes/htmlCsp.ts'

// The api's HTML (the page-head renderer's app shell) never leaves without a CSP,
// even when a client reaches it around the explorer's page locations.
describe('the api HTML CSP', () => {
  it('stamps HTML replies and leaves JSON and an explicit policy alone', async () => {
    const app = Fastify()
    registerHtmlCsp(app)
    app.get('/page', async (_req, reply) => reply.type('text/html; charset=utf-8').send('<html></html>'))
    app.get('/json', async () => ({ ok: true }))
    app.get('/own', async (_req, reply) => reply.type('text/html').header('content-security-policy', "default-src 'self'").send('<p>'))
    expect((await app.inject({ url: '/page' })).headers['content-security-policy']).toBe(API_HTML_CSP)
    expect((await app.inject({ url: '/json' })).headers['content-security-policy']).toBeUndefined()
    expect((await app.inject({ url: '/own' })).headers['content-security-policy']).toBe("default-src 'self'")
  })
})
