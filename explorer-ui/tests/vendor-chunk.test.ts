import { describe, expect, it } from 'vitest'
import config from '../vite.config'

// React, react-dom, scheduler and React Query only change on a dependency upgrade.
// Keeping them out of the entry chunk is what lets a returning reader skip them
// after a deploy that touched app code alone, so pin the split here: sharing one
// content hash silently costs every returning reader the whole runtime again.
describe('build output', () => {
  const output = config.build?.rollupOptions?.output
  const manualChunks = (Array.isArray(output) ? output[0] : output)?.manualChunks
  const chunkOf = (id: string) => (manualChunks as (id: string) => string | undefined)(id)

  it('routes dependencies into one vendor chunk', () => {
    expect(typeof manualChunks).toBe('function')
    for (const dep of ['react', 'react-dom', 'scheduler', '@tanstack/query-core', '@tanstack/react-query']) {
      expect(chunkOf(`/app/node_modules/${dep}/index.js`)).toBe('vendor')
    }
  })

  it('leaves app code in the chunks the router splits it into', () => {
    for (const id of ['/app/src/main.tsx', '/app/src/pages/Accounts.tsx', '/app/src/components/ui.tsx']) {
      expect(chunkOf(id)).toBeUndefined()
    }
  })

  // viem is only ever imported by the lazy ABI-codec module (src/abiCodec.ts,
  // dynamic import from the contract tab). Routing it into `vendor` would make
  // every visitor download an ABI codec they never use; it gets its own chunk
  // that loads with the tab.
  it('keeps the ABI codec out of the vendor chunk', () => {
    for (const dep of ['viem', 'abitype', 'ox']) {
      expect(chunkOf(`/app/node_modules/${dep}/index.js`)).toBe('abi-codec')
    }
    expect(chunkOf('/app/node_modules/react/index.js')).toBe('vendor')
  })
})
