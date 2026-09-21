import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { absentMemberRows, type TopAccountRow } from '../src/services/explorerService'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

const SUBSTRATE = `0x${'ab'.repeat(32)}`
const H160 = `0x${'cd'.repeat(20)}`
// The ETH-marker AccountId32 an H160 is stored as (see evmFromAccountId).
const EVM_MEMBER = `0x45544800${H160.slice(2)}0000000000000000`

const presentRow = (accountId: string): TopAccountRow => ({
  account: { accountId, address: accountId, emoji: '', emojiName: '', emojiUrl: '', tag: null, identity: null, profile: null },
  tag: null, portfolioUsd: 1234, lastBlock: 14_800_000, suppliedUsd: null, borrowedUsd: null,
} as TopAccountRow)

// A tag names its members; the accounts directory only knows the ones Hydration
// has seen hold, lend or provide something. The page has to show both, or a tag
// that says "3 accounts" renders two rows and the missing one is unexplained.
describe('a tag member with no accounts-directory row', () => {
  it('still gets a row, carrying nothing the directory did not have', () => {
    const rows = absentMemberRows([SUBSTRATE, EVM_MEMBER], [presentRow(SUBSTRATE)])
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row.account?.accountId).toBe(EVM_MEMBER)
    // The EVM form is what a reader recognises the account by.
    expect(row.account?.address).toBe(H160)
    // No group pill (the row IS a member of the tag being read), and nothing
    // claimed beyond the $0 that "in none of the value sources" means.
    expect(row.tag).toBeNull()
    expect(row.portfolioUsd).toBe(0)
    expect(row.suppliedUsd).toBeNull()
    expect(row.borrowedUsd).toBeNull()
    expect(row.activityCount).toBeUndefined()
    expect(row.tradingVolumeUsd).toBeUndefined()
    expect(row.topAssets).toBeUndefined()
    expect(row.sparkline).toBeUndefined()
  })

  it('adds nothing for a member the directory already covers', () => {
    expect(absentMemberRows([SUBSTRATE], [presentRow(SUBSTRATE)])).toEqual([])
    // Case is not part of the identity: the stored member id and the directory
    // row can disagree on it without producing a duplicate.
    expect(absentMemberRows([SUBSTRATE.toUpperCase().replace('0X', '0x')], [presentRow(SUBSTRATE)])).toEqual([])
  })

  it('never adds the same account twice, however often the tag lists it', () => {
    expect(absentMemberRows([EVM_MEMBER, EVM_MEMBER], [])).toHaveLength(1)
  })

  it('keeps every unseen member, in the order the caller listed them', () => {
    const other = `0x${'12'.repeat(32)}`
    const rows = absentMemberRows([EVM_MEMBER, other], [])
    expect(rows.map(r => r.account?.accountId)).toEqual([EVM_MEMBER, other])
  })
})

// The padding above must stay the LAST resort, not the answer to a member the
// directory does have under another name. A tag stores whichever address form
// its author wrote down, and the directory keys its rows by the display
// identity — so the scope has to be resolved before it is asked for. It was not,
// and the BIL distribution wallet (stored as the stableswap pool's H160, a shape
// the query's own boundAccountSql does not unwind) matched nothing: a $607k
// account missing from its own tag. Resolving it offline needs live tag state,
// so this pins the call instead.
describe('the member scope is resolved to the identity the directory keys rows by', () => {
  const fn = (): string => {
    const at = explorerService.indexOf('export async function getAccountsForMembers(')
    expect(at).toBeGreaterThan(-1)
    return explorerService.slice(at, explorerService.indexOf('\n}\n', at))
  }

  it('resolves each member id before handing the scope to the query', () => {
    expect(fn()).toContain('members.map(m => memberRowKey(resolveDisplayAccountId(m.toLowerCase())))')
  })

  it('orders a keepOrder page by the same resolved identity', () => {
    // The owner's arrangement is keyed on the member ids they stored; the rows
    // come back under their display ids. Match them on anything else and every
    // remapped member sorts to the end as "unplaced".
    expect(fn()).toContain('members.map((m, i) => [memberRowKey(resolveDisplayAccountId(m)), i])')
  })
})
