import { createClickHouseClient } from '../db/client.js'
import { hasFlag, integerOption } from '../util/cliArgs.js'
import { createSnapshotRpcClient, loadSnapshotRuntime } from './snapshotRuntime.js'
import { flattenDecodedCall, jsonSafeArgs, proposalsNeedingDecode } from '../governance/proposalCalls.js'

// Referendum proposal calls.
//
// A referendum names its proposal by HASH; the call itself lives in a preimage, as
// SCALE bytes in a Preimage.note_preimage extrinsic. Those bytes are meaningless
// without runtime metadata, which is why this runs in the indexer (it has a Runtime)
// rather than in the API (it does not) — the explorer would otherwise have nothing to
// show but a hash and a length.
//
// A hash IS its content, so a decoded proposal never needs revisiting: this fills in
// what is missing and then goes quiet. The runtime is loaded at the block the preimage
// was noted at, so a call is decoded against the metadata it was written for rather
// than against today's.
//
// Usage:
//   npx tsx src/scripts/decode-referendum-proposals.ts [--loop] [--dry-run]
//     [--max=200] [--cycle-minutes=30]

const dryRun = hasFlag('dry-run')
const loop = hasFlag('loop')
const max = integerOption('max', 200, { min: 1, max: 2_000, clamp: true })
const cycleMinutes = integerOption('cycle-minutes', 30, { min: 1, max: 1_440, clamp: true })

const client = createClickHouseClient()
const rpc = createSnapshotRpcClient()
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

interface ProposalRow {
  proposal_hash: string
  pallet: string
  call_name: string
  args_json: string
  byte_length: number
  noted_block: number
  decode_error: string
}

// Every proposal hash a referendum has named, paired with the block its preimage was
// noted at. Preimage.Noted carries the hash; the bytes sit on the same extrinsic.
async function loadWanted(): Promise<{ hash: string; notedBlock: number }[]> {
  const res = await client.query({
    query: `
      SELECT lower(JSONExtractString(n.args_json, 'hash')) AS hash, max(n.block_height) AS noted_block
      FROM price_data.raw_events n
      WHERE n.event_name = 'Preimage.Noted'
        AND lower(JSONExtractString(n.args_json, 'hash')) IN (
          SELECT DISTINCT lower(JSONExtractString(args_json, 'proposal', 'hash'))
          FROM price_data.raw_events
          WHERE event_name = 'Referenda.Submitted' AND JSONHas(args_json, 'proposal')
        )
      GROUP BY hash`,
    format: 'JSONEachRow',
  })
  return (await res.json<{ hash: string; noted_block: number }>())
    .filter(row => /^0x[0-9a-f]{64}$/.test(row.hash))
    .map(row => ({ hash: row.hash, notedBlock: Number(row.noted_block) }))
}

async function loadDecoded(): Promise<Set<string>> {
  const res = await client.query({
    query: `SELECT proposal_hash FROM price_data.referendum_proposals FINAL WHERE decode_error = ''`,
    format: 'JSONEachRow',
  })
  return new Set((await res.json<{ proposal_hash: string }>()).map(row => row.proposal_hash))
}

// The preimage bytes for one hash. Taken from the note_preimage call on the same
// extrinsic as the Noted event, which is where the runtime put them.
async function loadPreimageBytes(hash: string): Promise<{ bytes: string; block: number } | null> {
  const res = await client.query({
    query: `
      SELECT c.block_height AS block, JSONExtractString(c.args_json, 'bytes') AS bytes
      FROM price_data.raw_calls c
      WHERE c.call_name = 'Preimage.note_preimage'
        AND (c.block_height, c.extrinsic_index) IN (
          SELECT block_height, extrinsic_index FROM price_data.raw_events
          WHERE event_name = 'Preimage.Noted'
            AND lower(JSONExtractString(args_json, 'hash')) = {hash:String}
            AND extrinsic_index IS NOT NULL)
      ORDER BY c.block_height
      LIMIT 1`,
    query_params: { hash }, format: 'JSONEachRow',
  })
  const row = (await res.json<{ block: number; bytes: string }>())[0]
  return row && /^0x[0-9a-f]*$/i.test(row.bytes) && row.bytes.length > 2
    ? { bytes: row.bytes, block: Number(row.block) }
    : null
}

// One runtime per spec version, not per proposal: loading metadata is the expensive part
// and referenda cluster within a runtime.
const runtimeCache = new Map<number, Awaited<ReturnType<typeof loadSnapshotRuntime>>['runtime']>()

async function runtimeAt(block: number): Promise<Awaited<ReturnType<typeof loadSnapshotRuntime>>['runtime']> {
  const specRes = await client.query({
    query: `SELECT spec_version FROM price_data.raw_blocks FINAL WHERE block_height = {b:UInt32} LIMIT 1`,
    query_params: { b: block }, format: 'JSONEachRow',
  })
  const spec = Number((await specRes.json<{ spec_version: number }>())[0]?.spec_version ?? 0)
  const cached = runtimeCache.get(spec)
  if (cached) return cached
  const hash = await rpc.call<string>('chain_getBlockHash', [block])
  const { runtime } = await loadSnapshotRuntime(rpc, hash)
  if (spec > 0) runtimeCache.set(spec, runtime)
  return runtime
}

async function decodeOne(hash: string): Promise<ProposalRow | null> {
  const preimage = await loadPreimageBytes(hash)
  if (!preimage) return null
  const byteLength = (preimage.bytes.length - 2) / 2
  try {
    const runtime = await runtimeAt(preimage.block)
    const flat = flattenDecodedCall(runtime.decodeCall(preimage.bytes))
    if (!flat) throw new Error('call did not decode to a pallet/call shape')
    return {
      proposal_hash: hash,
      pallet: flat.pallet,
      call_name: flat.callName,
      args_json: JSON.stringify(jsonSafeArgs(flat.args)),
      byte_length: byteLength,
      noted_block: preimage.block,
      decode_error: '',
    }
  } catch (err) {
    // Recorded rather than dropped: a hash that cannot be decoded should say so on the
    // page instead of looking like a referendum with no proposal.
    return {
      proposal_hash: hash,
      pallet: '',
      call_name: '',
      args_json: '',
      byte_length: byteLength,
      noted_block: preimage.block,
      decode_error: (err as Error).message.slice(0, 300),
    }
  }
}

async function runCycle(): Promise<void> {
  const [wanted, decoded] = await Promise.all([loadWanted(), loadDecoded()])
  const todo = proposalsNeedingDecode(wanted, decoded, max)
  console.log(`[proposals] ${wanted.length} referendum preimages known, ${decoded.size} decoded; decoding ${todo.length} this cycle`)
  if (!todo.length) return

  const rows: ProposalRow[] = []
  for (const target of todo) {
    const row = await decodeOne(target.hash)
    if (!row) { console.warn(`[proposals] ${target.hash}: no preimage bytes indexed`); continue }
    rows.push(row)
    console.log(row.decode_error
      ? `[proposals] ${target.hash}: ${row.decode_error}`
      : `[proposals] ${target.hash}: ${row.pallet}.${row.call_name} (${row.byte_length} bytes)`)
    if (rows.length >= 25) {
      if (!dryRun) await client.insert({ table: 'price_data.referendum_proposals', values: rows, format: 'JSONEachRow' })
      rows.length = 0
    }
  }
  if (rows.length && !dryRun) {
    await client.insert({ table: 'price_data.referendum_proposals', values: rows, format: 'JSONEachRow' })
  }
  console.log(dryRun ? '[proposals] dry run, nothing written' : '[proposals] cycle done')
}

async function main(): Promise<void> {
  if (!loop) { await runCycle(); return }
  for (;;) {
    try { await runCycle() } catch (err) { console.error('[proposals] cycle failed:', (err as Error).message) }
    await sleep(cycleMinutes * 60_000)
  }
}

await main()
