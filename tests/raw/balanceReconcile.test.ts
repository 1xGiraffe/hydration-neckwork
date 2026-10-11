import { describe, expect, it } from 'vitest'
import {
  BalanceReconciler,
  ZERO_SIGNATURE,
  balanceSignature,
  balanceSweepMode,
  pairKey,
  type ProjectedBalance,
} from '../../src/raw/balanceReconcile.ts'
import { snapshotAbsentRows } from '../../src/raw/balance.ts'
import * as systemStorage from '../../src/types/system/storage.ts'
import * as tokensStorage from '../../src/types/tokens/storage.ts'
import type { RawBalanceObservationRow } from '../../src/raw/types.ts'
import type { Block as StorageBlock } from '../../src/types/support.ts'

const A = '0x' + 'aa'.repeat(32)
const B = '0x' + 'bb'.repeat(32)
const C = '0x' + 'cc'.repeat(32)
const ANCHOR = 1_000

function row(account: string, asset: string, total: string, free = total, reserved = '0'): RawBalanceObservationRow {
  return {
    block_height: ANCHOR,
    block_timestamp: '2026-10-10 00:00:00',
    observation_id: `snapshot_reconcile:x:none:${account}:substrate:${asset}`,
    account_id: account,
    asset_kind: 'substrate',
    asset_id: asset,
    free,
    reserved,
    frozen: '0',
    total,
    nonce: null,
    flags: null,
    source_kind: 'snapshot_reconcile',
    source_name: asset === '0' ? 'System.Account' : 'Tokens.Accounts',
    source_event_index: null,
    source_call_address: null,
    evidence_json: '{}',
    ingest_source: 'rpc',
  } as RawBalanceObservationRow
}

function projected(entries: Array<[string, string, string, number]>): Map<string, ProjectedBalance> {
  return new Map(entries.map(([account, asset, total, lastBlock]) => [
    pairKey(account, asset),
    { sig: balanceSignature(total, total, '0'), lastBlock },
  ]))
}

describe('balance reconcile', () => {
  it('writes nothing when storage equals the projection as of the anchor', () => {
    const r = new BalanceReconciler(projected([[A, '0', '5', 900], [A, '5', '7', ANCHOR]]), ANCHOR)
    expect(r.filter([row(A, '0', '5'), row(A, '5', '7')])).toEqual([])
    expect(r.absentPairs({ native: true, tokens: true })).toEqual([])
    expect(r.diffCount()).toBe(0)
    expect(r.stats).toMatchObject({ compared: 2, unchanged: 2, changed: 0, missing: 0, absent: 0 })
  })

  it('writes a changed balance and a pair the projection never observed', () => {
    const r = new BalanceReconciler(projected([[A, '0', '5', 900]]), ANCHOR)
    const kept = r.filter([row(A, '0', '6'), row(B, '0', '1')])
    expect(kept.map(k => [k.account_id, k.total])).toEqual([[A, '6'], [B, '1']])
    expect(r.stats).toMatchObject({ changed: 1, missing: 1 })
    expect(r.examples.map(e => e.kind)).toEqual(['changed', 'missing'])
  })

  it('compares free and reserved, not only the total', () => {
    const r = new BalanceReconciler(projected([[A, '0', '5', 900]]), ANCHOR)
    expect(r.filter([row(A, '0', '5', '4', '1')])).toHaveLength(1)
  })

  it('skips a pair the projection observed above the anchor', () => {
    const r = new BalanceReconciler(projected([[A, '0', '5', ANCHOR + 1]]), ANCHOR)
    expect(r.filter([row(A, '0', '9')])).toEqual([])
    expect(r.stats.superseded).toBe(1)
    expect(r.diffCount()).toBe(0)
  })

  it('names non-zero projected pairs storage no longer holds, within the read scope', () => {
    const r = new BalanceReconciler(projected([
      [A, '0', '5', 900], // reaped: absent
      [B, '0', '0', 900], // zero already: nothing to restate
      [C, '0', '5', ANCHOR + 1], // observed after the anchor
      [A, '7', '3', 900], // token entry removed
    ]), ANCHOR)
    r.filter([])
    expect(r.absentPairs({ native: true, tokens: false })).toEqual([{ accountId: A, assetId: '0' }])
    const all = new BalanceReconciler(r['projection'], ANCHOR)
    expect(all.absentPairs({ native: true, tokens: true })).toEqual([
      { accountId: A, assetId: '0' },
      { accountId: A, assetId: '7' },
    ])
    expect(all.stats.absent).toBe(2)
  })

  it('does not call an enumerated pair absent', () => {
    const r = new BalanceReconciler(projected([[A, '0', '5', 900]]), ANCHOR)
    r.filter([row(A, '0', '5')])
    expect(r.absentPairs({ native: true, tokens: true })).toEqual([])
  })

  it('treats a NULL projected balance as a difference', () => {
    const r = new BalanceReconciler(new Map([[pairKey(A, '0'), { sig: balanceSignature(null, null, null), lastBlock: 900 }]]), ANCHOR)
    expect(r.filter([row(A, '0', '0')])).toHaveLength(1)
    expect(ZERO_SIGNATURE).toBe(balanceSignature('0', '0', '0'))
  })

  it('caps the examples', () => {
    const r = new BalanceReconciler(new Map(), ANCHOR, 2)
    r.filter([row(A, '0', '1'), row(B, '0', '1'), row(C, '0', '1')])
    expect(r.examples).toHaveLength(2)
    expect(r.stats.missing).toBe(3)
  })

  it('seeds a database no full seed was written to, reconciles otherwise', () => {
    expect(balanceSweepMode({ reconcile: true, seeded: false })).toBe('seed')
    expect(balanceSweepMode({ reconcile: true, seeded: true })).toBe('reconcile')
    expect(balanceSweepMode({ reconcile: false, seeded: true })).toBe('seed')
  })
})

describe('snapshotAbsentRows', () => {
  it('writes the storage default, labelled as a reconcile row', () => {
    const block = { height: ANCHOR, hash: '0x01' } as unknown as StorageBlock
    const sys = systemStorage.account.v205 as unknown as Record<string, unknown>
    const tok = tokensStorage.accounts.v108 as unknown as Record<string, unknown>
    const saved = { sysIs: sys.is, sysDefault: sys.getDefault, tokIs: tok.is, tokDefault: tok.getDefault }
    sys.is = () => true
    sys.getDefault = () => ({ nonce: 0, consumers: 0, providers: 0, sufficients: 0, data: { free: 0n, reserved: 0n, frozen: 0n, flags: 0n } })
    tok.is = () => true
    tok.getDefault = () => ({ free: 0n, reserved: 0n, frozen: 0n })
    try {
      const rows = snapshotAbsentRows(block, '2026-10-10 00:00:00', 'rpc', 'snapshot_reconcile', [
        { accountId: A, assetId: '0' },
        { accountId: A, assetId: '7' },
      ])
      expect(rows.map(r => [r.account_id, r.asset_id, r.source_name, r.source_kind, r.total, r.free, r.reserved, r.block_height])).toEqual([
        [A, '0', 'System.Account', 'snapshot_reconcile', '0', '0', '0', ANCHOR],
        [A, '7', 'Tokens.Accounts', 'snapshot_reconcile', '0', '0', '0', ANCHOR],
      ])
      // Distinct from a seed row of the same pair at the same block.
      expect(rows[0].observation_id.startsWith('snapshot_reconcile:')).toBe(true)
    } finally {
      Object.assign(sys, { is: saved.sysIs, getDefault: saved.sysDefault })
      Object.assign(tok, { is: saved.tokIs, getDefault: saved.tokDefault })
    }
  })
})
