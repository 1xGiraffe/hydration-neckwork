import { describe, expect, it } from 'vitest'
import {
  verifiedArtifactRows,
  verificationDisplay,
  blockscoutImportRows,
  parseSettings,
  searchVerifiedNames,
  type VerifiedContractInfo,
} from '../src/services/contractVerificationService.ts'

const ADDRESS = '0x531a654d1696ed52e7275a8cede955e82620f99a'

const result = {
  matchType: 'FULL' as const,
  contractName: 'GhoToken',
  fileName: 'src/GhoToken.sol',
  abi: '[{"type":"function","name":"totalSupply"}]',
  compilerVersion: 'v0.8.10+commit.fc410830',
  compilerSettings: '{"evmVersion":"london","optimizer":{"enabled":true,"runs":200}}',
  constructorArguments: '0xabcd',
  sourceFiles: { 'src/GhoToken.sol': 'contract GhoToken {}', 'src/lib/Math.sol': 'library Math {}' },
}

// The three tables are ReplacingMergeTrees keyed by (address) / (address, path)
// / (verification_id): idempotence means re-verifying emits rows under the SAME
// replacement keys, and a shrunken file set tombstones the leftovers instead of
// leaving stale files live beside the new verification.
describe('verifiedArtifactRows', () => {
  it('keys the ABI row by address and stamps the registry code hash', () => {
    const { abiRow } = verifiedArtifactRows({ address: ADDRESS, result, codeHash: '0xc0de', previousPaths: [] })
    expect(abiRow).toMatchObject({
      address: ADDRESS,
      abi_json: result.abi,
      contract_name: 'GhoToken',
      compiler_version: 'v0.8.10+commit.fc410830',
      source: 'verified',
      match_type: 'FULL',
      code_hash: '0xc0de',
      deleted: 0,
    })
  })

  it('emits one row per source file under (address, path) with the compiler settings', () => {
    const { sourceRows } = verifiedArtifactRows({ address: ADDRESS, result, codeHash: '', previousPaths: [] })
    expect(sourceRows).toHaveLength(2)
    const main = sourceRows.find(r => r.path === 'src/GhoToken.sol')
    expect(main).toMatchObject({
      address: ADDRESS,
      content: 'contract GhoToken {}',
      evm_version: 'london',
      optimizer_enabled: 1,
      optimizer_runs: 200,
      constructor_arguments: '0xabcd',
      deleted: 0,
    })
  })

  it('is idempotent: the same verification twice produces identical replacement keys', () => {
    const a = verifiedArtifactRows({ address: ADDRESS, result, codeHash: '0xc0de', previousPaths: [] })
    const b = verifiedArtifactRows({ address: ADDRESS, result, codeHash: '0xc0de', previousPaths: Object.keys(result.sourceFiles) })
    const keys = (rows: Record<string, unknown>[]) => rows.map(r => `${r.address}|${r.path}|${r.deleted}`).sort()
    expect(keys(b.sourceRows)).toEqual(keys(a.sourceRows))
  })

  it('tombstones previously stored paths missing from a re-verification', () => {
    const { sourceRows } = verifiedArtifactRows({
      address: ADDRESS,
      result: { ...result, sourceFiles: { 'src/GhoToken.sol': 'contract GhoToken {}' } },
      codeHash: '',
      previousPaths: ['src/GhoToken.sol', 'src/lib/Legacy.sol'],
    })
    const tomb = sourceRows.find(r => r.path === 'src/lib/Legacy.sol')
    expect(tomb).toMatchObject({ address: ADDRESS, deleted: 1, content: '' })
    expect(sourceRows.filter(r => r.deleted === 0)).toHaveLength(1)
  })
})

describe('verificationDisplay', () => {
  const info: VerifiedContractInfo = {
    address: ADDRESS,
    name: 'GhoToken',
    compilerVersion: 'v0.8.10+commit.fc410830',
    matchType: 'FULL',
    source: 'verified',
    verifiedAt: '2026-08-04 10:00:00',
    abiPresent: true,
    sourceFileCount: 2,
    codeHash: '0xc0de',
  }

  it('shapes a verified contract with the Sourcify match vocabulary', () => {
    expect(verificationDisplay(info, '0xc0de')).toEqual({
      status: 'verified',
      name: 'GhoToken',
      compilerVersion: 'v0.8.10+commit.fc410830',
      matchType: 'exact_match',
      source: 'verified',
      verifiedAt: '2026-08-04 10:00:00',
      abiPresent: true,
      sourceFileCount: 2,
      supersededBytecode: false,
    })
  })

  it('flags supersededBytecode when the registry code hash moved after verification', () => {
    const display = verificationDisplay(info, '0xdeadbeef')
    expect(display?.supersededBytecode).toBe(true)
  })

  it('does not flag superseded when either hash is unknown', () => {
    expect(verificationDisplay({ ...info, codeHash: '' }, '0xc0de')?.supersededBytecode).toBe(false)
    expect(verificationDisplay(info, '')?.supersededBytecode).toBe(false)
  })

  it('returns an explicit unverified status for contracts with no verification', () => {
    expect(verificationDisplay(null, '0xc0de')).toEqual({ status: 'unverified' })
  })
})

describe('blockscoutImportRows', () => {
  const detail = {
    name: 'DIAOracleV2',
    compiler_version: 'v0.8.13+commit.abaa5c0e',
    optimization_enabled: true,
    optimization_runs: 200,
    evm_version: 'london',
    constructor_args: '0x',
    abi: [{ type: 'function', name: 'getValue' }],
    source_code: 'contract DIAOracleV2 {}',
    file_path: 'DIAOracleV2.sol',
    additional_sources: [{ file_path: 'lib/Ownable.sol', source_code: 'contract Ownable {}' }],
    compiler_settings: { evmVersion: 'london', optimizer: { enabled: true, runs: 200 } },
    is_fully_verified: false,
    is_partially_verified: true,
  }

  it('transforms a Blockscout smart-contract detail into import-labelled rows', () => {
    const rows = blockscoutImportRows(detail, ADDRESS, '0xc0de')
    expect(rows).not.toBeNull()
    expect(rows!.abiRow).toMatchObject({
      address: ADDRESS,
      contract_name: 'DIAOracleV2',
      compiler_version: 'v0.8.13+commit.abaa5c0e',
      source: 'import:blockscout',
      match_type: 'PARTIAL',
      code_hash: '0xc0de',
      deleted: 0,
    })
    expect(JSON.parse(rows!.abiRow.abi_json as string)).toEqual(detail.abi)
    expect(rows!.sourceRows).toHaveLength(2)
    expect(rows!.sourceRows.map(r => r.path).sort()).toEqual(['DIAOracleV2.sol', 'lib/Ownable.sol'])
    expect(rows!.sourceRows[0]).toMatchObject({ optimizer_enabled: 1, optimizer_runs: 200, evm_version: 'london' })
  })

  it('maps full verification to FULL and rejects a payload without an ABI', () => {
    const full = blockscoutImportRows({ ...detail, is_fully_verified: true, is_partially_verified: false }, ADDRESS, '')
    expect(full!.abiRow.match_type).toBe('FULL')
    expect(blockscoutImportRows({ ...detail, abi: undefined }, ADDRESS, '')).toBeNull()
  })
})

describe('parseSettings', () => {
  it('extracts evm version and optimizer config, defaulting on malformed input', () => {
    expect(parseSettings('{"evmVersion":"paris","optimizer":{"enabled":true,"runs":999}}')).toEqual({
      evmVersion: 'paris', optimizerEnabled: true, optimizerRuns: 999,
    })
    expect(parseSettings('not json')).toEqual({ evmVersion: '', optimizerEnabled: false, optimizerRuns: 0 })
  })
})

describe('searchVerifiedNames', () => {
  const entries: [string, VerifiedContractInfo][] = [
    ['0x01', { address: '0x01', name: 'GhoToken', compilerVersion: '', matchType: 'FULL', source: 'verified', verifiedAt: '', abiPresent: true, sourceFileCount: 1, codeHash: '' }],
    ['0x02', { address: '0x02', name: 'AaveOracle', compilerVersion: '', matchType: 'PARTIAL', source: 'import:blockscout', verifiedAt: '', abiPresent: true, sourceFileCount: 1, codeHash: '' }],
    ['0x03', { address: '0x03', name: 'GhoTokenHelper', compilerVersion: '', matchType: 'FULL', source: 'verified', verifiedAt: '', abiPresent: true, sourceFileCount: 1, codeHash: '' }],
  ]

  it('ranks exact and prefix name matches ahead of substring hits', () => {
    const hits = searchVerifiedNames('ghotoken', new Map(entries))
    expect(hits.map(h => h.name)).toEqual(['GhoToken', 'GhoTokenHelper'])
  })

  it('matches case-insensitively anywhere in the name and returns nothing for non-letter queries', () => {
    expect(searchVerifiedNames('oracle', new Map(entries)).map(h => h.name)).toEqual(['AaveOracle'])
    expect(searchVerifiedNames('0x02', new Map(entries))).toEqual([])
  })
})
