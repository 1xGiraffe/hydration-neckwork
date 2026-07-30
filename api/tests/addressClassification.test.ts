import { describe, it, expect, vi } from 'vitest'
import { boundSubstrateAccount, initExplorerService, resolveRelatedAccounts } from '../src/services/explorerService.ts'

// A bare EVM H160 is ambiguous: it is either a genuine ("pure") EVM account, or
// the default first-20-bytes EVM mapping of a substrate account that used the EVM
// money market. boundSubstrateAccount disambiguates from EVMAccounts.Bound rows.
describe('boundSubstrateAccount', () => {
  const H160 = '0xe606906b34077e322f4cf752b19d67d989352d9d'
  const SUBSTRATE = '0xe606906b34077e322f4cf752b19d67d989352d9dad8140488ffde5fc3df4c10e'
  const MARKER = '0x45544800e606906b34077e322f4cf752b19d67d989352d9d0000000000000000'

  it('re-anchors a bound H160 to the real substrate account (16Cbxt…)', () => {
    const rows = [
      { account_id: SUBSTRATE, evm_address: H160, relationship: 'explicit_binding' },
      { account_id: MARKER, evm_address: H160, relationship: 'runtime_truncated' },
      { account_id: MARKER, evm_address: H160, relationship: 'observed_evm_log_participant' },
    ]
    expect(boundSubstrateAccount(rows, H160)).toBe(SUBSTRATE)
  })

  it('returns null for a genuine EVM account (only observed/truncated rows)', () => {
    const evm = '0xf34e845538cc8a498edd97d7cde16fdfef3d4d99'
    const marker = '0x45544800f34e845538cc8a498edd97d7cde16fdfef3d4d990000000000000000'
    const rows = [
      { account_id: marker, evm_address: evm, relationship: 'observed_evm_log_participant' },
      { account_id: marker, evm_address: evm, relationship: 'runtime_truncated' },
    ]
    expect(boundSubstrateAccount(rows, evm)).toBeNull()
  })

  it('ignores bindings recorded for a different H160', () => {
    const rows = [{ account_id: SUBSTRATE, evm_address: '0x0000000000000000000000000000000000000001', relationship: 'explicit_binding' }]
    expect(boundSubstrateAccount(rows, H160)).toBeNull()
  })

  it('never re-anchors to an ETH-marker (pure-EVM) account_id', () => {
    const rows = [{ account_id: MARKER, evm_address: H160, relationship: 'explicit_binding' }]
    expect(boundSubstrateAccount(rows, H160)).toBeNull()
  })

  it('expands substrate lookups through discovered bound EVM aliases', async () => {
    const query = vi.fn(({ query_params }: { query_params: Record<string, unknown> }) => ({
      json: vi.fn(async () => 'evms' in query_params
        ? [
          {
            account_id: MARKER,
            evm_address: H160,
            primary_profile: `evm:${H160}`,
            relationship: 'runtime_truncated',
            confidence: 90,
          },
        ]
        : [
          {
            account_id: SUBSTRATE,
            evm_address: H160,
            primary_profile: `evm:${H160}`,
            relationship: 'explicit_binding',
            confidence: 100,
          },
        ]),
    }))
    initExplorerService({ query } as never)

    const resolved = await resolveRelatedAccounts(SUBSTRATE)

    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1][0].query_params).toEqual({ evms: [H160] })
    expect(resolved?.related).toEqual(expect.arrayContaining([SUBSTRATE, MARKER]))
  })
})
