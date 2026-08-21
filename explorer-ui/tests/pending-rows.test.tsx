import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { pendingRows } from '../src/components/ui'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
const hooks = read('../src/hooks/useExplorerData.ts')

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1

// The list hooks carry `placeholderData: keepPreviousData`, so on a filter, tab, sort
// or page change the outgoing rows stay on screen while the new key loads. That
// removed a ~900px height jump — but it also means `rows.length === 0` can never
// happen for those changes, which silently made every `isFetching && !rows.length`
// skeleton gate unreachable for exactly the interactions a reader performs on
// purpose. The held rows then read as the answer to a filter they do not answer;
// on the global activity feed, where a high "$ from" takes tens of seconds, that is
// indistinguishable from the filter being ignored.
//
// pendingRows is the replacement signal. These assertions pin how many surfaces
// carry it, because a guard whose match count can reach zero without failing is
// not a guard — which is precisely how the skeleton gate it replaces died.
describe('held rows are marked pending, not presented as an answer', () => {
  it('marks a pending body busy and leaves a settled one untouched', () => {
    expect(pendingRows(true)).toEqual({ className: 'rows-pending', 'aria-busy': true })
    expect(pendingRows(false)).toEqual({})
    expect(pendingRows(undefined)).toEqual({})
  })

  it('renders aria-busy so the state is not colour-only', () => {
    const html = renderToStaticMarkup(
      <table><tbody {...pendingRows(true)}><tr><td>held</td></tr></tbody></table>,
    )
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('class="rows-pending"')
    const settled = renderToStaticMarkup(
      <table><tbody {...pendingRows(false)}><tr><td>fresh</td></tr></tbody></table>,
    )
    expect(settled).not.toContain('aria-busy')
    expect(settled).not.toContain('rows-pending')
  })

  it('dims the held body in the stylesheet without restoring it on hover', () => {
    const css = read('../src/styles/global.css')
    expect(occurrences(css, '.tbl tbody.rows-pending {')).toBe(1)
    // .dim restores full opacity on hover because those rows are real. These are
    // stale whether or not you point at them, so hover must not un-dim them.
    expect(css).not.toContain('.tbl tbody.rows-pending:hover { opacity: 1')
  })
})

// Every hook that holds its previous rows needs a consumer that says so. This pairs
// the two lists rather than counting one of them, so adding a keepPreviousData hook
// without a pending signal fails here instead of shipping a silently stale table.
describe('every list that holds rows has a surface that marks them', () => {
  // Each hook's own body only: the next `export function` bounds it, so a
  // keepPreviousData in the hook below is never miscounted as this one's.
  const declarations = [...hooks.matchAll(/export function (use[A-Za-z]+)\(/g)]
    .map(m => ({ name: m[1], at: m.index ?? 0 }))
  const holdingHooks = declarations
    .filter((h, i) => hooks.slice(h.at, declarations[i + 1]?.at ?? hooks.length).includes('keepPreviousData'))
    .map(h => h.name)

  // `useDaily` is the one holder that feeds no table — it is the day histogram, and
  // charts were keepPreviousData's original users. It has the same unreachable gate
  // (`loading={!daily}` can no longer fire once a series has loaded), so its filtered
  // series is stale without saying so; that is a chart fix, tracked separately, and
  // named here so it is an acknowledged exemption rather than an oversight.
  const CHART_ONLY = ['useDaily']

  it('holds rows in exactly the paged list hooks, plus the day chart', () => {
    expect(holdingHooks.sort()).toEqual([
      'useAccountActivity', 'useAccountEvents', 'useAccountExtrinsics', 'useAccountVotes',
      'useAccounts', 'useActivity', 'useAssetActivity', 'useBlocks',
      'useContractEvents', 'useContractTransactions', 'useContracts', 'useDaily', 'useEvents',
      'useExtrinsics', 'useGovernanceMotions', 'useGovernanceReferenda', 'useGovernanceTips',
      'useHolders', 'useOmnipoolLps', 'usePoolLps', 'useTagActivity', 'useTagEvents',
      'useTagExtrinsics', 'useTagVotes', 'useTagVotesByReferendum',
    ])
    expect(holdingHooks.filter(h => CHART_ONLY.includes(h))).toEqual(CHART_ONLY)
  })

  it('marks held rows on every table those hooks feed', () => {
    const surfaces = {
      '../src/pages/Activity.tsx': 1,
      '../src/pages/Events.tsx': 1,
      '../src/pages/Extrinsics.tsx': 1,
      '../src/pages/Blocks.tsx': 1,
      '../src/pages/Accounts.tsx': 1,
      '../src/pages/AssetDetail.tsx': 2,        // activity feed + holders
      '../src/pages/PoolDetail.tsx': 1,          // liquidity providers
      '../src/components/AssetLiquidity.tsx': 1, // top Omnipool LPs
      '../src/components/ScopedActivity.tsx': 3, // activity, extrinsics, events tabs
      '../src/components/VotesTab.tsx': 1,
      '../src/components/ContractActivityTab.tsx': 2, // transactions + events sub-tabs
      '../src/pages/Governance.tsx': 3,          // referenda, motions, tips tables
    }
    for (const [path, expected] of Object.entries(surfaces)) {
      const src = read(path)
      // `pending={…isPlaceholderData}` specifically: other components on these
      // pages take a `pending` prop for a write in flight (the asset header's
      // alert dialog), which is not a held-rows signal and must not be counted
      // as one.
      const marks = occurrences(src, 'pendingRows(') + (src.match(/pending=\{[^}]*isPlaceholderData[^}]*\}/g)?.length ?? 0)
      expect(marks, path).toBe(expected)
      // A surface that reads isPlaceholderData but never renders it would pass a
      // bare "mentions pendingRows" check, so require the read as well.
      expect(src, path).toContain('isPlaceholderData')
    }
  })

  it('threads pending through the two shared row tables', () => {
    for (const path of ['../src/components/ActivityTable.tsx', '../src/components/VotesTable.tsx']) {
      const src = read(path)
      expect(occurrences(src, 'pendingRows(pending)'), path).toBe(1)
      expect(src, path).toContain('pending?: boolean')
    }
  })
})
