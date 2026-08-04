import { beforeEach, describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { collapseDuplicateSlashes, jobResponse, SOURCIFY_PREFIXES, verificationRoutes } from '../src/routes/verification.ts'
import { toMatchLevel, type JobState } from '../src/services/contractVerificationService.ts'

// Hoisted mocks for the service functions the routes call; everything else in
// the module (toMatchLevel, isH160, …) stays real via the spread.
const mocks = vi.hoisted(() => ({
  getVerifiedContract: vi.fn(),
  submitVerification: vi.fn(),
  getJob: vi.fn(),
}))
vi.mock('../src/services/contractVerificationService.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/contractVerificationService.ts')>()
  return { ...actual, ...mocks }
})

beforeEach(() => {
  mocks.getVerifiedContract.mockReset().mockResolvedValue(null)
  mocks.submitVerification.mockReset().mockResolvedValue({ ok: true, verificationId: 'id' })
  mocks.getJob.mockReset().mockResolvedValue(null)
})

// These assertions encode wire rules observed by running forge 1.5.1 and
// hardhat-verify 3.x against a recording proxy (mrq1911's sourcify-verification
// branch). Each one, if broken, fails silently in a way that looks like a
// client bug rather than a server bug — hence the coverage.

function job(over: Partial<JobState> = {}): JobState {
  return {
    verificationId: 'job-1',
    address: '0x531a654d1696ed52e7275a8cede955e82620f99a',
    chainId: '222222',
    status: 'pending',
    matchType: '',
    contractIdentifier: 'src/Store.sol:Store',
    compilerVersion: '0.8.10+commit.fc410830',
    errorCode: '',
    errorMessage: '',
    deployedBytecode: '0x6080604052',
    submittedAt: new Date('2026-08-02T10:00:00Z'),
    completedAt: null,
    ...over,
  }
}

describe('toMatchLevel', () => {
  it('maps the verifier vocabulary onto Sourcify V2 levels', () => {
    // Sourcify renamed these: perfect -> exact_match, partial -> match.
    expect(toMatchLevel('FULL')).toBe('exact_match')
    expect(toMatchLevel('PARTIAL')).toBe('match')
    expect(toMatchLevel('')).toBeNull()
  })
})

describe('jobResponse', () => {
  it('always includes contract and jobStartTime', () => {
    // forge's deserializer treats `contract` as non-optional and hardhat's type
    // guard additionally requires `jobStartTime`. Omitting either turns a clean
    // failure into ~2 minutes of parse-error retries (forge) or an unretried
    // unexpected-response error (hardhat).
    for (const state of [job(), job({ status: 'verified', matchType: 'FULL', completedAt: new Date() })]) {
      const res = jobResponse(state)
      expect(res.contract).toBeDefined()
      expect(typeof res.jobStartTime).toBe('string')
      expect(res.verificationId).toBe('job-1')
    }
  })

  it('reports a pending job as not completed and with a null match', () => {
    const res = jobResponse(job())
    expect(res.isJobCompleted).toBe(false)
    expect(res.contract.match).toBeNull()
    expect('error' in res).toBe(false)
  })

  it('reports a full match as exact_match', () => {
    const res = jobResponse(job({ status: 'verified', matchType: 'FULL', completedAt: new Date('2026-08-02T10:00:05Z') }))
    expect(res.isJobCompleted).toBe(true)
    expect(res.contract.match).toBe('exact_match')
    expect(res.contract.runtimeMatch).toBe('exact_match')
    expect('error' in res).toBe(false)
  })

  it('reports a metadata-only mismatch as a successful partial match, not a failure', () => {
    // Foundry's `bytecode_hash = "none"` always lands here, so PARTIAL must not
    // be surfaced as a verification failure.
    const res = jobResponse(job({ status: 'verified', matchType: 'PARTIAL', completedAt: new Date() }))
    expect(res.contract.match).toBe('match')
    expect('error' in res).toBe(false)
  })

  it('never emits a completed job with a null match and no error', () => {
    // This exact combination is a silent false pass: forge exits 0 printing
    // nothing, and hardhat throws an unexpected-response error.
    const res = jobResponse(job({ status: 'failed', completedAt: new Date(), errorCode: 'no_match', errorMessage: 'bytecode mismatch' }))
    expect(res.isJobCompleted).toBe(true)
    expect(res.contract.match).toBeNull()
    expect(res.error).toBeDefined()
  })

  it('gives every error object customCode, message and errorId', () => {
    // hardhat's error type guard requires all three; without errorId it misses
    // the clean-failure branch entirely.
    const res = jobResponse(job({ status: 'failed', completedAt: new Date(), errorCode: 'no_match', errorMessage: 'nope' }))
    expect(res.error).toMatchObject({ customCode: 'no_match', message: 'nope' })
    expect(typeof res.error?.errorId).toBe('string')
    expect(res.error?.errorId.length).toBeGreaterThan(0)
  })

  it('falls back to a usable error code and message when the job carries neither', () => {
    const res = jobResponse(job({ status: 'failed', completedAt: new Date() }))
    expect(res.error?.customCode).toBe('no_match')
    expect(res.error?.message).toBeTruthy()
  })

  it('never claims a creation-input match, since only runtime bytecode is compared', () => {
    const res = jobResponse(job({ status: 'verified', matchType: 'FULL', completedAt: new Date() }))
    expect(res.contract.creationMatch).toBeNull()
  })
})

describe('collapseDuplicateSlashes', () => {
  it('collapses a doubled leading slash so //v2 routes as /v2', () => {
    // What a hardhat user gets once nginx strips `/api/` from `/api//v2/...`.
    expect(collapseDuplicateSlashes('//v2/verify/222222/0xabc')).toBe('/v2/verify/222222/0xabc')
  })
  it('leaves ordinary paths untouched', () => {
    expect(collapseDuplicateSlashes('/v2/contract/222222/0xabc')).toBe('/v2/contract/222222/0xabc')
    expect(collapseDuplicateSlashes('/explorer/counts')).toBe('/explorer/counts')
  })
  it('does not collapse an interior double slash', () => {
    // Only the leading segment is ambiguous; an interior `//` is a real path.
    expect(collapseDuplicateSlashes('/v2/verify//x')).toBe('/v2/verify//x')
  })
})

describe('SOURCIFY_PREFIXES', () => {
  it('covers every base-URL shape forge and hardhat can produce', () => {
    // forge appends `v2/...` with no separator; hardhat appends `/v2/...`. So a
    // base of `.../api` fuses into `/apiv2`, and `.../api/` yields `/api/v2`.
    expect(SOURCIFY_PREFIXES).toContain('/v2')
    expect(SOURCIFY_PREFIXES).toContain('/apiv2')
    expect(SOURCIFY_PREFIXES).toContain('/api/v2')
  })
})

// Route-level wire shapes, with the verification service mocked out.
const ADDRESS = '0x531a654d1696ed52e7275a8cede955e82620f99a'

async function buildApp(over: {
  getVerifiedContract?: (address: string) => unknown
  submitVerification?: (input: unknown) => unknown
  getJob?: (id: string) => unknown
} = {}) {
  if (over.getVerifiedContract) mocks.getVerifiedContract.mockImplementation(over.getVerifiedContract)
  if (over.submitVerification) mocks.submitVerification.mockImplementation(over.submitVerification)
  if (over.getJob) mocks.getJob.mockImplementation(over.getJob)
  const app = Fastify({ rewriteUrl: req => collapseDuplicateSlashes(req.url ?? '/') })
  await app.register(verificationRoutes)
  return app
}

const validBody = {
  stdJsonInput: { language: 'Solidity', sources: { 'src/Store.sol': { content: 'contract Store {}' } } },
  compilerVersion: '0.8.10+commit.fc410830',
  contractIdentifier: 'src/Store.sol:Store',
}

describe('sourcify V2 route shapes', () => {
  it('answers an unverified probe with a CONTRACT-shaped 404, not an error envelope', async () => {
    const app = await buildApp({})
    const res = await app.inject(`/v2/contract/222222/${ADDRESS}`)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ match: null, creationMatch: null, runtimeMatch: null, chainId: '222222', address: ADDRESS })
    await app.close()
  })

  it('answers a verified probe with the match levels', async () => {
    const app = await buildApp({
      getVerifiedContract: vi.fn().mockResolvedValue({ address: ADDRESS, matchType: 'FULL', contractName: 'Store', compilerVersion: '', abi: '[]' }),
    })
    const res = await app.inject(`/v2/contract/1/${ADDRESS}`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ match: 'exact_match', runtimeMatch: 'exact_match', creationMatch: null })
    await app.close()
  })

  it('accepts a submit with 202 and a verificationId — 200/201 are hard errors in forge', async () => {
    const submitVerification = vi.fn().mockResolvedValue({ ok: true, verificationId: 'abc-123' })
    const app = await buildApp({ submitVerification })
    // The path chainId is deliberately ignored: unconfigured forge sends 1.
    const res = await app.inject({ method: 'POST', url: `/v2/verify/1/${ADDRESS}`, payload: validBody })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ verificationId: 'abc-123' })
    await app.close()
  })

  it('rejects a malformed submit body with a complete sourcify error envelope', async () => {
    const app = await buildApp({})
    const res = await app.inject({ method: 'POST', url: `/v2/verify/222222/${ADDRESS}`, payload: { compilerVersion: 'x' } })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.customCode).toBe('invalid_parameter')
    expect(typeof body.message).toBe('string')
    expect(typeof body.errorId).toBe('string')
    await app.close()
  })

  it('maps already_verified to 409 and cannot_fetch_bytecode to 404', async () => {
    const app = await buildApp({
      submitVerification: vi.fn()
        .mockResolvedValueOnce({ ok: false, code: 'already_verified', message: 'already verified' })
        .mockResolvedValueOnce({ ok: false, code: 'cannot_fetch_bytecode', message: 'no code' }),
    })
    const first = await app.inject({ method: 'POST', url: `/v2/verify/222222/${ADDRESS}`, payload: validBody })
    expect(first.statusCode).toBe(409)
    const second = await app.inject({ method: 'POST', url: `/v2/verify/222222/${ADDRESS}`, payload: validBody })
    expect(second.statusCode).toBe(404)
    await app.close()
  })

  it('polls a failed job as 200 with an error, and an unknown id as a 404 error envelope', async () => {
    const app = await buildApp({
      getJob: vi.fn(async (id: string) =>
        id === 'known' ? job({ verificationId: 'known', status: 'failed', completedAt: new Date(), errorCode: 'no_match', errorMessage: 'mismatch' }) : null),
    })
    const known = await app.inject('/v2/verify/known')
    expect(known.statusCode).toBe(200)
    expect(known.json().error.customCode).toBe('no_match')
    const unknown = await app.inject('/v2/verify/unknown')
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toMatchObject({ customCode: 'job_not_found' })
    expect(typeof unknown.json().errorId).toBe('string')
    await app.close()
  })

  it('serves the same handlers under every prefix forge and hardhat can compose', async () => {
    const app = await buildApp({})
    for (const prefix of ['/v2', '/apiv2', '/api/v2', '/api/apiv2']) {
      const res = await app.inject(`${prefix}/contract/222222/${ADDRESS}`)
      expect(res.statusCode, prefix).toBe(404)
      expect(res.json().match, prefix).toBeNull()
    }
    // The doubled leading slash a hardhat user gets through nginx.
    const doubled = await app.inject(`//v2/contract/222222/${ADDRESS}`)
    expect(doubled.statusCode).toBe(404)
    expect(doubled.json().match).toBeNull()
    await app.close()
  })

  it('rejects a malformed address on both probe and submit', async () => {
    const app = await buildApp({})
    const probe = await app.inject('/v2/contract/222222/not-an-address')
    expect(probe.statusCode).toBe(400)
    expect(probe.json().customCode).toBe('invalid_parameter')
    const submit = await app.inject({ method: 'POST', url: '/v2/verify/222222/0x123', payload: validBody })
    expect(submit.statusCode).toBe(400)
    await app.close()
  })

  it('rate-limits repeated submits but never the probe or poll', async () => {
    const submitVerification = vi.fn().mockResolvedValue({ ok: true, verificationId: 'id' })
    const app = await buildApp({ submitVerification })
    const statuses: number[] = []
    for (let i = 0; i < 15; i++) {
      const res = await app.inject({ method: 'POST', url: `/v2/verify/222222/${ADDRESS}`, payload: validBody })
      statuses.push(res.statusCode)
    }
    expect(statuses).toContain(429)
    // forge polls every few seconds for up to ~2 minutes — polls must not 429.
    for (let i = 0; i < 30; i++) {
      const res = await app.inject('/v2/verify/some-id')
      expect(res.statusCode).toBe(404)
    }
    const probe = await app.inject(`/v2/contract/222222/${ADDRESS}`)
    expect(probe.statusCode).toBe(404)
    await app.close()
  })
})
