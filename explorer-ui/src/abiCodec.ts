import { encodeFunctionData, decodeFunctionResult, decodeErrorResult, decodeFunctionData, parseAbi, toFunctionSelector } from 'viem'
import type { Abi, AbiFunction } from 'viem'
import type { AbiParam, AbiFunctionItem } from './abiShape'

// ABI codec for the contract Read tab (and later the Write tab): viem's codec
// utilities only — no client, transport or provider (RPC transport stays the
// tiny fetch helpers in evmRpc.ts). This module is the single import point for
// viem, loaded as its own lazy chunk (see vite.config.ts manualChunks) so the
// dependency never rides in the entry or vendor chunks. The viem-free shape
// helpers live in abiShape.ts and are re-exported here for codec consumers.
export { readFunctions, functionSignature } from './abiShape'
export type { AbiParam, AbiFunctionItem } from './abiShape'

export function encodeCall(fn: AbiFunctionItem, args: unknown[]): `0x${string}` {
  return encodeFunctionData({ abi: [fn as unknown as AbiFunction], functionName: fn.name, args })
}

export function decodeResult(fn: AbiFunctionItem, data: `0x${string}`): unknown {
  return decodeFunctionResult({ abi: [fn as unknown as AbiFunction], functionName: fn.name, data })
}

// Standard revert decoding: Error(string) → its message, Panic(uint256) → a
// named code. Anything else (custom errors, empty data) returns null so the
// caller shows the raw hex instead of a partial guess.
const PANIC_NAMES: Record<string, string> = {
  '1': 'assertion failed',
  '17': 'arithmetic overflow or underflow',
  '18': 'division by zero',
  '33': 'invalid enum value',
  '34': 'invalid storage byte array',
  '49': 'pop on empty array',
  '50': 'array index out of bounds',
  '65': 'out of memory',
  '81': 'call to a zero-initialized function pointer',
}

const REVERT_ABI: Abi = [
  { type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] },
  { type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] },
]

export function decodeRevert(data: string): string | null {
  if (!/^0x[0-9a-fA-F]{8,}$/.test(data)) return null
  try {
    const decoded = decodeErrorResult({ abi: REVERT_ABI, data: data as `0x${string}` })
    if (decoded.errorName === 'Error') return String(decoded.args?.[0] ?? '')
    if (decoded.errorName === 'Panic') {
      const code = String(decoded.args?.[0] ?? '')
      return `panic: ${PANIC_NAMES[code] ?? `code ${code}`}`
    }
    return null
  } catch {
    return null
  }
}

// --- typed input parsing (form validation) ---------------------------------

function coerceParsed(param: AbiParam, value: unknown): unknown {
  if (param.type.endsWith(']')) {
    if (!Array.isArray(value)) throw new Error(`${param.type} expects a JSON array`)
    const elemType = param.type.replace(/\[\d*\]$/, '')
    return value.map(v => coerceParsed({ ...param, type: elemType }, v))
  }
  if (param.type === 'tuple') {
    const components = param.components ?? []
    if (Array.isArray(value)) {
      if (value.length !== components.length) throw new Error(`tuple expects ${components.length} elements`)
      return value.map((v, i) => coerceParsed(components[i], v))
    }
    if (value && typeof value === 'object') {
      return components.map(c => coerceParsed(c, (value as Record<string, unknown>)[c.name ?? '']))
    }
    throw new Error('tuple expects a JSON array or object')
  }
  if (/^u?int\d*$/.test(param.type)) {
    if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value)
    if (typeof value === 'bigint') return value
    if (typeof value === 'string') return parseInteger(param.type, value)
    throw new Error(`${param.type} expects an integer`)
  }
  if (param.type === 'bool') {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === '1' || value === 1) return true
    if (value === 'false' || value === '0' || value === 0) return false
    throw new Error('bool expects true or false')
  }
  return value
}

function parseInteger(type: string, raw: string): bigint {
  const t = raw.trim()
  if (!/^-?\d+$/.test(t)) throw new Error(`${type} expects a whole integer`)
  const v = BigInt(t)
  if (type.startsWith('uint') && v < 0n) throw new Error(`${type} is unsigned — no negative values`)
  return v
}

// One form field → one typed argument. Throws with a user-facing message; the
// form surfaces it verbatim next to the field.
export function parseInputValue(param: AbiParam, raw: string): unknown {
  const t = raw.trim()
  if (param.type.endsWith(']') || param.type === 'tuple') {
    let parsed: unknown
    try {
      parsed = JSON.parse(t)
    } catch {
      throw new Error(`${param.type} expects JSON (e.g. ${param.type.endsWith(']') ? '[1, 2]' : '["0x…", 1]'})`)
    }
    return coerceParsed(param, parsed)
  }
  if (/^u?int\d*$/.test(param.type)) return parseInteger(param.type, t)
  if (param.type === 'address') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(t)) throw new Error('address expects a 20-byte 0x hex address')
    // Lowercased: viem checksum-validates mixed-case addresses, and a pasted
    // stale checksum must not hard-fail an otherwise valid query.
    return t.toLowerCase()
  }
  if (param.type === 'bool') {
    if (t === 'true' || t === '1') return true
    if (t === 'false' || t === '0') return false
    throw new Error('bool expects true or false')
  }
  if (param.type === 'bytes' || /^bytes\d+$/.test(param.type)) {
    if (!/^0x([0-9a-fA-F]{2})*$/.test(t)) throw new Error(`${param.type} expects 0x hex bytes`)
    return t
  }
  return raw
}

export function parseArgs(fn: AbiFunctionItem, raws: string[]): unknown[] {
  return fn.inputs.map((input, i) => {
    try {
      return parseInputValue(input, raws[i] ?? '')
    } catch (err) {
      const label = input.name || `arg ${i}`
      throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

/**
 * Names an EVM call from a verified ABI: the function its selector matches and its
 * decoded arguments, or null when the selector is not in the ABI or the calldata
 * does not decode against it.
 */
export function decodeCalldata(abi: unknown[], data: string): { name: string; signature: string; args: { name: string; type: string; value: unknown }[] } | null {
  if (!/^0x[0-9a-fA-F]{8}/.test(data)) return null
  const selector = data.slice(0, 10).toLowerCase()
  const fn = (abi as AbiFunction[]).find(item => item?.type === 'function' && (() => { try { return toFunctionSelector(item) === selector } catch { return false } })())
  if (!fn) return null
  try {
    const decoded = decodeFunctionData({ abi: [fn], data: data as `0x${string}` })
    const values = (decoded.args ?? []) as unknown[]
    return {
      name: fn.name,
      signature: `${fn.name}(${fn.inputs.map(i => i.type).join(',')})`,
      args: fn.inputs.map((input, i) => ({ name: input.name ?? `arg${i}`, type: input.type, value: values[i] })),
    }
  } catch {
    return null
  }
}

// Functions a governance proposal commonly calls on a contract with no verified
// source here — the HOLLAR (GHO) token's facilitator admin, the Aave pool
// configurator, ACL roles, ERC-20 basics, proxy upgrades and the incentives
// controller. A selector match decodes the calldata with that signature; anything
// else stays an unverified function.
const KNOWN_FUNCTIONS = [
  'function addFacilitator(address facilitator, string label, uint128 bucketCapacity)',
  'function setFacilitatorBucketCapacity(address facilitator, uint128 newCapacity)',
  'function removeFacilitator(address facilitator)',
  'function transfer(address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function mint(address to, uint256 amount)',
  'function setSupplyCap(address asset, uint256 newSupplyCap)',
  'function setBorrowCap(address asset, uint256 newBorrowCap)',
  'function configureReserveAsCollateral(address asset, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus)',
  'function setReserveFreeze(address asset, bool freeze)',
  'function setReservePause(address asset, bool paused)',
  'function setReserveBorrowing(address asset, bool enabled)',
  'function setReserveActive(address asset, bool active)',
  'function setReserveFactor(address asset, uint256 newReserveFactor)',
  'function setReserveInterestRateStrategyAddress(address asset, address newRateStrategyAddress)',
  'function setDebtCeiling(address asset, uint256 newDebtCeiling)',
  'function setBorrowableInIsolation(address asset, bool borrowable)',
  'function setSiloedBorrowing(address asset, bool siloed)',
  'function setReserveFlashLoaning(address asset, bool enabled)',
  'function setLiquidationProtocolFee(address asset, uint256 newFee)',
  'function setAssetEModeCategory(address asset, uint8 newCategoryId)',
  'function setPoolPause(bool paused)',
  'function setAssetSources(address[] assets, address[] sources)',
  'function grantRole(bytes32 role, address account)',
  'function revokeRole(bytes32 role, address account)',
  'function transferOwnership(address newOwner)',
  'function upgradeTo(address newImplementation)',
  'function upgradeToAndCall(address newImplementation, bytes data)',
  'function setEmissionPerSecond(address asset, address[] rewards, uint88[] newEmissionsPerSecond)',
  'function setDistributionEnd(address asset, address reward, uint32 newDistributionEnd)',
] as const

/** Calldata decoded against the known-function list; null when its selector is not on it. */
export function decodeKnownCalldata(data: string): ReturnType<typeof decodeCalldata> {
  return decodeCalldata([...parseAbi(KNOWN_FUNCTIONS)], data)
}
