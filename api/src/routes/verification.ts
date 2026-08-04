import { randomUUID } from 'node:crypto'
import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { z } from 'zod'
import {
  CHAIN_ID,
  getJob,
  getVerifiedContract,
  isH160,
  normalizeAddressParam,
  submitVerification,
  toMatchLevel,
  type JobState,
} from '../services/contractVerificationService.ts'

// Sourcify V2 verification API. Three endpoints, which is the whole surface
// `forge verify-contract` and `hardhat verify` need:
//
//   GET  {base}v2/contract/{chainId}/{address}   already-verified probe
//   POST {base}v2/verify/{chainId}/{address}     submit  -> 202 {verificationId}
//   GET  {base}v2/verify/{verificationId}        job poll
//
// Sourcify is Foundry's DEFAULT verifier, and for chain 222222 it is the
// unconditional default: forge only prefers Etherscan when a key resolves for
// that specific chain, and 222222 resolves to none. So this surface — not the
// Etherscan-compatible one — is what a bare `forge verify-contract` reaches.
//
// Every response shape below is load-bearing. The rules were established by
// running forge 1.5.1 and hardhat-verify 3.x against a recording proxy
// (mrq1911's sourcify-verification branch, adopted as-is per the spec).

const submitBody = z.object({
  stdJsonInput: z.object({ language: z.string(), sources: z.record(z.string(), z.unknown()) }).loose(),
  compilerVersion: z.string().min(1).max(120),
  contractIdentifier: z.string().min(1).max(512),
  creationTransactionHash: z.string().optional(),
})

// Errors are a uniform {customCode, message, errorId}. hardhat requires all
// three — without `errorId` it misses the already-verified and clean-failure
// branches and reports a generic transport error instead. forge reads only the
// first two.
function sourcifyError(customCode: string, message: string) {
  return { customCode, message, errorId: randomUUID() }
}

// The 404 on a lookup must be CONTRACT-shaped, not an error envelope: hardhat
// catches the 404 and needs these five keys to conclude "not verified". An error
// body there makes it abort the whole verification. forge tolerates either.
function unverifiedLookup(chainId: string, address: string) {
  return { match: null, creationMatch: null, runtimeMatch: null, chainId, address }
}

export function jobResponse(job: JobState) {
  const match = toMatchLevel(job.matchType)
  return {
    isJobCompleted: job.status !== 'pending',
    verificationId: job.verificationId,
    // hardhat's type guard requires `jobStartTime` as well as `contract`;
    // omitting either is a hard, unretried failure there.
    jobStartTime: job.submittedAt.toISOString(),
    ...(job.completedAt ? { jobFinishTime: job.completedAt.toISOString() } : {}),
    // `contract` is NON-optional in forge's deserializer. Returning only `error`
    // costs ~2 minutes of "Failed to parse job response" retries instead of a
    // failure, so it is always present — with nulls when there is no match.
    contract: {
      match,
      // We verify against deployed (runtime) bytecode only, so a creation-input
      // match is never claimed.
      creationMatch: null,
      runtimeMatch: match,
      chainId: job.chainId,
      address: job.address,
      ...(job.completedAt && match ? { verifiedAt: job.completedAt.toISOString() } : {}),
    },
    // A null match with no `error` is a silent false pass: forge exits 0 with no
    // output at all, and hardhat throws an unexpected-response error. So
    // whenever a completed job has no match, an error must accompany it.
    ...(job.status === 'failed'
      ? { error: sourcifyError(job.errorCode || 'no_match', job.errorMessage || 'Verification failed') }
      : {}),
  }
}

// Paths are relative so the same handlers can be mounted under every prefix the
// two tools can produce (see `verificationRoutes`).
async function sourcifyV2(fastify: FastifyInstance) {
  const pathParams = z.object({ chainId: z.string().max(32), address: z.string() })

  // --- already-verified probe -------------------------------------------
  //
  // Must always be reachable: a TRANSPORT error here (as opposed to an HTTP
  // error) aborts forge's whole run before it ever submits.
  fastify.get('/contract/:chainId/:address', async (req, reply) => {
    const params = pathParams.safeParse(req.params)
    if (!params.success) return reply.status(400).send(sourcifyError('invalid_parameter', 'Malformed request path'))

    const address = normalizeAddressParam(params.data.address)
    if (!isH160(address)) {
      return reply.status(400).send(sourcifyError('invalid_parameter', 'Address must be a 20-byte hex string'))
    }

    const verified = await getVerifiedContract(address)
    if (!verified) return reply.status(404).send(unverifiedLookup(CHAIN_ID, params.data.address))

    const match = toMatchLevel(verified.matchType)
    return reply.send({
      match,
      creationMatch: null,
      runtimeMatch: match,
      chainId: CHAIN_ID,
      address: params.data.address,
    })
  })

  // --- submit -----------------------------------------------------------
  //
  // 202 is mandatory. A 200 or 201 here is a hard error in forge, and because
  // the bail sits inside its retry loop a wrong status costs `--retries`
  // duplicate compiles rather than one clean failure.
  //
  // Rate-limited: each accepted submit costs the verifier a full compile. The
  // probe and poll must never be limited — forge polls for up to ~2 minutes.
  fastify.post('/verify/:chainId/:address', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const params = pathParams.safeParse(req.params)
    if (!params.success) return reply.status(400).send(sourcifyError('invalid_parameter', 'Malformed request path'))

    const address = normalizeAddressParam(params.data.address)
    if (!isH160(address)) {
      return reply.status(400).send(sourcifyError('invalid_parameter', 'Address must be a 20-byte hex string'))
    }

    const body = submitBody.safeParse(req.body)
    if (!body.success) {
      return reply
        .status(400)
        .send(sourcifyError('invalid_parameter', 'Expected stdJsonInput, compilerVersion and contractIdentifier'))
    }
    if (!body.data.contractIdentifier.includes(':')) {
      return reply.status(400).send(sourcifyError('invalid_parameter', 'contractIdentifier must be path:ContractName'))
    }

    // The path chainId is deliberately ignored rather than validated: with
    // neither --chain nor an RPC configured, forge sends 1. Rejecting a mismatch
    // would break a bare `forge verify-contract` in an unconfigured project.
    const outcome = await submitVerification({
      address,
      chainId: CHAIN_ID,
      compilerVersion: body.data.compilerVersion,
      contractIdentifier: body.data.contractIdentifier,
      stdJsonInput: body.data.stdJsonInput,
    })

    if (!outcome.ok) {
      const status = outcome.code === 'already_verified' ? 409 : 404
      return reply.status(status).send(sourcifyError(outcome.code, outcome.message))
    }
    return reply.status(202).send({ verificationId: outcome.verificationId })
  })

  // --- job poll ---------------------------------------------------------
  //
  // 200 even for a failed job; 404 only for an id we have never seen.
  fastify.get('/verify/:verificationId', async (req, reply) => {
    const params = z.object({ verificationId: z.string().min(1).max(128) }).safeParse(req.params)
    if (!params.success) return reply.status(400).send(sourcifyError('invalid_parameter', 'Malformed verification id'))

    const job = await getJob(params.data.verificationId)
    if (!job) {
      return reply
        .status(404)
        .send(sourcifyError('job_not_found', `No verification job found for id ${params.data.verificationId}`))
    }
    return reply.send(jobResponse(job))
  })
}

// forge and hardhat build their Sourcify URLs incompatibly, and no single
// documented base string satisfies both:
//
//   forge:   `{base}v2/...`      — its default base ENDS in `/`
//   hardhat: `${apiUrl}/v2/...`  — its default base does NOT
//
// So a base of `https://host/api` gives forge the fused `/apiv2/...`, while
// `https://host/api/` gives hardhat `/api//v2/...`. Mounting all of these makes
// every documented and mistyped combination land on the same handlers. `/api/v2`
// covers a base of `.../api/` used directly against this service (the explorer
// nginx strips its own `/api/` prefix, so through that origin it arrives as
// `/v2/...`).
export const SOURCIFY_PREFIXES = ['/v2', '/apiv2', '/api/v2', '/api/apiv2'] as const

// Collapses repeated leading slashes so `//v2/...` — what a hardhat user gets
// once nginx strips `/api/` from `/api//v2/...` — routes as `/v2/...`. Must run
// BEFORE routing, so it is wired as Fastify's `rewriteUrl` rather than a hook.
export function collapseDuplicateSlashes(url: string): string {
  return url.startsWith('//') ? url.replace(/^\/+/, '/') : url
}

export async function verificationRoutes(fastify: FastifyInstance, _opts: FastifyPluginOptions) {
  // Scoped to this plugin's routes only; `global: false` means nothing is
  // limited unless a route opts in via its own config (the submit above).
  await fastify.register(rateLimit, { global: false })
  for (const prefix of SOURCIFY_PREFIXES) {
    await fastify.register(sourcifyV2, { prefix })
  }
}
