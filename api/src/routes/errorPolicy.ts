import { STATUS_CODES } from 'node:http'
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify'

// What an unexpected server fault tells the client. Fastify's default handler
// answers a 5xx with the error's own message, and a ClickHouse or transport error's
// message can name hosts, ports, versions, tables and the SQL that failed — none of
// which is part of the API. So an unexpected 5xx is logged in full and answered in
// Fastify's usual shape with a generic message.
//
// Everything else keeps the default handler's answer unchanged: a 4xx (validation,
// body size, rate limit) is the caller's problem and its message is how they fix
// it, and a 5xx this code raised on purpose — an error carrying its own statusCode
// and code, such as the activity read path's 503 ACTIVITY_QUERY_TOO_BROAD — is a
// documented refusal that the explorer UI and the MCP server read by its code and
// message. Fastify's own FST_* errors are internal and count as unexpected.

/** The status the default error handler would answer with (lib/error-handler.js). */
export function errorStatus(err: ServerError, reply: FastifyReply): number {
  return declaredStatus(err) ?? (reply.statusCode >= 400 ? reply.statusCode : 500)
}

/** Whether a 5xx was raised deliberately, with a status and code of its own. */
export function isDeliberateServerError(err: ServerError): boolean {
  const declared = declaredStatus(err)
  return declared != null && declared >= 500 && typeof err.code === 'string' && !err.code.startsWith('FST_')
}

type ServerError = FastifyError & { status?: number }

function declaredStatus(err: ServerError): number | undefined {
  if (err.status != null && err.status >= 400) return err.status
  if (err.statusCode != null && err.statusCode >= 400) return err.statusCode
  return undefined
}

export function registerErrorPolicy(fastify: FastifyInstance): void {
  fastify.setErrorHandler((err: ServerError, req, reply) => {
    const status = errorStatus(err, reply)
    // Thrown from an error handler, the error goes on to Fastify's default one,
    // which answers exactly as it would have without this handler.
    if (status < 500 || isDeliberateServerError(err)) throw err
    req.log.error({ err }, 'request failed')
    const error = STATUS_CODES[status] ?? 'Internal Server Error'
    reply.code(status).send({ statusCode: status, error, message: error })
  })
}
