import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ERC20_WALLET_ASSETS, ERC20_WALLET_ASSET_IDS } from '../src/services/erc20WalletService.ts'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

const materializedViews = read('../../clickhouse/schema/003_materialized_views.sql')
const accountBalances = read('../src/public/services/accountBalances.ts')

const deltasMv = materializedViews
  .split('\n')
  .find(line => line.startsWith('CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.erc20_transfer_deltas_mv ')) ?? ''

// An `Erc20`-kind registry asset is settled in its contract, not orml_tokens, so
// nothing about it reaches account_asset_latest_balances. Its holders exist only
// where all three of these agree: erc20_transfer_deltas_mv captures the contract's
// Transfer logs, erc20WalletService reads that holder set and publishes balances,
// and the public account surface asks for the asset id. Miss any one and holders
// read as an unremarkable zero rather than an error — the failure this pins.
describe('ERC-20-backed wallet assets', () => {
  it('lists each asset once, lowercase, with a distinct contract', () => {
    expect(ERC20_WALLET_ASSETS.length).toBeGreaterThan(0)
    for (const { contract } of ERC20_WALLET_ASSETS) expect(contract).toMatch(/^0x[0-9a-f]{40}$/)
    expect(new Set(ERC20_WALLET_ASSET_IDS).size).toBe(ERC20_WALLET_ASSETS.length)
    expect(new Set(ERC20_WALLET_ASSETS.map(a => a.contract)).size).toBe(ERC20_WALLET_ASSETS.length)
  })

  it('captures exactly those contracts in the transfer-deltas materialized view', () => {
    // The declarative schema cannot import the list, so the two are pinned instead.
    // A contract missing here has no indexed holder set at all; one listed here and
    // nowhere else makes the refresh publish balances no reader asks for.
    const filter = /contract_address IN \(([^)]*)\)/.exec(deltasMv)?.[1]
    expect(filter, 'erc20_transfer_deltas_mv must filter contract_address with an IN list').toBeDefined()
    const captured = [...filter!.matchAll(/'(0x[0-9a-f]{40})'/g)].map(m => m[1])

    expect(new Set(captured)).toEqual(new Set(ERC20_WALLET_ASSETS.map(a => a.contract)))
    expect(captured.length).toBe(new Set(captured).size)
  })

  it('is restated in full by the public account surface', () => {
    // accountBalances.ts is outside the public API's import allow-list, so it keeps
    // its own copy of the ids; a short copy silently zeroes the missing asset there
    // while the explorer shows it.
    const restated = /const ERC20_WALLET_ASSET_IDS = \[([^\]]*)\]/.exec(accountBalances)?.[1]
    expect(restated, 'accountBalances.ts must restate the wallet asset ids').toBeDefined()
    const ids = [...restated!.matchAll(/\d+/g)].map(m => Number(m[0]))

    expect(new Set(ids)).toEqual(new Set(ERC20_WALLET_ASSET_IDS))
  })
})
