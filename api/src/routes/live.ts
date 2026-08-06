import type { FastifyInstance } from 'fastify'
import { addLiveHeadClient, removeLiveHeadClient } from '../services/liveHeadService.ts'

// SSE stream of the ingested chain head. The reply is hijacked: fastify's
// serialization, compression and cache-control hooks must not touch a stream.
// `X-Accel-Buffering: no` switches off response buffering on every nginx hop
// in front of this container, so frames reach the browser as they are written.
export async function liveRoutes(fastify: FastifyInstance) {
  fastify.get('/explorer/live', (req, reply) => {
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    })
    res.write('retry: 3000\n\n')
    addLiveHeadClient(res)
    req.raw.on('close', () => removeLiveHeadClient(res))
  })
}
