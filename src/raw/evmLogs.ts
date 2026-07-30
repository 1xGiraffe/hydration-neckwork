import { Buffer } from 'node:buffer'
import { keccakAsHex } from '@polkadot/util-crypto'
import type { RawEvent } from './processor.js'
import { callAddressToString, toHex, toJsonString } from './json.js'
import { normalizeH160 } from './accountIdentity.js'
import type { RawEvmLogRow } from './types.js'

type AbiType =
  | 'address'
  | 'bool'
  | 'bytes'
  | 'bytes32'
  | 'int256'
  | 'string'
  | 'uint8'
  | 'uint16'
  | 'uint80'
  | 'uint128'
  | 'uint256'

interface AbiParam {
  name: string
  type: AbiType
  indexed?: boolean
}

interface EventAbi {
  name: string
  inputs: AbiParam[]
}

interface RawEvmLog {
  address: string
  topics: string[]
  data: string
  raw: unknown
}

export interface DecodedEvmLog {
  decodeStatus: 'decoded' | 'undecoded' | 'malformed'
  eventSignature: string | null
  eventName: string | null
  decodedArgs: Record<string, unknown>
  participants: string[]
  assets: string[]
  warning: string | null
}

const EVENT_ABIS: EventAbi[] = [
  {
    name: 'BackUnbacked',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'backer', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256' },
      { name: 'fee', type: 'uint256' },
    ],
  },
  {
    name: 'Borrow',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'user', type: 'address' },
      { name: 'onBehalfOf', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256' },
      { name: 'interestRateMode', type: 'uint8' },
      { name: 'borrowRate', type: 'uint256' },
      { name: 'referralCode', type: 'uint16', indexed: true },
    ],
  },
  {
    name: 'FlashLoan',
    inputs: [
      { name: 'target', type: 'address', indexed: true },
      { name: 'initiator', type: 'address' },
      { name: 'asset', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256' },
      { name: 'interestRateMode', type: 'uint8' },
      { name: 'premium', type: 'uint256' },
      { name: 'referralCode', type: 'uint16', indexed: true },
    ],
  },
  {
    name: 'IsolationModeTotalDebtUpdated',
    inputs: [
      { name: 'asset', type: 'address', indexed: true },
      { name: 'totalDebt', type: 'uint256' },
    ],
  },
  {
    name: 'LiquidationCall',
    inputs: [
      { name: 'collateralAsset', type: 'address', indexed: true },
      { name: 'debtAsset', type: 'address', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'debtToCover', type: 'uint256' },
      { name: 'liquidatedCollateralAmount', type: 'uint256' },
      { name: 'liquidator', type: 'address' },
      { name: 'receiveAToken', type: 'bool' },
    ],
  },
  {
    name: 'MintUnbacked',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'user', type: 'address' },
      { name: 'onBehalfOf', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256' },
      { name: 'referralCode', type: 'uint16', indexed: true },
    ],
  },
  {
    name: 'MintedToTreasury',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'amountMinted', type: 'uint256' },
    ],
  },
  {
    name: 'RebalanceStableBorrowRate',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'user', type: 'address', indexed: true },
    ],
  },
  {
    name: 'Repay',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'repayer', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256' },
      { name: 'useATokens', type: 'bool' },
    ],
  },
  {
    name: 'ReserveDataUpdated',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'liquidityRate', type: 'uint256' },
      { name: 'stableBorrowRate', type: 'uint256' },
      { name: 'variableBorrowRate', type: 'uint256' },
      { name: 'liquidityIndex', type: 'uint256' },
      { name: 'variableBorrowIndex', type: 'uint256' },
    ],
  },
  {
    name: 'ReserveUsedAsCollateralDisabled',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'user', type: 'address', indexed: true },
    ],
  },
  {
    name: 'ReserveUsedAsCollateralEnabled',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'user', type: 'address', indexed: true },
    ],
  },
  {
    name: 'Supply',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'user', type: 'address' },
      { name: 'onBehalfOf', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256' },
      { name: 'referralCode', type: 'uint16', indexed: true },
    ],
  },
  {
    name: 'SwapBorrowRateMode',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'interestRateMode', type: 'uint8' },
    ],
  },
  {
    name: 'UserEModeSet',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'categoryId', type: 'uint8' },
    ],
  },
  {
    name: 'Withdraw',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256' },
    ],
  },
  {
    name: 'Approval',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'spender', type: 'address', indexed: true },
      { name: 'value', type: 'uint256' },
    ],
  },
  {
    name: 'BalanceTransfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256' },
      { name: 'index', type: 'uint256' },
    ],
  },
  {
    name: 'Burn',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'target', type: 'address', indexed: true },
      { name: 'value', type: 'uint256' },
      { name: 'balanceIncrease', type: 'uint256' },
      { name: 'index', type: 'uint256' },
    ],
  },
  {
    name: 'Initialized',
    inputs: [
      { name: 'underlyingAsset', type: 'address', indexed: true },
      { name: 'pool', type: 'address', indexed: true },
      { name: 'treasury', type: 'address' },
      { name: 'incentivesController', type: 'address' },
      { name: 'aTokenDecimals', type: 'uint8' },
      { name: 'aTokenName', type: 'string' },
      { name: 'aTokenSymbol', type: 'string' },
      { name: 'params', type: 'bytes' },
    ],
  },
  {
    name: 'Mint',
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'onBehalfOf', type: 'address', indexed: true },
      { name: 'value', type: 'uint256' },
      { name: 'balanceIncrease', type: 'uint256' },
      { name: 'index', type: 'uint256' },
    ],
  },
  {
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256' },
    ],
  },
  {
    name: 'DelegatedTokenUpdated',
    inputs: [
      { name: 'oldDelegatedToken', type: 'address', indexed: true },
      { name: 'newDelegatedToken', type: 'address', indexed: true },
    ],
  },
  {
    name: 'FacilitatorAdded',
    inputs: [
      { name: 'facilitatorAddress', type: 'address', indexed: true },
      { name: 'label', type: 'bytes32', indexed: true },
      { name: 'bucketCapacity', type: 'uint256' },
    ],
  },
  {
    name: 'FacilitatorBucketCapacityUpdated',
    inputs: [
      { name: 'facilitatorAddress', type: 'address', indexed: true },
      { name: 'oldCapacity', type: 'uint256' },
      { name: 'newCapacity', type: 'uint256' },
    ],
  },
  {
    name: 'FacilitatorBucketLevelUpdated',
    inputs: [
      { name: 'facilitatorAddress', type: 'address', indexed: true },
      { name: 'oldLevel', type: 'uint256' },
      { name: 'newLevel', type: 'uint256' },
    ],
  },
  {
    name: 'FacilitatorRemoved',
    inputs: [
      { name: 'facilitatorAddress', type: 'address', indexed: true },
    ],
  },
  {
    name: 'RoleAdminChanged',
    inputs: [
      { name: 'role', type: 'bytes32', indexed: true },
      { name: 'previousAdminRole', type: 'bytes32', indexed: true },
      { name: 'newAdminRole', type: 'bytes32', indexed: true },
    ],
  },
  {
    name: 'RoleGranted',
    inputs: [
      { name: 'role', type: 'bytes32', indexed: true },
      { name: 'account', type: 'address', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
    ],
  },
  {
    name: 'RoleRevoked',
    inputs: [
      { name: 'role', type: 'bytes32', indexed: true },
      { name: 'account', type: 'address', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
    ],
  },
  {
    name: 'OracleUpdate',
    inputs: [
      { name: 'key', type: 'string' },
      { name: 'value', type: 'uint128' },
      { name: 'timestamp', type: 'uint128' },
    ],
  },
  {
    name: 'UpdaterAddressChange',
    inputs: [
      { name: 'newUpdater', type: 'address' },
    ],
  },
  {
    name: 'OwnershipTransferred',
    inputs: [
      { name: 'previousOwner', type: 'address', indexed: true },
      { name: 'newOwner', type: 'address', indexed: true },
    ],
  },
  {
    name: 'PriceUpdated',
    inputs: [
      { name: 'roundId', type: 'uint80', indexed: true },
      { name: 'answer', type: 'int256' },
      { name: 'timestamp', type: 'uint256' },
    ],
  },
]

function eventSignature(abi: EventAbi): string {
  return `${abi.name}(${abi.inputs.map(input => input.type).join(',')})`
}

const ABIS_BY_TOPIC0 = new Map(EVENT_ABIS.map(abi => [keccakAsHex(eventSignature(abi)).toLowerCase(), abi]))

function normalizeData(value: unknown): string | null {
  const hex = extractLogHex(value)
  if (hex == null) return null
  return hex.length === 2 ? '0x' : hex
}

function extractLogHex(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') {
    const prefixed = value.startsWith('0x') ? value : `0x${value}`
    return /^0x[0-9a-fA-F]*$/.test(prefixed) && prefixed.length % 2 === 0
      ? prefixed.toLowerCase()
      : null
  }
  if (
    value instanceof Uint8Array ||
    Buffer.isBuffer(value) ||
    (Array.isArray(value) && value.every(item => Number.isInteger(item) && item >= 0 && item <= 255))
  ) {
    return toHex(value as Uint8Array | Buffer | number[]).toLowerCase()
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['value', 'data', 'bytes', 'hex']) {
      const nested = extractLogHex(record[key])
      if (nested != null) return nested
    }
  }
  return null
}

function parseRawEvmLog(event: RawEvent): RawEvmLog | null {
  if (event.name !== 'EVM.Log') return null
  const args = (event.args ?? {}) as Record<string, unknown>
  const rawLog = (args.log ?? args) as Record<string, unknown>
  const address = normalizeH160(rawLog.address ?? rawLog.contract ?? rawLog.contractAddress)
  const rawTopics = rawLog.topics
  const data = normalizeData(rawLog.data ?? rawLog.value ?? '0x')
  if (address == null || !Array.isArray(rawTopics) || data == null) return null

  const topics = rawTopics
    .map(topic => extractLogHex(topic))
    .filter((topic): topic is string => topic != null)
  if (topics.length !== rawTopics.length) return null

  return {
    address,
    topics,
    data,
    raw: rawLog,
  }
}

function wordFromData(data: string, index: number): string | null {
  const body = data.slice(2)
  const start = index * 64
  const word = body.slice(start, start + 64)
  return word.length === 64 ? word : null
}

function uintFromWord(word: string): string {
  return BigInt(`0x${word}`).toString()
}

function intFromWord(word: string): string {
  const unsigned = BigInt(`0x${word}`)
  const signBit = 1n << 255n
  if ((unsigned & signBit) === 0n) return unsigned.toString()
  return (unsigned - (1n << 256n)).toString()
}

function addressFromWord(word: string): string | null {
  return normalizeH160(`0x${word.slice(24)}`)
}

function bytes32FromWord(word: string): string {
  return `0x${word}`.toLowerCase()
}

function stringFromBytesHex(hex: string): string {
  const buffer = Buffer.from(hex, 'hex')
  const printable = buffer.toString('utf8').replace(/\u0000+$/g, '')
  return printable.length > 0 ? printable : `0x${hex}`
}

function decodeDynamic(data: string, offsetWord: string, kind: 'bytes' | 'string'): string | null {
  const offset = Number(BigInt(`0x${offsetWord}`))
  if (!Number.isSafeInteger(offset) || offset % 32 !== 0) return null
  const lengthWord = wordFromData(data, offset / 32)
  if (lengthWord == null) return null
  const length = Number(BigInt(`0x${lengthWord}`))
  if (!Number.isSafeInteger(length)) return null
  const body = data.slice(2)
  const start = (offset / 32 + 1) * 64
  const bytesHex = body.slice(start, start + length * 2)
  if (bytesHex.length !== length * 2) return null
  return kind === 'string' ? stringFromBytesHex(bytesHex) : `0x${bytesHex}`
}

function decodeStaticWord(type: AbiType, word: string, data: string): unknown {
  switch (type) {
    case 'address':
      return addressFromWord(word)
    case 'bool':
      return BigInt(`0x${word}`) !== 0n
    case 'bytes':
      return decodeDynamic(data, word, 'bytes')
    case 'bytes32':
      return bytes32FromWord(word)
    case 'int256':
      return intFromWord(word)
    case 'string':
      return decodeDynamic(data, word, 'string')
    case 'uint8':
    case 'uint16':
    case 'uint80':
    case 'uint128':
    case 'uint256':
      return uintFromWord(word)
  }
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(value => value.length > 0).map(value => value.toLowerCase()))]
}

function classifyAddresses(decodedArgs: Record<string, unknown>): { participants: string[]; assets: string[] } {
  const assetNames = new Set([
    'asset',
    'reserve',
    'collateralAsset',
    'debtAsset',
    'underlyingAsset',
    'oldDelegatedToken',
    'newDelegatedToken',
  ])
  const participants: string[] = []
  const assets: string[] = []

  for (const [name, value] of Object.entries(decodedArgs)) {
    const address = normalizeH160(value)
    if (address == null) continue
    if (assetNames.has(name)) {
      assets.push(address)
    } else {
      participants.push(address)
    }
  }

  return {
    participants: unique(participants),
    assets: unique(assets),
  }
}

export function decodeEvmLog(log: { topics: string[]; data: string }): DecodedEvmLog {
  const topic0 = log.topics[0]?.toLowerCase()
  if (topic0 == null) {
    return {
      decodeStatus: 'undecoded',
      eventSignature: null,
      eventName: null,
      decodedArgs: {},
      participants: [],
      assets: [],
      warning: 'EVM log has no topic0',
    }
  }

  const abi = ABIS_BY_TOPIC0.get(topic0)
  if (abi == null) {
    return {
      decodeStatus: 'undecoded',
      eventSignature: null,
      eventName: null,
      decodedArgs: {},
      participants: [],
      assets: [],
      warning: `No configured ABI for topic0 ${topic0}`,
    }
  }

  const decodedArgs: Record<string, unknown> = {}
  const indexedInputs = abi.inputs.filter(input => input.indexed)
  if (log.topics.length - 1 < indexedInputs.length) {
    return {
      decodeStatus: 'malformed',
      eventSignature: eventSignature(abi),
      eventName: abi.name,
      decodedArgs,
      participants: [],
      assets: [],
      warning: `Expected ${indexedInputs.length} indexed topics, got ${log.topics.length - 1}`,
    }
  }

  let topicIndex = 1
  let dataIndex = 0
  for (const input of abi.inputs) {
    if (input.indexed) {
      const topic = log.topics[topicIndex++]?.slice(2)
      if (topic == null || topic.length !== 64) {
        return {
          decodeStatus: 'malformed',
          eventSignature: eventSignature(abi),
          eventName: abi.name,
          decodedArgs,
          participants: [],
          assets: [],
          warning: `Malformed indexed topic for ${input.name}`,
        }
      }
      decodedArgs[input.name] = decodeStaticWord(input.type, topic, '0x')
      continue
    }

    const word = wordFromData(log.data, dataIndex++)
    if (word == null) {
      return {
        decodeStatus: 'malformed',
        eventSignature: eventSignature(abi),
        eventName: abi.name,
        decodedArgs,
        participants: [],
        assets: [],
        warning: `Missing data word for ${input.name}`,
      }
    }
    decodedArgs[input.name] = decodeStaticWord(input.type, word, log.data)
  }

  const { participants, assets } = classifyAddresses(decodedArgs)
  return {
    decodeStatus: 'decoded',
    eventSignature: eventSignature(abi),
    eventName: abi.name,
    decodedArgs,
    participants,
    assets,
    warning: null,
  }
}

export function extractEvmLogs(
  events: RawEvent[],
  blockTimestamp: string,
  ingestSource: string,
): RawEvmLogRow[] {
  const rows: RawEvmLogRow[] = []

  for (const event of events) {
    const log = parseRawEvmLog(event)
    if (log == null) continue

    const decoded = decodeEvmLog(log)
    rows.push({
      block_height: event.block.height,
      block_timestamp: blockTimestamp,
      event_index: event.index,
      extrinsic_index: event.extrinsicIndex ?? null,
      call_address: callAddressToString(event.callAddress),
      contract_address: log.address,
      topic0: log.topics[0] ?? null,
      topics: log.topics,
      data: log.data,
      decode_status: decoded.decodeStatus,
      event_signature: decoded.eventSignature,
      event_name: decoded.eventName,
      decoded_args_json: toJsonString(decoded.decodedArgs),
      participants: decoded.participants,
      assets: decoded.assets,
      warning: decoded.warning,
      raw_log_json: toJsonString(log.raw),
      ingest_source: ingestSource,
    })
  }

  return rows
}
