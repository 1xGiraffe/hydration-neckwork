import { describe, expect, it } from 'vitest'
import { walletBalanceRows } from '../src/services/erc20WalletService.ts'

// The refresh reads ~1.2k HOLLAR holders in batched eth_calls. A batch that times
// out or comes back as an error leaves its addresses unread, and the published
// table is the newest version everywhere the explorer prices HOLLAR — so an
// unread holder must keep its previous row rather than be published as zero.
const h = (n: number) => '0x' + n.toString(16).padStart(40, '0')
const anchorOf = (evm: string) => `0x45544800${evm.slice(2)}0000000000000000`

describe('erc20 wallet refresh rows', () => {
  it('publishes only the holders it could read', () => {
    const h160s = [h(1), h(2), h(3)]
    const balances = new Map([[h(1), 5n], [h(3), 7n]])

    const rows = walletBalanceRows(222, h160s, balances, anchorOf, [])

    expect(rows).toEqual([
      { account_id: anchorOf(h(1)), asset_id: '222', total: '5' },
      { account_id: anchorOf(h(3)), asset_id: '222', total: '7' },
    ])
  })

  it('publishes a genuine zero balance', () => {
    const rows = walletBalanceRows(222, [h(1)], new Map([[h(1), 0n]]), anchorOf, [])

    expect(rows).toEqual([{ account_id: anchorOf(h(1)), asset_id: '222', total: '0' }])
  })

  it('does not zero an unread holder that already has a balance', () => {
    const h160s = [h(1), h(2)]
    const previous = [anchorOf(h(1)), anchorOf(h(2))]

    const rows = walletBalanceRows(222, h160s, new Map([[h(1), 5n]]), anchorOf, previous)

    expect(rows.map(r => r.account_id)).toEqual([anchorOf(h(1))])
    expect(rows.find(r => r.account_id === anchorOf(h(2)))).toBeUndefined()
  })

  it('still zeroes a key that no longer belongs to any holder', () => {
    const stale = '0x45544800dead0000000000000000000000000000000000000000'

    const rows = walletBalanceRows(222, [h(1)], new Map([[h(1), 5n]]), anchorOf, [anchorOf(h(1)), stale])

    expect(rows).toContainEqual({ account_id: stale, asset_id: '222', total: '0' })
  })

  it('keeps a re-anchored holder from being zeroed by the stale pass', () => {
    // The holder's anchor moved from the ETH-prefixed form to an alias-linked
    // substrate account; the old key is stale, the new one is current.
    const substrate = '0x' + 'ab'.repeat(32)
    const moved = (evm: string) => (evm === h(1) ? substrate : anchorOf(evm))

    const rows = walletBalanceRows(222, [h(1)], new Map([[h(1), 5n]]), moved, [anchorOf(h(1))])

    expect(rows).toEqual([
      { account_id: substrate, asset_id: '222', total: '5' },
      { account_id: anchorOf(h(1)), asset_id: '222', total: '0' },
    ])
  })
})
