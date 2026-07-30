import { blake2AsHex } from '@polkadot/util-crypto'
import { createClickHouseClient } from '../db/client.js'
import { hasFlag, integerOption } from '../util/cliArgs.js'
import { createSnapshotRpcClient, loadSnapshotRuntime } from './snapshotRuntime.js'
import {
  flattenDecodedCall,
  jsonSafeArgs,
  preimageBytesFromCall,
  proposalsNeedingDecode,
  selectPreimageBytes,
} from '../governance/proposalCalls.js'

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
  // The exact SCALE bytes the chain stored, kept so a reader can copy the encoded call
  // and not just its decoded form.
  encoded: string
  byte_length: number
  noted_block: number
  decode_error: string
}

// Every proposal hash a referendum has named, paired with the block its preimage was
// noted at.
//
// OpenGov names its proposal on Referenda.Submitted and its preimage lands as
// Preimage.Noted. Democracy names none — Democracy.Started is {refIndex, threshold} — so
// the hashes there are the ones the pallet actually ENACTED, reported by
// Democracy.PreimageUsed; the API pairs each back to its referendum by the
// Democracy.Executed event in the same block. Either way the bytes sit on the extrinsic
// that noted the preimage.
async function loadWanted(): Promise<{ hash: string; notedBlock: number }[]> {
  const res = await client.query({
    query: `
      SELECT hash, max(noted_block) AS noted_block FROM (
        SELECT lower(JSONExtractString(n.args_json, 'hash')) AS hash, n.block_height AS noted_block
        FROM price_data.raw_events n
        WHERE n.event_name = 'Preimage.Noted'
          AND lower(JSONExtractString(n.args_json, 'hash')) IN (
            SELECT DISTINCT lower(JSONExtractString(args_json, 'proposal', 'hash'))
            FROM price_data.raw_events
            WHERE event_name = 'Referenda.Submitted' AND JSONHas(args_json, 'proposal'))
        UNION ALL
        SELECT lower(JSONExtractString(n.args_json, 'proposalHash')) AS hash, n.block_height AS noted_block
        FROM price_data.raw_events n
        WHERE n.event_name = 'Democracy.PreimageNoted'
          AND lower(JSONExtractString(n.args_json, 'proposalHash')) IN (
            SELECT DISTINCT lower(JSONExtractString(args_json, 'proposalHash'))
            FROM price_data.raw_events WHERE event_name = 'Democracy.PreimageUsed')
      )
      GROUP BY hash`,
    format: 'JSONEachRow',
  })
  return (await res.json<{ hash: string; noted_block: number }>())
    .filter(row => /^0x[0-9a-f]{64}$/.test(row.hash))
    .map(row => ({ hash: row.hash, notedBlock: Number(row.noted_block) }))
}

// A hash counts as done only if the bytes on file really are its preimage. The hash IS
// the content, so this is checkable — and 4 of 343 stored rows failed it, holding a
// sibling preimage picked out of a batch that noted several. Verifying here means those
// come back for another pass instead of standing as a wrong proposal forever.
async function loadDecoded(): Promise<Set<string>> {
  const res = await client.query({
    // A row missing its encoded bytes is not finished, so it comes back for another pass.
    query: `SELECT proposal_hash, encoded FROM price_data.referendum_proposals FINAL WHERE decode_error = '' AND encoded != ''`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ proposal_hash: string; encoded: string }>()
  return new Set(rows.filter(row => selectPreimageBytes([row.encoded], row.proposal_hash, digest)).map(row => row.proposal_hash))
}

const digest = (bytes: string): string => blake2AsHex(bytes, 256)

interface ExtrinsicCallRow { block: number; call_name: string; args_json: string }

// The preimage bytes for one hash, from the extrinsic that noted it.
//
// Every call on that extrinsic is a candidate — the note_preimage call itself when the
// indexer recorded it, and otherwise the wrapper that carries it in its decoded args
// (see preimageBytesFromCall). The winner is the one that hashes to the wanted hash, so
// a batch that noted several preimages cannot hand back the wrong one. Earliest note
// first: the runtime the call was written for is the one it is decoded against.
async function loadPreimageBytes(hash: string): Promise<{ bytes: string; block: number } | null> {
  const res = await client.query({
    query: `
      SELECT c.block_height AS block, c.call_name AS call_name, c.args_json AS args_json
      FROM price_data.raw_calls c
      WHERE (c.block_height, c.extrinsic_index) IN (
          SELECT block_height, extrinsic_index FROM price_data.raw_events
          WHERE event_name IN ('Preimage.Noted', 'Democracy.PreimageNoted')
            AND lower(if(event_name = 'Preimage.Noted',
                         JSONExtractString(args_json, 'hash'),
                         JSONExtractString(args_json, 'proposalHash'))) = {hash:String}
            AND extrinsic_index IS NOT NULL)
      ORDER BY c.block_height, c.extrinsic_index, c.call_address`,
    query_params: { hash }, format: 'JSONEachRow',
  })
  for (const row of await res.json<ExtrinsicCallRow>()) {
    let args: unknown
    try { args = JSON.parse(row.args_json) } catch { continue }
    const bytes = selectPreimageBytes(preimageBytesFromCall(row.call_name, args), hash, digest)
    if (bytes) return { bytes, block: Number(row.block) }
  }
  return null
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
      encoded: preimage.bytes,
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
      encoded: preimage.bytes,
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
