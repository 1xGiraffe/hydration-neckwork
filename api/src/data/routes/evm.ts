import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import {
  errorEnvelope, feedPage, requirePositionCursor,
  zBlock, zCursor, zError, zFeedPage, zIsoTimestamp, zLimit, zOrder, zTimeParam,
} from '../schemas/common.ts'
import { liveHeadTag, notFoundContext } from '../services/head.ts'
import { contractAbi, contractDetail, contractLogs, evmTransactionByHash } from '../services/evmData.ts'

const TX_HASH_RE = /^0x[0-9a-f]{64}$/
const H160_RE = /^0x[0-9a-f]{40}$/
const TOPIC_RE = /^0x[0-9a-f]{64}$/

const zTxHash = z.string().toLowerCase().regex(TX_HASH_RE, 'expected a 0x-prefixed 32-byte transaction hash')
const zH160 = z.string().toLowerCase().regex(H160_RE, 'expected a 0x-prefixed 20-byte contract address')

const zEvmTransaction = z.object({
  txHash: z.string(),
  blockHeight: z.number().int(),
  extrinsicIndex: z.number().int().nullable(),
  extrinsicHash: z.string().nullable().describe('Hash of the carrying extrinsic; null for a block-hook row.'),
  eventIndex: z.number().int(),
  timestamp: zIsoTimestamp,
  from: z.string().describe('H160.'),
  to: z.string().describe('H160 — the created contract for a CREATE transaction.'),
  success: z.boolean(),
  exitKind: z.string().describe('The EVM exit reason as the node reported it: Succeed, Error or Revert.'),
  exitDetail: z.string().nullable(),
  extraData: z.string().nullable().describe('Returned revert data, when any.'),
})

const zLogStats = z.object({
  count: z.number().int().describe('Exact distinct log count (replay-safe bitmap identity).'),
  firstBlock: z.number().int(),
  lastBlock: z.number().int(),
  firstTime: zIsoTimestamp,
  lastTime: zIsoTimestamp,
})

const zContractDetail = z.object({
  address: z.string(),
  kind: z.string().describe('Registry kind: contract, asset-erc20, oracle-adapter, system-precompile, ….'),
  codeHash: z.string(),
  codeSize: z.number().int(),
  destroyed: z.boolean(),
  verified: z.boolean(),
  contractName: z.string().nullable(),
  compilerVersion: z.string().nullable(),
  matchType: z.string().nullable().describe('FULL or PARTIAL for a verified contract.'),
  abiSource: z.string().nullable().describe('How the ABI got here: verified, import:blockscout, or manual.'),
  logs: zLogStats.nullable().describe('Null for a contract that has never emitted a log.'),
})

const zLogItem = z.object({
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  extrinsicIndex: z.number().int().nullable(),
  extrinsicHash: z.string().nullable().describe('Hash of the carrying extrinsic; null for a block-hook row.'),
  timestamp: zIsoTimestamp,
  topics: z.array(z.string()),
  data: z.string(),
  decoded: z.object({
    name: z.string(),
    signature: z.string(),
    args: z.unknown(),
  }).nullable().describe('Present when the indexer decoded the log against a known ABI.'),
})

const zSourceFile = z.object({
  path: z.string(),
  content: z.string(),
  evmVersion: z.string().nullable(),
  optimizerEnabled: z.boolean(),
  optimizerRuns: z.number().int(),
  constructorArguments: z.string().nullable(),
})

const zAbiDetail = z.object({
  address: z.string(),
  abi: z.unknown(),
  contractName: z.string().nullable(),
  compilerVersion: z.string().nullable(),
  source: z.string(),
  matchType: z.string().nullable(),
  codeHash: z.string().nullable().describe('The registry code hash at verification time — a redeploy at the same address makes a mismatch visible instead of mislabelling new code.'),
  sources: z.array(zSourceFile),
})

export const evmRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/evm/transactions/:txHash', {
    schema: {
      tags: ['evm'],
      summary: 'One EVM transaction by hash',
      description: 'A point read on the hash-first transaction projection, covering the full chain history. Only finalized, indexed transactions appear — a pending or dropped transaction is a 404 with the indexed head in context.',
      params: z.object({ txHash: zTxHash }),
      response: { 200: zEvmTransaction, 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const { txHash } = request.params
    const found = await cached(`data:evm:tx:${txHash}`, 10_000, () => evmTransactionByHash(opts.client, txHash))
    if (!found) {
      return reply.code(404).send(errorEnvelope('not_found', `no EVM transaction ${txHash} indexed`,
        await notFoundContext(opts.client, { hint: 'only finalized, indexed transactions appear; if this one is newer than indexedHead it has not been ingested yet' })))
    }
    return found
  })

  app.get('/v1/evm/contracts/:address', {
    schema: {
      tags: ['evm'],
      summary: 'One contract: registry identity, verification, log stats',
      description: 'The chain-state code registry entry (kind, code hash/size, destroyed flag), the verification identity when the contract is verified, and exact lifetime log statistics. 404 for an address the registry does not know.',
      params: z.object({ address: zH160 }),
      response: { 200: zContractDetail, 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const { address } = request.params
    const found = await cached(`data:evm:contract:${address}`, 60_000, () => contractDetail(opts.client, address))
    if (!found) {
      return reply.code(404).send(errorEnvelope('not_found', `no contract ${address} in the code registry`,
        await notFoundContext(opts.client, { hint: 'the registry snapshots EVM.AccountCodes; an address with no code is not a contract' })))
    }
    return found
  })

  app.get('/v1/evm/contracts/:address/logs', {
    schema: {
      tags: ['evm'],
      summary: 'One contract’s logs, newest first',
      description: 'Cursor-paginated over a contract-first log index; each page is then enriched with topics, data and the decoded form (when the indexer knows the ABI) by a primary-key read — so a deep page costs the same as the first. `topic0=` filters by event signature hash.',
      params: z.object({ address: zH160 }),
      querystring: z.object({
        limit: zLimit,
        cursor: zCursor,
        order: zOrder,
        topic0: z.string().toLowerCase().regex(TOPIC_RE, 'expected a 0x-prefixed 32-byte topic hash').optional(),
        fromBlock: zBlock.optional(),
        toBlock: zBlock.optional(),
        fromTime: zTimeParam.optional(),
        toTime: zTimeParam.optional(),
      }),
      response: { 200: zFeedPage(zLogItem), 400: zError },
    },
  }, async request => {
    const { address } = request.params
    const { limit, order, topic0, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const head = await liveHeadTag(opts.client)
    const key = `data:evm:logs:${address}:${order}:${topic0 ?? ''}:${fromBlock ?? ''}:${toBlock ?? ''}:${fromTime ?? ''}:${toTime ?? ''}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 5_000, () => contractLogs(opts.client, address, {
      limit, order, topic0, cursor, fromBlock, toBlock, fromTime, toTime,
    }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.eventIndex }))
  })

  app.get('/v1/evm/contracts/:address/abi', {
    schema: {
      tags: ['evm'],
      summary: 'A verified contract’s ABI and source files',
      description: 'The verified ABI plus every source file of the newest verification. Verification artifacts are public by design — anyone may verify a contract and everyone may read the result. 404 for a contract with no ABI on record.',
      params: z.object({ address: zH160 }),
      response: { 200: zAbiDetail, 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const { address } = request.params
    const found = await cached(`data:evm:abi:${address}`, 60_000, () => contractAbi(opts.client, address))
    if (!found) {
      return reply.code(404).send(errorEnvelope('not_found', `no verified ABI for ${address}`,
        await notFoundContext(opts.client, { hint: 'contract metadata (including whether it is verified) lives at /v1/evm/contracts/{address}' })))
    }
    return found
  })
}
