import { Buffer } from 'node:buffer'
import { u8aToHex } from '@polkadot/util'
import { decodeAddress } from '@polkadot/util-crypto'
import type { RawEvent } from './processor.js'
import { toHex, toJsonString } from './json.js'
import type { RawAccountAliasRow } from './types.js'

const H160_HEX_LENGTH = 42
const ACCOUNT_ID_HEX_LENGTH = 66
const ETH_PREFIX_HEX = '45544800'
const EVM_ACCOUNT_SUFFIX_HEX = '0000000000000000'

function isPlainBytesArray(value: unknown): value is number[] {
  return Array.isArray(value) &&
    value.every(item => Number.isInteger(item) && item >= 0 && item <= 255)
}

function normalizeHexLike(value: string): string | null {
  const prefixed = value.startsWith('0x') ? value : `0x${value}`
  if (!/^0x[0-9a-fA-F]+$/.test(prefixed)) return null
  if (prefixed.length % 2 !== 0) return null
  return prefixed.toLowerCase()
}

export function normalizeH160(value: unknown): string | null {
  const hex = extractHexLike(value)
  if (hex == null || hex.length !== H160_HEX_LENGTH) return null
  return hex
}

export function normalizeAccountId(value: unknown): string | null {
  const hex = extractHexLike(value)
  if (hex != null && hex.length === ACCOUNT_ID_HEX_LENGTH) return hex

  if (typeof value === 'string' && !value.startsWith('0x')) {
    try {
      const decoded = u8aToHex(decodeAddress(value)).toLowerCase()
      return decoded.length === ACCOUNT_ID_HEX_LENGTH ? decoded : null
    } catch {
      return null
    }
  }

  return null
}

export function extractHexLike(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') return normalizeHexLike(value)
  if (value instanceof Uint8Array || Buffer.isBuffer(value) || isPlainBytesArray(value)) {
    return toHex(value).toLowerCase()
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['id', 'value', 'address', 'account', 'key', 'AccountId32', 'AccountKey20']) {
      if (record[key] != null) {
        const nested = extractHexLike(record[key])
        if (nested != null) return nested
      }
    }
  }
  return null
}

export function deriveTruncatedAccountId(evmAddress: string): string {
  const h160 = normalizeH160(evmAddress)
  if (h160 == null) {
    throw new Error(`Cannot derive truncated AccountId32 from invalid H160: ${evmAddress}`)
  }
  return `0x${ETH_PREFIX_HEX}${h160.slice(2)}${EVM_ACCOUNT_SUFFIX_HEX}`.toLowerCase()
}

function primaryProfileForEvmAddress(evmAddress: string): string {
  const h160 = normalizeH160(evmAddress)
  if (h160 == null) {
    throw new Error(`Cannot create EVM profile for invalid H160: ${evmAddress}`)
  }
  return `evm:${h160}`
}

interface AliasContext {
  blockHeight: number
  blockTimestamp: string
  eventIndex: number | null
  extrinsicIndex: number | null
  ingestSource: string
  evidence: unknown
}

function aliasRow(
  context: AliasContext,
  accountId: string | null,
  aliasType: string,
  aliasValue: string,
  evmAddress: string | null,
  relationship: string,
  confidence: number,
): RawAccountAliasRow {
  const primaryProfile = evmAddress == null
    ? `substrate:${aliasValue}`
    : primaryProfileForEvmAddress(evmAddress)

  return {
    block_height: context.blockHeight,
    block_timestamp: context.blockTimestamp,
    event_index: context.eventIndex,
    extrinsic_index: context.extrinsicIndex,
    account_id: accountId,
    alias_type: aliasType,
    alias_value: aliasValue,
    evm_address: evmAddress,
    primary_profile: primaryProfile,
    relationship,
    evidence_json: toJsonString(context.evidence),
    confidence,
    ingest_source: context.ingestSource,
  }
}

function aliasRowsForEvmAddress(
  evmAddress: string,
  context: AliasContext,
  relationship: string = 'runtime_truncated',
  confidence: number = 0.95,
): RawAccountAliasRow[] {
  const h160 = normalizeH160(evmAddress)
  if (h160 == null) return []

  const accountId = deriveTruncatedAccountId(h160)
  return [
    aliasRow(context, accountId, 'evm_address', h160, h160, relationship, confidence),
    aliasRow(context, accountId, 'evm_truncated_account_id', accountId, h160, 'runtime_truncated', confidence),
  ]
}

export function aliasRowsForBoundEvent(
  event: RawEvent,
  blockTimestamp: string,
  ingestSource: string,
): RawAccountAliasRow[] {
  if (!/^(EVMAccounts|EvmAccounts)\.Bound$/.test(event.name ?? '')) return []

  const args = (event.args ?? {}) as Record<string, unknown>
  const accountId = normalizeAccountId(args.account ?? args.who ?? args.owner)
  const evmAddress = normalizeH160(args.address ?? args.evmAddress ?? args.evm_address)
  if (accountId == null || evmAddress == null) return []

  const context: AliasContext = {
    blockHeight: event.block.height,
    blockTimestamp,
    eventIndex: event.index,
    extrinsicIndex: event.extrinsicIndex ?? null,
    ingestSource,
    evidence: {
      event: event.name,
      args: event.args ?? null,
      reference: 'hydration-node pallet-evm-accounts Bound event',
    },
  }
  const truncated = deriveTruncatedAccountId(evmAddress)

  return [
    aliasRow(context, accountId, 'substrate_account_id', accountId, evmAddress, 'explicit_binding', 1),
    aliasRow(context, accountId, 'evm_address', evmAddress, evmAddress, 'explicit_binding', 1),
    aliasRow(context, truncated, 'evm_truncated_account_id', truncated, evmAddress, 'runtime_truncated', 0.95),
  ]
}

export function aliasRowsForEvmParticipants(
  evmAddresses: Iterable<string>,
  blockHeight: number,
  blockTimestamp: string,
  sourceEventIndex: number,
  ingestSource: string,
  sourceExtrinsicIndex: number | null = null,
): RawAccountAliasRow[] {
  const rows: RawAccountAliasRow[] = []
  const seen = new Set<string>()
  for (const address of evmAddresses) {
    const h160 = normalizeH160(address)
    if (h160 == null || seen.has(h160)) continue
    seen.add(h160)
    rows.push(...aliasRowsForEvmAddress(h160, {
      blockHeight,
      blockTimestamp,
      eventIndex: sourceEventIndex,
      extrinsicIndex: sourceExtrinsicIndex,
      ingestSource,
      evidence: {
        source: 'EVM.Log participant',
        event_index: sourceEventIndex,
        extrinsic_index: sourceExtrinsicIndex,
      },
    }, 'observed_evm_log_participant', 0.8))
  }
  return rows
}
