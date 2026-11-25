import type { FastifyInstance } from 'fastify'
import { addLiveHeadClient, liveHeadStreamAvailable, removeLiveHeadClient } from '../services/liveHeadService.ts'

// SSE stream of the ingested chain head. The reply is hijacked: fastify's
// serialization, compression and cache-control hooks must not touch a stream.
// `X-Accel-Buffering: no` switches off response buffering on every nginx hop
// in front of this container, so frames reach the browser as they are written.
//
// Streams are capped per client address and in total (liveHeadService): past
// either cap the stream is refused with 429 before anything is hijacked, and the
// page polls instead. An admitted stream's slot is released on the first of the
// request's close, the response's close or a response error, and at once when the
// connection was already gone by the time the stream was admitted.
export async function liveRoutes(fastify: FastifyInstance) {
  fastify.get('/explorer/live', (req, reply) => {
    const client = req.ip ?? ''
    if (!liveHeadStreamAvailable(client)) {
      return reply.code(429).header('cache-control', 'no-store').header('retry-after', '60')
        .send({ error: 'Too many live streams' })
    }
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    })
    res.write('retry: 3000\n\n')
    if (!addLiveHeadClient(res, client)) { res.end(); return }
    const release = () => removeLiveHeadClient(res)
    req.raw.once('close', release)
    res.once('close', release)
    res.on('error', release)
    if (res.destroyed || req.raw.socket?.destroyed) release()
  })
}
