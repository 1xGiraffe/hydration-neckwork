import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { HealthSimBadge } from '../src/pages/Accounts'
import { healthFactorDisplay } from '../src/components/ui'
import { defisimAccountTarget } from '../src/utils/defisim'

describe('HealthSimBadge — two-sided health factor / DefiSim link', () => {
  it('renders the factor and the DefiSim side inside one link', () => {
    const html = renderToStaticMarkup(<HealthSimBadge hf={healthFactorDisplay('1410000000000000000')} addr="0xabc" />)
    expect(html).toContain('hf-badge')
    expect(html).toContain('1.41')
    expect(html).toContain('hf-warn')
    expect(html).toContain('DefiSim')
    expect(html).toContain('https://defisim.neckwork.net/?address=0xabc')
    expect(html.match(/<a /g)).toHaveLength(1)
  })
  it('renders a pure supplier as "No debt" with the link intact', () => {
    const html = renderToStaticMarkup(<HealthSimBadge hf={healthFactorDisplay('inf')} addr="0xdef" />)
    expect(html).toContain('No debt')
    expect(html).toContain('DefiSim')
  })
})

describe('DefiSim account target', () => {
  it('uses H160 for EVM accounts and AccountId32 for substrate accounts', () => {
    expect(defisimAccountTarget({
      accountId: '0x4554480076a497415fc75a15a2014b49e2d53bf748c30a8f0000000000000000',
      address: '0x76a497415fc75a15a2014b49e2d53bf748c30a8f',
    })).toBe('0x76a497415fc75a15a2014b49e2d53bf748c30a8f')
    expect(defisimAccountTarget({ accountId: '0x1234', address: '16abc' })).toBe('0x1234')
  })
})
