import type { RawCall, RawEvent } from './processor.js'
import { callAddressToString, callSourceIndex, toJsonString } from './json.js'
import { deriveTruncatedAccountId, extractHexLike, normalizeAccountId, normalizeH160 } from './accountIdentity.js'
import type { RawBridgeEvidenceRow, RawOperationTraceRow, RawXcmActivityRow } from './types.js'

export interface XcmExtractionResult {
  xcmActivity: RawXcmActivityRow[]
  bridgeEvidence: RawBridgeEvidenceRow[]
  operationTraces: RawOperationTraceRow[]
}

interface SourceItem {
  kind: 'event' | 'call'
  name: string
  blockHeight: number
  eventIndex: number | null
  extrinsicIndex: number | null
  callAddress: string | null
  sourceIndex: string
  payload: unknown
}

// ParachainSystem.set_validation_data is the relay-parent inherent present in
// every block. It carries no XCM transfer/message intent, and its storage-proof
// bytes get misread as account hints, so it must not be treated as XCM activity.
// Genuine ParachainSystem XCM evidence (DownwardMessages*, UpwardMessageSent,
// ...) is still captured.
const XCM_NAME_EXCLUDE = /^ParachainSystem\.set_validation_data$/

function isXcmName(name: string): boolean {
  if (XCM_NAME_EXCLUDE.test(name)) return false
  return /^(PolkadotXcm|XTokens|XcmTransactor|OrmlXcm|MessageQueue|DmpQueue|XcmpQueue|CumulusXcm|Ump|ParachainSystem)\./.test(name)
}

function isBridgeName(name: string): boolean {
  if (/hyperbridge/i.test(name)) return false
  return /(Bridge|BridgeHub|Snowbridge|Wormhole|EthereumInbound|EthereumOutbound|InboundQueue|OutboundQueue|Vaa|TokenBridge)/i.test(name)
}

function isOperationTraceName(name: string, payload: unknown): boolean {
  return /^Broadcast\./.test(name) || findFirstByKey(payload, /operation_?stack|route|hops/i) != null
}

function directionFor(name: string, payload: unknown): string {
  if (/transfer|send|reserve_transfer|teleport|export|outbound/i.test(name)) return 'outbound'
  if (/receive|import|inbound|credited/i.test(name)) return 'inbound'
  if (/attempted|executed|processed|success|complete/i.test(name)) return 'processed'
  const payloadText = toJsonString(payload)
  if (/destination|dest/i.test(payloadText)) return 'outbound'
  if (/origin|source/i.test(payloadText)) return 'inbound'
  return 'unknown'
}

// Returns true once the callback has asked to stop, so a "find the first" walk
// does not keep recursing a payload it is already done with.
function visitObjects(value: unknown, cb: (value: unknown, keyHint: string) => boolean | void, keyHint = ''): boolean {
  if (cb(value, keyHint) === true) return true
  if (Array.isArray(value)) {
    for (const item of value) if (visitObjects(item, cb, keyHint)) return true
    return false
  }
  if (value != null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (visitObjects(nested, cb, key)) return true
    }
  }
  return false
}

function findFirstByKey(value: unknown, keyPattern: RegExp): unknown | null {
  let found: unknown | null = null
  visitObjects(value, (current, keyHint) => {
    if (!keyPattern.test(keyHint)) return
    found = current
    return true
  })
  return found
}

function collectByKey(value: unknown, keyPattern: RegExp): unknown[] {
  const matches: unknown[] = []
  visitObjects(value, (current, keyHint) => {
    if (keyPattern.test(keyHint)) matches.push(current)
  })
  return matches
}

function collectLocations(value: unknown): unknown[] {
  const locations: unknown[] = []
  visitObjects(value, (current, keyHint) => {
    if (current == null || typeof current !== 'object') return
    const record = current as Record<string, unknown>
    if (
      (record.parents != null && record.interior != null) ||
      record.__kind === 'Parachain' ||
      record.__kind === 'GlobalConsensus' ||
      record.__kind === 'AccountKey20' ||
      record.__kind === 'AccountId32' ||
      /location|destination|dest|origin|beneficiary/i.test(keyHint)
    ) {
      locations.push(current)
    }
  })
  return locations
}

function collectAssets(value: unknown): unknown[] {
  const assets: unknown[] = []
  visitObjects(value, (current, keyHint) => {
    if (/asset|assets|currency|currencyId|fungible|amount|fee/i.test(keyHint)) {
      assets.push(current)
    }
  })
  return assets
}

function collectExternalHints(value: unknown): string[] {
  const hints = new Set<string>()
  visitObjects(value, (current, keyHint) => {
    const h160 = normalizeH160(current)
    if (h160 != null) {
      hints.add(`evm:${h160}`)
      return
    }
    const accountId = normalizeAccountId(current)
    if (accountId != null) {
      hints.add(`substrate:${accountId}`)
      return
    }
    if (current != null && typeof current === 'object') {
      const record = current as Record<string, unknown>
      if (record.__kind === 'Parachain' && typeof record.value === 'number') {
        hints.add(`parachain:${record.value}`)
      }
      if (/ethereum|evm|h160|accountkey20/i.test(keyHint)) {
        const hex = extractHexLike(current)
        if (hex != null) hints.add(`hex:${hex}`)
      }
    }
  })
  return [...hints]
}

function collectMessageHash(value: unknown): string | null {
  let hash: string | null = null
  visitObjects(value, (current, keyHint) => {
    if (hash != null || !/hash|message/i.test(keyHint)) return
    const hex = extractHexLike(current)
    if (hex != null && hex.length === 66) hash = hex
  })
  return hash
}

// An account buried in a multilocation subtree (AccountId32 `id` / AccountKey20
// `key` junction) — how pallet_xcm encodes origin and beneficiary accounts.
function junctionAccount(value: unknown): string | null {
  let account: string | null = null
  visitObjects(value, (current, keyHint) => {
    if (account != null || !/^(id|key)$/i.test(keyHint)) return
    const accountId = normalizeAccountId(current)
    if (accountId != null) {
      account = accountId
      return
    }
    const h160 = normalizeH160(current)
    if (h160 != null) account = deriveTruncatedAccountId(h160)
  })
  return account
}

function collectAccount(value: unknown, keys: RegExp): string | null {
  let account: string | null = null
  visitObjects(value, (current, keyHint) => {
    if (account != null || !keys.test(keyHint)) return
    const accountId = normalizeAccountId(current)
    if (accountId != null) {
      account = accountId
      return
    }
    const h160 = normalizeH160(current)
    if (h160 != null) {
      account = deriveTruncatedAccountId(h160)
      return
    }
    // Not a direct key:account pair — PolkadotXcm.Sent nests accounts inside
    // multilocation junctions (origin / beneficiary), so dig into the subtree.
    if (current != null && typeof current === 'object') account = junctionAccount(current)
  })
  return account
}

function collectExternalAccount(value: unknown): string | null {
  let external: string | null = null
  visitObjects(value, (current, keyHint) => {
    if (external != null || !/ethereum|evm|h160|accountkey20|external/i.test(keyHint)) return
    const h160 = normalizeH160(current)
    if (h160 != null) external = h160
  })
  return external
}

function collectFirstAssetId(value: unknown): string | null {
  let assetId: string | null = null
  visitObjects(value, (current, keyHint) => {
    if (assetId != null || !/asset|currency|token/i.test(keyHint)) return
    if (typeof current === 'number' && Number.isSafeInteger(current)) assetId = current.toString()
    if (typeof current === 'bigint') assetId = current.toString()
    if (typeof current === 'string' && /^\d+$/.test(current)) assetId = current
  })
  return assetId
}

function collectFirstAmount(value: unknown): string | null {
  let amount: string | null = null
  visitObjects(value, (current, keyHint) => {
    if (amount != null || !/amount|balance|fungible|fee|value/i.test(keyHint)) return
    if (typeof current === 'number' && Number.isFinite(current)) amount = Math.trunc(current).toString()
    if (typeof current === 'bigint') amount = current.toString()
    if (typeof current === 'string' && /^\d+$/.test(current)) amount = current
  })
  return amount
}

function bridgeKind(name: string): string {
  if (/snowbridge/i.test(name)) return 'snowbridge'
  if (/wormhole|vaa|tokenbridge/i.test(name)) return 'wormhole'
  if (/ethereum/i.test(name)) return 'ethereum'
  return 'bridge'
}

function sourceFromEvent(event: RawEvent): SourceItem {
  return {
    kind: 'event',
    name: event.name ?? '',
    blockHeight: event.block.height,
    eventIndex: event.index,
    extrinsicIndex: event.extrinsicIndex ?? null,
    callAddress: callAddressToString(event.callAddress),
    sourceIndex: event.index.toString(),
    payload: event.args ?? null,
  }
}

function sourceFromCall(call: RawCall): SourceItem {
  return {
    kind: 'call',
    name: call.name ?? '',
    blockHeight: call.block.height,
    eventIndex: null,
    extrinsicIndex: call.extrinsicIndex,
    callAddress: callAddressToString(call.address),
    sourceIndex: callSourceIndex(call),
    payload: call.args ?? null,
  }
}

function xcmRow(source: SourceItem, blockTimestamp: string, ingestSource: string): RawXcmActivityRow {
  return {
    block_height: source.blockHeight,
    block_timestamp: blockTimestamp,
    source_kind: source.kind,
    source_index: source.sourceIndex,
    event_index: source.eventIndex,
    extrinsic_index: source.extrinsicIndex,
    call_address: source.callAddress,
    name: source.name,
    direction: directionFor(source.name, source.payload),
    sender: collectAccount(source.payload, /sender|from|origin|source|who/i),
    recipient: collectAccount(source.payload, /recipient|beneficiary|dest|destination|to|target/i),
    message_hash: collectMessageHash(source.payload),
    assets_json: toJsonString(collectAssets(source.payload)),
    location_json: toJsonString(collectLocations(source.payload)),
    external_link_hints: collectExternalHints(source.payload),
    args_json: toJsonString(source.payload),
    ingest_source: ingestSource,
  }
}

function bridgeRow(source: SourceItem, blockTimestamp: string, ingestSource: string): RawBridgeEvidenceRow {
  return {
    block_height: source.blockHeight,
    block_timestamp: blockTimestamp,
    source_kind: source.kind,
    source_index: source.sourceIndex,
    event_index: source.eventIndex,
    extrinsic_index: source.extrinsicIndex,
    call_address: source.callAddress,
    name: source.name,
    bridge_kind: bridgeKind(source.name),
    direction: directionFor(source.name, source.payload),
    account_id: collectAccount(source.payload, /account|sender|from|origin|recipient|beneficiary|to|user/i),
    external_account: collectExternalAccount(source.payload),
    asset_id: collectFirstAssetId(source.payload),
    amount: collectFirstAmount(source.payload),
    evidence_json: toJsonString({
      name: source.name,
      payload: source.payload,
      locations: collectLocations(source.payload),
      external_hints: collectExternalHints(source.payload),
    }),
    ingest_source: ingestSource,
  }
}

function operationRow(source: SourceItem, blockTimestamp: string, ingestSource: string): RawOperationTraceRow {
  const operationStack = findFirstByKey(source.payload, /operation_?stack|route|hops/i) ?? null
  return {
    block_height: source.blockHeight,
    block_timestamp: blockTimestamp,
    trace_id: `${source.blockHeight}:${source.kind}:${source.sourceIndex}`,
    event_index: source.eventIndex,
    extrinsic_index: source.extrinsicIndex,
    call_address: source.callAddress,
    operation_name: source.name,
    account_id: collectAccount(source.payload, /account|sender|from|origin|recipient|beneficiary|to|user|who/i),
    operation_stack_json: toJsonString(operationStack),
    assets_json: toJsonString(collectByKey(source.payload, /asset|currency|token/i)),
    amounts_json: toJsonString(collectByKey(source.payload, /amount|balance|fungible|fee|value/i)),
    evidence_json: toJsonString(source.payload),
    ingest_source: ingestSource,
  }
}

export function extractXcmBridgeAndOperationRows(
  events: RawEvent[],
  calls: RawCall[],
  blockTimestamp: string,
  ingestSource: string,
): XcmExtractionResult {
  const xcmActivity: RawXcmActivityRow[] = []
  const bridgeEvidence: RawBridgeEvidenceRow[] = []
  const operationTraces: RawOperationTraceRow[] = []

  const sources = [
    ...events.map(sourceFromEvent),
    ...calls.map(sourceFromCall),
  ]

  for (const source of sources) {
    // The relay-chain validation-data inherent is in every block and carries the
    // ~95 KiB storage proof, which is not evidence of anything: its trie nodes are
    // opaque bytes that only read as accounts and routes by accident. Skipping it
    // once here keeps all three extractors — not just the XCM one — from walking
    // that proof on every block to reach a guaranteed non-match.
    if (XCM_NAME_EXCLUDE.test(source.name)) continue
    if (isXcmName(source.name)) {
      xcmActivity.push(xcmRow(source, blockTimestamp, ingestSource))
    }
    if (isBridgeName(source.name)) {
      bridgeEvidence.push(bridgeRow(source, blockTimestamp, ingestSource))
    }
    if (isOperationTraceName(source.name, source.payload)) {
      operationTraces.push(operationRow(source, blockTimestamp, ingestSource))
    }
  }

  return { xcmActivity, bridgeEvidence, operationTraces }
}
