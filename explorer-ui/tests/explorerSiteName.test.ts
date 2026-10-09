import { describe, expect, it } from 'vitest'
import { explorerSiteName } from '../src/components/ActivityTable'

// The external-explorer label follows the link's own host: a HyperEVM arrival's
// hyperevmscan.io link was labelled "Subscan" because every unknown host fell back to it.
describe('explorerSiteName', () => {
  it('names Subscan only for subscan.io hosts', () => {
    expect(explorerSiteName('https://polkadot.subscan.io/account/1abc')).toBe('Subscan')
    expect(explorerSiteName('https://assethub-polkadot.subscan.io/extrinsic/1-2')).toBe('Subscan')
  })

  it('names the explorers a bridged journey reaches', () => {
    expect(explorerSiteName('https://hyperevmscan.io/tx/0x9091')).toBe('HyperEVMScan')
    expect(explorerSiteName('https://suivision.xyz/txblock/abc')).toBe('SuiVision')
    expect(explorerSiteName('https://optimistic.etherscan.io/tx/0x1')).toBe('Etherscan')
    expect(explorerSiteName('https://basescan.org/address/0x1')).toBe('Basescan')
  })

  it('names an unknown host by its own domain, never Subscan', () => {
    expect(explorerSiteName('https://www.example-scan.org/tx/1')).toBe('example-scan.org')
    expect(explorerSiteName('not a url')).toBe('explorer')
  })
})
