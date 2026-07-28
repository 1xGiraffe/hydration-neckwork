import { describe, it, expect, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExternalAccountPill } from '../src/components/ActivityTable'
import { setTagMap } from '../src/userTags'
import type { ActivityRow } from '../src/types'

// A cross-chain row for an account that is a bound-EVM signer on Hydration: the
// wire `raw`/`address` carry the bare H160, but the server resolves it to the
// substrate account it is bound to (see explorerService.ts's externalAccountRef —
// `resolved`/`accountId`), the exact id user tags/pills key their members on.
const RESOLVED_ACCOUNT_ID = '0x' + 'bb'.repeat(32)
const RAW_H160 = '0x' + '11'.repeat(20)

const account: NonNullable<ActivityRow['destAccount']> = {
  kind: 'AccountKey20', accountId: RESOLVED_ACCOUNT_ID, address: RAW_H160, raw: RAW_H160, subscanUrl: null,
  tag: null, identity: null,
}

describe('ExternalAccountPill keys the viewer tag lookup on the resolved accountId, not the raw H160', () => {
  beforeEach(() => setTagMap({
    libraries: [{
      libraryId: 'lib1', name: 'Mine',
      tags: [{ tagId: 't1', name: 'My Bound Wallet', color: '#0f0', icon: '🐳', members: [RESOLVED_ACCOUNT_ID] }],
    }],
  }))

  it('shows the viewer tag for a bound-EVM external account, matched by its resolved accountId', () => {
    const html = renderToStaticMarkup(<ExternalAccountPill account={account} />)
    expect(html).toContain('My Bound Wallet')
  })

  it('falls back to raw/address (and so misses the tag) for a legacy payload with no accountId field', () => {
    const legacy = { ...account, accountId: undefined }
    const html = renderToStaticMarkup(<ExternalAccountPill account={legacy} />)
    expect(html).not.toContain('My Bound Wallet')
  })
})
