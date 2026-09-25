import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bindCteSql, boundAccountSql, holderAccountCount } from '../src/services/explorerService.ts'
import { hollarSupplySql } from '../src/services/hollarService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const hdxService = readFileSync(new URL('../src/services/hdxService.ts', import.meta.url), 'utf8')

// "How many hold this asset" is ONE definition on every surface: the distinct
// accounts with a positive balance, an account's bound EVM-side pot folded onto
// it, every member of a tag counted. The holder list folds a tag's members into
// one row, so its row count (`total`, the pager's) is NOT that figure — 532
// tagged HDX holders read as 17 rows, and the asset page said 60,636 holders
// while the directory and the HDX dashboard said 61,152.
describe('holderAccountCount', () => {
  it('counts a tag row as its holding members and an account row as one', () => {
    const rows = [
      { tag: null },
      { tag: { tagId: 'treasury', name: 'Treasury', color: '', icon: '🏦', memberCount: 6 } },
      { tag: null },
      { tag: { tagId: 'kraken', name: 'Kraken', color: '', icon: '', memberCount: 1 } },
    ]
    expect(holderAccountCount(rows)).toBe(9)
    expect(holderAccountCount([])).toBe(0)
  })
})

describe('holder list account count', () => {
  const at = explorerService.indexOf('export async function getHolders(')
  const body = explorerService.slice(at, explorerService.indexOf('\n// address detail', at))

  it('publishes the account count beside the row count on every path', () => {
    // Substrate path: the sum of holding members over every row, from the same
    // window pass that sizes the pager.
    expect(body).toContain('toUInt64(sum(member_count) OVER ()) AS holder_count')
    expect(body).toContain('return { asset: a, holders, total, totalUsd, holderCount }')
    // aToken and folded display-asset paths: the in-memory rows' members.
    expect((body.match(/holderCount: holderAccountCount\(all\)/g) ?? []).length).toBe(2)
  })

  it('lets only holding accounts into the grouping, so a tag row counts its holding members', () => {
    // The latest-balance aggregate keeps a zero row for every account that ever
    // held the asset; without this a tag's memberCount counted them (Treasury
    // read 7 members with 6 holding HDX).
    const latest = body.slice(body.indexOf('latest AS ('), body.indexOf('grouped AS ('))
    expect(latest).toContain('LEFT JOIN bind b ON b.eth_id = l.account_id')
    expect(latest.slice(latest.indexOf('GROUP BY account_id'))).toContain('HAVING bal > 0')
  })

  it('states the asset page figure as the account count', () => {
    const detail = explorerService.slice(explorerService.indexOf('export async function getAssetDetail('))
    expect(detail.slice(0, detail.indexOf('\n}'))).toContain('holderCount: hsummary.holderCount')
  })
})

// The bound-EVM fold every counting surface applies is one pair of helpers;
// each surface must carry the join, not restate the mapping.
describe('holder counts fold a bound EVM pot onto its owner everywhere', () => {
  const fold = boundAccountSql('l')

  it('assets directory', () => {
    const at = explorerService.indexOf('export async function getAssetHolderCounts')
    const body = explorerService.slice(at, explorerService.indexOf('\nexport function mergeATokenHolderCounts', at))
    expect(body).toContain('${bindCteSql()}')
    expect(body).toContain("${boundAccountSql('l')} AS holder_id")
    expect(body).toContain('LEFT JOIN bind b ON b.eth_id = l.account_id')
    expect(body).toContain('GROUP BY holder_id, asset_id')
    expect(body).toContain('HAVING total_bal > 0')
    // Display assets count accounts, like their detail page, not list rows.
    const folded = explorerService.slice(explorerService.indexOf('async function foldedDisplayHolderCounts'))
    expect(folded.slice(0, folded.indexOf('\n}'))).toContain('holderAccountCount(holders)')
  })

  it('HDX dashboard supply and cohorts', () => {
    const at = hdxService.indexOf('async function loadSupplyCohorts')
    const body = hdxService.slice(at, hdxService.indexOf('\nasync function loadDailyFlows', at))
    expect(body).toContain('${bindCteSql()}')
    expect(body).toContain("${boundAccountSql('l')} AS account_id")
    expect(body).toContain('LEFT JOIN bind b ON b.eth_id = l.account_id')
    expect(body).toContain('GROUP BY account_id HAVING bal > 0')
  })

  it('HOLLAR dashboard supply', () => {
    const sql = hollarSupplySql()
    expect(sql).toContain(bindCteSql())
    expect(sql).toContain(`${fold} AS account_id`)
    expect(sql).toContain('LEFT JOIN bind b ON b.eth_id = l.account_id')
  })

  it('maps a bound ETH-form id onto its owner and leaves every other account as itself', () => {
    expect(fold).toContain("ifNull(b.owner, '') != ''")
    expect(fold).toContain('l.account_id')
    expect(bindCteSql()).toContain("relationship = 'explicit_binding'")
  })
})
