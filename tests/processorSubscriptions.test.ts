import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The indexer's price-irrelevance skip reads pool-reserve transfers out of
// `block.events`, which carries only what processor.ts subscribes: a transfer
// event named in POOL_TRANSFER_EVENTS but not subscribed matches nothing, and the
// block it moved a reserve in is skipped as price-irrelevant.

const indexer = readFileSync(new URL('../src/indexer.ts', import.meta.url), 'utf8')
const processor = readFileSync(new URL('../src/processor.ts', import.meta.url), 'utf8')

function poolTransferEvents(): string[] {
  const m = indexer.match(/const POOL_TRANSFER_EVENTS = new Set\(\[([^\]]*)\]\)/)
  expect(m).not.toBeNull()
  return [...m![1].matchAll(/'([^']+)'/g)].map(x => x[1])
}

function subscribedEvents(): Set<string> {
  const block = processor.slice(processor.indexOf('.addEvent({'), processor.indexOf('.addEvmLog('))
  return new Set([...block.matchAll(/^\s*'([A-Za-z]+\.[A-Za-z0-9]+)',/gm)].map(x => x[1]))
}

describe('pool-reserve transfer events', () => {
  it('covers every event that moves a pool reserve: tokens, aToken/ERC-20 legs and native HDX', () => {
    expect(poolTransferEvents().sort()).toEqual(['Balances.Transfer', 'Currencies.Transferred', 'Tokens.Transfer'])
  })

  it('subscribes every one of them in the processor', () => {
    const subscribed = subscribedEvents()
    expect(subscribed.has('Omnipool.SellExecuted')).toBe(true)   // the parser sees the list
    for (const name of poolTransferEvents()) expect(subscribed.has(name), name).toBe(true)
  })
})
