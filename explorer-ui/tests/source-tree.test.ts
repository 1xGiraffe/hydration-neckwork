import { describe, it, expect } from 'vitest'
import { buildFileTree, pickMainSource } from '../src/utils/sourceTree'

// A verified Solidity contract ships its whole compiler input — 31 files for a
// WormholeTransceiver, most of them vendored dependencies. The tree is what makes
// that readable, so it has to collapse the dependency chains and open on the file
// the reader actually came for.
const WORMHOLE = [
  'lib/openzeppelin-contracts/contracts/interfaces/draft-IERC1822.sol',
  'lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Upgrade.sol',
  'lib/openzeppelin-contracts/contracts/utils/Address.sol',
  'src/interfaces/IWormholeTransceiver.sol',
  'src/libraries/TransceiverStructs.sol',
  'src/Transceiver/WormholeTransceiver/WormholeTransceiver.sol',
]

describe('buildFileTree', () => {
  it('collapses single-child directory chains into one label', () => {
    const tree = buildFileTree(['lib/openzeppelin-contracts/contracts/utils/Address.sol'])
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ kind: 'dir', name: 'lib/openzeppelin-contracts/contracts/utils' })
    expect(tree[0]).toHaveProperty('children.0.path', 'lib/openzeppelin-contracts/contracts/utils/Address.sol')
  })

  it('stops collapsing where a directory branches, and keeps full paths on leaves', () => {
    const tree = buildFileTree(WORMHOLE)
    const lib = tree.find(n => n.name.startsWith('lib/'))!
    // Three sibling subtrees under .../contracts, so the chain collapses only to there.
    expect(lib.name).toBe('lib/openzeppelin-contracts/contracts')
    expect(lib).toHaveProperty('children')
    const src = tree.find(n => n.name === 'src')!
    expect(src.kind).toBe('dir')
    const leaves: string[] = []
    const walk = (nodes: ReturnType<typeof buildFileTree>) => {
      for (const n of nodes) {
        if (n.kind === 'file') leaves.push(n.path)
        else walk(n.children)
      }
    }
    walk(tree)
    expect(leaves.sort()).toEqual([...WORMHOLE].sort())
  })

  it('lists directories before files and sorts each alphabetically', () => {
    const tree = buildFileTree(['Zed.sol', 'Alpha.sol', 'src/A.sol'])
    expect(tree.map(n => n.name)).toEqual(['src', 'Alpha.sol', 'Zed.sol'])
  })

  it('tolerates empty input and leading/duplicate slashes', () => {
    expect(buildFileTree([])).toEqual([])
    expect(buildFileTree(['/src//A.sol'])).toHaveProperty('0.children.0.path', 'src/A.sol')
  })
})

describe('pickMainSource', () => {
  it('opens the file declaring the verified contract, not the first dependency', () => {
    expect(pickMainSource(WORMHOLE, 'WormholeTransceiver'))
      .toBe('src/Transceiver/WormholeTransceiver/WormholeTransceiver.sol')
  })

  it('falls back to a project source over a vendored one when the name does not match', () => {
    expect(pickMainSource(WORMHOLE, 'NotHere')).toBe('src/interfaces/IWormholeTransceiver.sol')
  })

  it('takes the shallowest path when everything is vendored, and nothing when there are no files', () => {
    expect(pickMainSource(['lib/a/b/c/Deep.sol', 'lib/a/Shallow.sol'])).toBe('lib/a/Shallow.sol')
    expect(pickMainSource([])).toBeUndefined()
  })
})
