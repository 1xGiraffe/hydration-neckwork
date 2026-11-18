import type { FastifyInstance } from 'fastify'

// Every HTML reply carries a CSP of its own. The explorer's and Preis's page
// locations hide it and apply their server's policy (explorer-ui/seo_page.conf,
// preis-ui/preis_seo.conf), so this one governs only a client that reaches the
// api's HTML any other way — for which nothing on the page may run, load or be framed.
export const API_HTML_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data: https:; style-src 'unsafe-inline'"

export function registerHtmlCsp(fastify: FastifyInstance): void {
  fastify.addHook('onSend', async (_req, reply) => {
    if (String(reply.getHeader('content-type') ?? '').startsWith('text/html') && !reply.getHeader('content-security-policy')) {
      reply.header('content-security-policy', API_HTML_CSP)
    }
  })
}
