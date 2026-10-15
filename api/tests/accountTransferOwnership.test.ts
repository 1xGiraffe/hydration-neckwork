import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  decodeATokenBalanceTransfer,
  directHsmFill,
  erc20LegAccountId,
  evmTwinAccountSql,
  twinAmountMatches,
  erc20OrdinaryLeg,
  erc20WatermarkHolders,
  isMoneyMarketActionRow,
  moneyMarketOwnsTransfer,
  moneyMarketOwnsTransferSql,
  suppressSubordinateActivityRows,
  type ActivityRow,
} from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const body = (name: string): string => {
  const at = explorerService.indexOf(`function ${name}`)
  expect(at, name).toBeGreaterThan(-1)
  const end = explorerService.indexOf('\n}\n', at)
  expect(end, name).toBeGreaterThan(at)
  return explorerService.slice(at, end)
}

const TREASURY = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'
const HELPER = '0x45544800a164ea6810862da9f0df01b9443f877f08934dee0000000000000000'
const OWNER = '0x45544800d4a02e8e6189a6d7713258a5f75e7f6ac0742b2b0000000000000000'
const account = (accountId: string) => ({ accountId } as ActivityRow['who'])
const row = (type: ActivityRow['type'], overrides: Partial<ActivityRow> = {}): ActivityRow => ({
  type, blockHeight: 15_767_160, timestamp: '2026-10-14 03:36:12', eventIndex: 26, extrinsicIndex: 2,
  who: account(HELPER), to: null, asset: null, assetIn: null, assetOut: null,
  amount: null, amountIn: null, amountOut: null, valueUsd: null,
  ...overrides,
})

// A money-market action's own legs run against the market's reserve contracts, which
// every transfer read already drops by counterparty; what the extrinsic-wide rule kept
// catching besides fees and pallet payouts were sends the account made itself (the
// helper contract passing its withdrawn HUSDS to its owner, block 15,767,160).
describe('a money-market action owns only part of its extrinsic', () => {
  const withdraw = row('mm', { mmAction: 'Withdraw' })

  it('keeps a pallet transfer between two ordinary accounts beside it', () => {
    const send = row('transfer', { eventIndex: 14, who: account(HELPER), to: account(OWNER) })
    expect(suppressSubordinateActivityRows([withdraw, send])).toEqual([withdraw, send])
  })

  it('still owns a leg a pallet account is one side of', () => {
    const fee = row('transfer', { eventIndex: 30, who: account(HELPER), to: account(TREASURY) })
    const payout = row('transfer', { eventIndex: 31, who: account('0x6d6f646c6c71646174696f6e0000000000000000000000000000000000000000'), to: account(HELPER) })
    expect(suppressSubordinateActivityRows([withdraw, fee, payout])).toEqual([withdraw])
  })

  it('still owns every ERC-20 log beside it (a contract route into the market)', () => {
    const viaGateway = row('transfer', { eventIndex: 21, who: account(HELPER), to: account(OWNER), erc20Log: true })
    expect(suppressSubordinateActivityRows([withdraw, viaGateway])).toEqual([withdraw])
  })

  it('leaves full ownership to any other row in the same extrinsic', () => {
    const send = row('transfer', { eventIndex: 14, who: account(HELPER), to: account(OWNER) })
    const trade = row('trade', { eventIndex: 44 })
    expect(suppressSubordinateActivityRows([withdraw, trade, send])).toEqual([withdraw, trade])
  })

  it('is the money-market ACTIONS only — a reward claim keeps owning its payout', () => {
    expect(isMoneyMarketActionRow(withdraw)).toBe(true)
    expect(isMoneyMarketActionRow(row('mm', { mmAction: 'LiquidationCall' }))).toBe(true)
    const claim = row('mm', { mmAction: 'ClaimRewards' })
    expect(isMoneyMarketActionRow(claim)).toBe(false)
    const payout = row('transfer', { eventIndex: 14, who: account(OWNER), to: account(HELPER) })
    expect(suppressSubordinateActivityRows([claim, payout])).toEqual([claim])
  })

  // The count's twin over the candidate's raw columns. A truncated module id reads as
  // the module, as accountRef folds it.
  it('states the same test in SQL as on built rows', () => {
    const sql = moneyMarketOwnsTransferSql('from_account', 'to_account', 'erc20')
    expect(sql).toContain('erc20 = 1')
    const pattern = /match\(lower\(from_account\), '([^']+)'\)/.exec(sql)?.[1]
    expect(pattern).toBeTruthy()
    const re = new RegExp(pattern!)
    expect(re.test(TREASURY)).toBe(true)
    expect(re.test('0x455448006d6f646c70792f68736d6f640000000000000000000000000000000000'.slice(0, 66))).toBe(true)
    expect(re.test(HELPER)).toBe(false)
    expect(re.test('0x455448006d6f646c70792f68736d6f64000000000000000000000000000000ff')).toBe(false)
    for (const [from, to, erc20, owned] of [
      [HELPER, OWNER, false, false], [HELPER, TREASURY, false, true], [HELPER, OWNER, true, true],
    ] as const) {
      expect(moneyMarketOwnsTransfer(account(from), account(to), erc20)).toBe(owned)
    }
  })

  it('splits the money-market extrinsics out of the count’s full-ownership set', () => {
    expect(body('semanticExtrinsicSql')).not.toContain('account_money_market_activity')
    expect(body('moneyMarketExtrinsicSql')).toContain('account_money_market_activity')
    // One keyed set: a fully owning row's extrinsic under both keys, a money-market
    // action's under the key of the legs it owns.
    expect(body('accountTransferArm')).toContain('arrayJoin([toUInt8(0), toUInt8(1)]) AS mm_key')
    // The shared subordination, the account page, the chain-wide feed, the asset feed
    // and the transfer-only candidate path all apply the same predicate.
    expect((explorerService.match(/&& moneyMarketOwnsTransfer\(/g) ?? []).length).toBe(5)
  })
})

describe('ERC-20 transfer candidates', () => {
  it('name an H160 by the account it stands for', () => {
    expect(erc20LegAccountId('0x6d6f646c70792f74727372790000000000000000')).toBe(TREASURY)
    expect(erc20LegAccountId('0x7369626ce8030000000000000000000000000000')).toBe('0x7369626ce8030000000000000000000000000000000000000000000000000000')
    expect(erc20LegAccountId('0xA164EA6810862DA9F0DF01B9443F877F08934DEE')).toBe(HELPER)
    // The SQL in erc20TransferCandidateSql states the same three cases.
    const sql = body('erc20TransferCandidateSql')
    expect(sql).toContain("match(${h160}, '^0x(6d6f646c|7369626c|70617261)'), concat(${h160}, repeat('0', 24))")
    expect(sql).toContain("concat('0x45544800', substring(${h160}, 3), repeat('0', 16))")
  })

  it('drop mints, burns, the gas holding address, reserves and the pallet EVM caller', () => {
    const block = explorerService.slice(explorerService.indexOf('const ERC20_NON_HOLDERS = ['), explorerService.indexOf(']', explorerService.indexOf('const ERC20_NON_HOLDERS = [')))
    for (const h160 of [
      '0x0000000000000000000000000000000000000000',
      '0xffffffffffffffffffffffffffffffffffffffff',
      '0x6d6f646c63757272657365720000000000000000',
      '0x000000000000000000000000000000000000090a',
    ]) expect(block).toContain(`'${h160}'`)
  })

  it('drop a log the pallets reported (its Currencies twin follows with the same asset and amount)', () => {
    const sql = body('erc20TransferCandidateSql')
    expect(sql).toContain('(block_height, event_index + 1, asset_id, amount) NOT IN')
    // The twin comes off the account-keyed transfer model, never raw_events' JSON.
    expect(sql).toContain("FROM price_data.account_transfer_activity\n      WHERE ${bound} AND ${inSpan} AND ${evmTwinAccountSql(scope)} AND event_name = 'Currencies.Transferred'")
    expect(body('erc20TransferLegsOf')).toContain("argInt(nextArgs, 'currencyId') === assetId && twinAmountMatches(argStr(nextArgs, 'amount'), t.value, aTokenAsset != null)")
  })

  // Every read is a key-prefix read on a narrow source, and the one wide read — the log's
  // address topics — comes last, over the survivors only.
  it('read narrow sources first and the log only for the survivors', () => {
    const sql = body('erc20TransferCandidateSql')
    expect(sql).not.toContain('raw_events')
    expect(sql).not.toContain('decoded_args_json')
    expect(sql).not.toContain('args_json')
    expect(sql).toContain('holder IN (${quote([...ERC20_NON_HOLDERS, ...scope.reservedH160s, ...scope.minterH160s])})')
    expect(sql).toContain('AND NOT has(erc20_excluded, f) AND NOT has(erc20_excluded, t)')
    expect(sql).toContain("AND NOT match(f, '${ERC20_RESERVED_HOLDER_RE.source}') AND NOT match(t, '${ERC20_RESERVED_HOLDER_RE.source}')")
    expect(sql).toContain('any(topics) AS tp')
    expect(sql).toContain('WHERE ${bound} AND ${inSpan} AND (block_height, event_index) IN (${survivors})')
    // No read at all for a scope with no H160 that can be a party.
    expect(body('erc20CandidateScopeUncached')).toContain('if (!viewed.length) return null')
    // A money-market contract (aHOLLAR's 17.8k legs) or an NTT manager reads none either.
    expect(body('erc20CandidateScopeUncached')).toContain('...[...mmContracts].map(evmAddressOfAccount), ...managers.map(m => m.manager.toLowerCase()),')
    // …nor for one whose holders have no leg at all (one existence read).
    expect(body('erc20CandidateScopeUncached')).toContain('if (!hasErc20 && !hasAToken) return null')
  })

  // One SQL for the page read and the count arm, and the pallet candidates' own
  // counterparty and token filters on top of it.
  it('are read by the page and counted by the arm through the same SQL', () => {
    // The page reads the rows; the count reads them through the same SQL once and hands
    // them to the arm as data (erc20CandidateLiteralSql).
    expect(explorerService).toContain('evmTransferCandidateSql(erc20Scope, bound, erc20PotFilters, assetIdFilterSql(\'asset_id\', tokenIds))')
    expect(body('erc20CandidateRows')).toContain('FROM (${evmTransferCandidateSql(scope, bound, potFilters, tokenFilter)})')
    expect(explorerService).toContain('erc20Candidates: erc20CandidateLiteralSql(erc20Rows),')
    expect((explorerService.match(/transferCandidatePotFiltersSql\(accCond, \{ erc20: true \}\)/g) ?? []).length).toBe(2)
    const arm = body('accountTransferArm')
    expect(arm).toContain('toUInt8(1) AS erc20')
    // After the pallet dedup, never inside it.
    expect(arm.indexOf('transferCandidateSql(accList, bound, potFilters, tokenFilter)')).toBeLessThan(arm.indexOf('args.erc20Candidates'))
    expect(body('transferCandidatesExceedExactBudget')).toContain('price_data.erc20_transfer_deltas')
  })

  // The legs come from erc20_transfer_deltas, written after raw_events, so that table is
  // a watermark source of its own, keyed by holder.
  it('move the page watermark and the swept source mark through erc20_transfer_deltas', () => {
    expect(erc20WatermarkHolders([HELPER, TREASURY, '0x45544800000000000000000000000000000000000000090a0000000000000000', 'not-an-account'])).toEqual([
      '0xa164ea6810862da9f0df01b9443f877f08934dee',
    ])
    expect(body('accountActivityWatermark')).toContain('FROM price_data.erc20_transfer_deltas WHERE holder IN {holders:Array(String)}')
    expect(explorerService).toContain("erc20: { table: 'price_data.erc20_transfer_deltas', column: 'holder', idsOf: erc20WatermarkHolders,")
    expect(explorerService).toContain("activity: sum('activity') + sum('erc20')")
  })
})

// An EVM-only log between two ordinary accounts is the funding or the proceeds of what
// the extrinsic did, never its settlement: the flash-loan helper's HOLLAR from and back
// to its orchestrator (block 15,767,155) stays beside its LP add, MM rows and HSM trade.
describe('an ERC-20 send between ordinary accounts', () => {
  const ORCH = '0x58fb591f0f8255d3c809e9a3f00cf81fd6b17df0'
  const ME = '0xa164ea6810862da9f0df01b9443f877f08934dee'
  const venues = new Set(['0x646fd203bbcf19b35d79f58413bb07450fdbb1db', '0x7e3ce0257506c3e1f96a2a9b25a9440959b0d453'])

  it('is ordinary only when neither party is a venue, pallet or sovereign account', () => {
    expect(erc20OrdinaryLeg(ORCH, ME, venues)).toBe(true)
    expect(erc20OrdinaryLeg(ME, '0x646fd203bbcf19b35d79f58413bb07450fdbb1db', venues)).toBe(false) // BIL issuance operator
    expect(erc20OrdinaryLeg('0x7E3CE0257506C3E1F96A2A9B25A9440959B0D453', ME, venues)).toBe(false) // an aToken, any case
    expect(erc20OrdinaryLeg(ME, '0x6d6f646c70792f74727372790000000000000000', venues)).toBe(false)
    expect(erc20OrdinaryLeg('0x7369626ce8030000000000000000000000000000', ME, venues)).toBe(false)
  })

  it('is owned by no sibling row, in its extrinsic or its hook block', () => {
    const trade = row('trade', { eventIndex: 44 })
    const lp = row('liquidity', { eventIndex: 30, liqAction: 'Add' })
    const supply = row('mm', { eventIndex: 78, mmAction: 'Supply' })
    const send = row('transfer', { eventIndex: 71, who: account(ORCH), to: account(HELPER), erc20Log: true, erc20Send: true })
    const plumbing = row('transfer', { eventIndex: 72, who: account(HELPER), to: account(OWNER), erc20Log: true })
    expect(suppressSubordinateActivityRows([trade, lp, supply, send, plumbing])).toEqual([trade, lp, supply, send])
    const hook = row('trade', { extrinsicIndex: null, who: account(HELPER) })
    const hookSend = row('transfer', { extrinsicIndex: null, eventIndex: 9, who: account(HELPER), to: account(OWNER), erc20Log: true, erc20Send: true })
    expect(suppressSubordinateActivityRows([hook, hookSend])).toEqual([hook, hookSend])
  })

  it('states the same exemption on the page, in the count and on the event-reading pages', () => {
    const sql = body('erc20TransferCandidateSql')
    expect(sql).toContain("${erc20OrdinarySql('f', 't', 'erc20_venues')} AS free")
    const arm = body('accountTransferArm')
    expect(arm).toContain('xi = 4294967295 OR free = 1 OR (block_height, xi, ${mmKey}) NOT IN (SELECT block_height, extrinsic_index, mm_key FROM own_ext)')
    expect(arm).toContain("toUInt8(${moneyMarketOwnsTransferSql('from_account', 'to_account', 'erc20')})")
    expect(arm).toContain('xi != 4294967295 OR free = 1 OR (')
    expect(explorerService).toContain('const scopedTransfers = transfers.filter(t => t.erc20Send || (')
    expect(explorerService).toContain('if (r.extrinsic_index != null && !erc20Free.has(key) && (tradeExt.has(')
    expect(body('erc20TransferLegsOf')).toContain('free: erc20OrdinaryLeg(t.from, t.to, venues)')
    // The BIL issuance contracts are venues by their existing tags, not a second list.
    expect(body('erc20VenueH160s')).toContain("t.tagId === 'bil-issuer' || t.tagId === 'bil-originator'")
  })
})

// The chain-wide and asset feeds show the pages' ERC-20 sends and nothing else of the
// EVM-only legs: a venue leg is the venue's bookkeeping (1,358 of HOLLAR's 1,366
// historical candidates run between the two BIL originator contracts).
describe('ERC-20 sends on the chain-wide and asset feeds', () => {
  it('read the block-first party-transfer table, never the holder-first deltas', () => {
    const sql = body('erc20GlobalCandidateSql')
    expect(sql).toContain("['price_data.erc20_party_transfers', pick(scope.contracts)]")
    expect(sql).toContain("['price_data.atoken_party_transfers', pick(scope.aTokens)]")
    expect(sql).toContain('WHERE ${bound} AND contract_address IN (${contractList})')
    expect(sql).not.toContain('erc20_transfer_deltas')
    expect(sql).not.toContain('raw_')
  })

  it('keep only legs between two ordinary parties, matched through a set', () => {
    const scope = body('erc20GlobalScope')
    expect(scope).toContain('...ERC20_NON_HOLDERS, ...excluded, ...venues,')
    expect(scope).toContain('...[...mmContracts].map(evmAddressOfAccount), ...managers.map(m => m.manager.toLowerCase()),')
    const sql = body('erc20GlobalCandidateSql')
    expect(sql).toContain('AND from_address NOT IN (SELECT arrayJoin(erc20_not_ordinary)) AND to_address NOT IN (SELECT arrayJoin(erc20_not_ordinary))')
    expect(sql).not.toContain('has(erc20_not_ordinary')
  })

  it('drop a log the pallets reported, reading twins only by the sends’ own keys', () => {
    const sql = body('erc20GlobalCandidateSql')
    expect(sql).toContain('WHERE (block_height, event_index + 1, asset_id, amt) NOT IN (${twins})')
    // Chain-wide by the candidates' keys on the block-first model; for some assets,
    // asset-first under their blocks.
    expect(sql).toContain("WHERE event_name = 'Currencies.Transferred' AND (block_height, event_index) IN (SELECT block_height, event_index + 1 FROM (${keyRows}))")
    expect(sql).toContain('WHERE asset_id IN (${sendAssets.join(\',\') || \'0\'}) AND ${bound} AND event_name = \'Currencies.Transferred\'')
    // An aToken twin may sit 1 wei off the converted amount.
    expect(sql).toContain('[toUInt256(greatest(tw, 1) - 1), tw, tw + 1], [tw]')
  })

  it('merge into the transfers list as one newest-first source, flagged as sends', () => {
    expect(explorerService).toContain('const [pallet, erc20] = await Promise.all([runPallet(rawBound, rawLimit), runErc20(rawBound, rawLimit)])')
    expect(explorerService).toContain('FROM (${erc20GlobalCandidateSql(erc20Scope, rawBound, tokenIds)})')
    expect(explorerService).toContain("const rows = await cached(`explorer:erc20-sends:${await liveHeadTag(Boolean(tw), datedWindowIsClosed(to))}:${key}:${readLimit}`")
    expect((explorerService.match(/\.\.\.\(isErc20 \? \{ erc20Log: true as const, erc20Send: true as const \} : \{\}\)/g) ?? []).length).toBe(2)
    expect(explorerService).toContain('const userTransfers = sourceFilteredTransfers.filter(t => t.erc20Send || (')
  })

  it('merge into the asset feed’s transfers the same way', () => {
    expect(explorerService).toContain('FROM (${erc20GlobalCandidateSql(scope, rangeBound, [assetId])})')
    expect(explorerService).toContain('const [palletRows, erc20Rows] = await Promise.all([pallet(rangeBound(), limit), erc20(rangeBound(), limit)])')
    expect(explorerService).toContain('const [treasuryKept, feeSwapKeys] = await Promise.all([dropTreasuryFeeLegs(transfers), feePurchaseSwapKeys(trades)])')
    expect(explorerService).toContain('const userTransfers = treasuryKept.filter(t => t.erc20Send || (')
  })

  // The view keeps only what can be a feed candidate: its WHERE states the fixed
  // non-parties of explorerService literally, so a drift between the two shows here.
  it('come from a view that drops the same fixed non-parties the pages drop', async () => {
    const { PARTY_TRANSFERS_WHERE, PARTY_TRANSFERS_SELECT } = await import('../src/services/erc20WalletService.ts')
    const block = explorerService.slice(explorerService.indexOf('const ERC20_NON_HOLDERS = ['), explorerService.indexOf(']', explorerService.indexOf('const ERC20_NON_HOLDERS = [')))
    const holders = [...block.matchAll(/'(0x[0-9a-f]{40})'/g)].map(m => m[1])
    expect(holders.length).toBe(4)
    for (const h160 of holders) expect(PARTY_TRANSFERS_WHERE).toContain(`'${h160}'`)
    const reserved = /const ERC20_RESERVED_HOLDER_RE = \/(.*)\//.exec(explorerService)![1]
    expect(PARTY_TRANSFERS_WHERE).toContain(`NOT match(lower(JSONExtractString(raw_evm_logs.decoded_args_json, 'from')), '${reserved}')`)
    expect(PARTY_TRANSFERS_WHERE).toContain(`NOT match(lower(JSONExtractString(raw_evm_logs.decoded_args_json, 'to')), '${reserved}')`)
    // A party that is not a well-formed address never reaches the table.
    expect(PARTY_TRANSFERS_WHERE).toContain("match(lower(JSONExtractString(raw_evm_logs.decoded_args_json, 'from')), '^0x[0-9a-f]{40}$')")
    // One row per log, every written column non-Nullable but the extrinsic.
    expect(PARTY_TRANSFERS_SELECT).not.toContain('arrayJoin')
    expect(PARTY_TRANSFERS_SELECT).toContain("toUInt256OrZero(JSONExtractString(decoded_args_json, 'value')) AS amount")
  })
})

// An aToken's EVM-only move is Aave's BalanceTransfer — the scaled amount and the reserve
// index — shown in aToken units on every surface the wallet contracts' sends reach, on
// the same terms (aUSDT/aUSDC between two ordinary accounts: 168 in history).
describe('aToken transfers', () => {
  // aDOT, router → 0x5c6208a3…: value 856,090,444,396 scaled at index 1.0547…e27, beside
  // Aave's Transfer log of 902,930,181,592.
  const topics = [
    '0x4beccb90f994c31aced7a23b5611020728a23d8ec5cddd1a3e9d97b96fda8666',
    '0x0000000000000000000000006d6f646c726f7574657265780000000000000000',
    '0x0000000000000000000000005c6208a3c316a801f8996750aa7b6f45fc988548',
  ]
  const data = '0x000000000000000000000000000000000000000000000000000000c752f7826c0000000000000000000000000000000000000000036870477895618e384aae2d'

  it('converts the scaled value with the log’s own index, rayMul half-up', () => {
    expect(decodeATokenBalanceTransfer(topics, data)).toEqual({
      from: '0x6d6f646c726f7574657265780000000000000000', to: '0x5c6208a3c316a801f8996750aa7b6f45fc988548', value: '902930181592',
    })
    expect(decodeATokenBalanceTransfer(['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', ...topics.slice(1)], data)).toBeNull()
    expect(decodeATokenBalanceTransfer(topics, data.slice(0, 66))).toBeNull()
  })

  it('pairs a twin within 1 wei for an aToken, exactly for a wallet contract', () => {
    expect(twinAmountMatches('902930181593', '902930181592', true)).toBe(true)
    expect(twinAmountMatches('902930181591', '902930181592', true)).toBe(true)
    expect(twinAmountMatches('902930181594', '902930181592', true)).toBe(false)
    expect(twinAmountMatches('902930181593', '902930181592', false)).toBe(false)
    expect(twinAmountMatches(null, '1', true)).toBe(false)
  })

  it('reads the party table by its parties and the twins within the legs’ months', () => {
    const sql = body('aTokenTransferCandidateSql')
    expect(sql).toContain('FROM price_data.atoken_party_transfers')
    expect(sql).toContain('(from_address IN (${holders}) OR to_address IN (${holders}))')
    expect(sql).toContain('block_timestamp >= ${span(\'min\')} AND block_timestamp <= ${span(\'max\')}')
    expect(sql).toContain('AND ${evmTwinAccountSql(scope)} AND event_name = \'Currencies.Transferred\'')
    expect(sql).toContain('arrayJoin([toUInt256(greatest(tw, 1) - 1), tw, tw + 1])')
    expect(sql).toContain("${erc20OrdinarySql('f', 't', 'erc20_venues')} AS free")
    // Both arms, each only when the holders have rows in its source.
    const union = body('evmTransferCandidateSql')
    expect(union).toContain('...(scope.contracts.length ? [erc20TransferCandidateSql(scope, bound, potFilters, tokenFilter)] : []),')
    expect(union).toContain('...(scope.aTokens.length ? [aTokenTransferCandidateSql(scope, bound, potFilters, tokenFilter)] : []),')
  })

  // The pallet reports a viewed H160's move under the account holding the balance — the
  // incentive pot's GDOT under 0x112c208b…000000, its page 0x45544800112c208b….
  it('finds a twin under every account form the H160 stands for', () => {
    expect(evmTwinAccountSql({ accounts: ['0x45544800112c208b900bcfc9ff8131d0f45769cb6c7c7d8d0000000000000000'], holders: ['0x112c208b900bcfc9ff8131d0f45769cb6c7c7d8d'] }))
      .toBe("(account IN ('0x45544800112c208b900bcfc9ff8131d0f45769cb6c7c7d8d0000000000000000') OR startsWith(account, '0x112c208b900bcfc9ff8131d0f45769cb6c7c7d8d'))")
  })

  it('treats the Aave collector as a venue’s settlement, never a party', () => {
    expect(body('erc20PlumbingH160s')).toContain('new Set<string>([AAVE_COLLECTOR])')
  })

  it('reach the event pages, the chain-wide feeds and the asset feed', () => {
    const legs = body('erc20TransferLegsOf')
    expect(legs).toContain('aTokenAsset != null ? decodeATokenBalanceTransfer(topics, log?.data ?? \'\') : null')
    const scope = body('erc20GlobalScope')
    expect(scope).toContain('return { contracts, aTokens, notOrdinary }')
    expect(body('erc20GlobalScopeHasAsset')).toContain('scope.aTokens.some(c => c.assetId === assetId)')
  })

  it('move the page watermark and the swept source mark through their BalanceTransfer legs', () => {
    expect(body('accountActivityWatermark')).toContain("(SELECT max(block_height) FROM price_data.atoken_scaled_deltas WHERE holder IN {holders:Array(String)} AND event_name = 'BalanceTransfer')")
    expect(explorerService).toContain("atoken: { table: 'price_data.atoken_scaled_deltas', column: 'holder', idsOf: erc20WatermarkHolders, where: \"event_name = 'BalanceTransfer'\",")
    expect(explorerService).toContain("activity: sum('activity') + sum('erc20') + sum('atoken')")
  })

  it('come from a view that drops the fixed non-parties and converts half-up', async () => {
    const { ATOKEN_PARTY_TRANSFERS_WHERE, ATOKEN_PARTY_TRANSFERS_SELECT, PARTY_TRANSFERS_WHERE } = await import('../src/services/erc20WalletService.ts')
    expect(ATOKEN_PARTY_TRANSFERS_WHERE.startsWith("raw_evm_logs.event_name = 'BalanceTransfer' AND ")).toBe(true)
    // The same party test as the wallet contracts' view.
    expect(ATOKEN_PARTY_TRANSFERS_WHERE.slice(ATOKEN_PARTY_TRANSFERS_WHERE.indexOf(' AND match('))).toBe(PARTY_TRANSFERS_WHERE.slice(PARTY_TRANSFERS_WHERE.indexOf(' AND match(')))
    expect(ATOKEN_PARTY_TRANSFERS_SELECT).toContain("intDiv((toUInt256OrZero(JSONExtractString(decoded_args_json, 'value')) * toUInt256OrZero(JSONExtractString(decoded_args_json, 'index'))) + toUInt256('500000000000000000000000000'), toUInt256('1000000000000000000000000000')) AS amount")
  })
})

describe('direct HSM trades', () => {
  const swapped3 = (overrides: Record<string, unknown> = {}) => ({
    swapper: HELPER,
    filler: '0x6d6f646c70792f68736d6f640000000000000000000000000000000000000000',
    fillerType: { __kind: 'HSM' },
    operation: { __kind: 'ExactIn' },
    inputs: [{ asset: 1002, amount: '34931214654' }],
    outputs: [{ asset: 222, amount: '34931214654000000000000' }],
    fees: [],
    operationStack: [],
    ...overrides,
  })

  it('reads a fill made straight against the module', () => {
    expect(directHsmFill('Broadcast.Swapped3', swapped3())).toEqual({
      swapper: HELPER, assetIn: 1002, amountIn: '34931214654', assetOut: 222, amountOut: '34931214654000000000000',
    })
    // A governance batch's hook-dispatched purchase is direct too: no Router in its stack.
    expect(directHsmFill('Broadcast.Swapped3', swapped3({ operationStack: [{ __kind: 'Batch', value: 5132800 }] }))).not.toBeNull()
  })

  it('leaves a Router hop to its route and every other venue alone', () => {
    expect(directHsmFill('Broadcast.Swapped3', swapped3({ operationStack: [{ __kind: 'Router', value: 10358408 }] }))).toBeNull()
    expect(directHsmFill('Broadcast.Swapped3', swapped3({ fillerType: { __kind: 'Stableswap', value: 112 } }))).toBeNull()
    expect(directHsmFill('Stableswap.SellExecuted', swapped3())).toBeNull()
    expect(directHsmFill('Broadcast.Swapped3', swapped3({ swapper: '0x2a2a' }))).toBeNull()
    expect(directHsmFill('Broadcast.Swapped3', swapped3({ outputs: [] }))).toBeNull()
  })

  it('reads the venue’s own unrouted legs and drops an arbitrage’s internal buy-back', () => {
    const sql = body('hsmDirectTradesSql')
    expect(sql).toContain("venue = 'hsm' AND op_key = ''")
    expect(sql).toContain("event_name = 'HSM.ArbitrageExecuted'")
  })

  // A trade like any other on both halves of the exact path: counted by the swap arm
  // under its exclusions, owning its extrinsic's transfers, and owning its block's
  // transfers when dispatched from a hook.
  it('is counted, and owns transfers, wherever the account page builds it', () => {
    expect(body('accountSwapTradeArm')).toContain('FROM (${hsmDirectTradeKeysSql(list, bound)})')
    // No feed drops a direct HSM trade as liquidation plumbing, the count neither.
    expect(body('accountSwapTradeArm')).toContain('ext_index IS NULL OR hsm = 1 OR (block_height, ext_index) NOT IN (')
    expect(explorerService).not.toContain('hsmLiqExt')
    expect(body('semanticExtrinsicSql')).toContain('hsmDirectTradeKeysSql(list, bound)')
    const hooks = body('hookOwnerSql')
    expect(hooks).toContain('hsmDirectTradeKeysSql(list, bound)')
    expect(hooks).toContain('FROM price_data.account_swap_activity FINAL')
    expect(explorerService).toContain('hasDirectHsmTrades(list).then(has => has ? hsmDirectTradeRows(bound, catFetch, list, tokenIds) : [])')
    // The plan gates every HSM arm on the same presence answer.
    expect(explorerService).toContain('wantTrades || wantTransfers ? hasDirectHsmTrades(list) : Promise.resolve(false)')
  })
})
