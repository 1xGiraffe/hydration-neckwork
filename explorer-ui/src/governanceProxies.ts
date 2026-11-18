// Proxies as governance sees them. Only an Any or a Governance proxy with no delay can
// vote (the runtime's ProxyType filter, hydration-node runtime/hydradx/src/system.rs);
// a delayed one would have to announce each call and wait it out, which the explorer
// does not do. Whether a relation can vote is the api's `canVote`; `blocked` says
// why not (an older api sends only `canVote`, and the reason is then read from the
// relation itself, by the same rule).

export type ProxyBlock = 'delay' | 'type'

export interface ProxyRelationRow {
  proxyType: string
  delay: number
  canVote: boolean
  blocked?: ProxyBlock | null
  /** The related account (the page's account or its EVM twin) the relation belongs to. */
  holder?: string
}

/** Why a relation cannot vote, or null when it can. */
export function proxyBlock(p: ProxyRelationRow): ProxyBlock | null {
  if (p.canVote) return null
  if (p.blocked) return p.blocked
  return p.proxyType === 'Any' || p.proxyType === 'Governance' ? 'delay' : 'type'
}

/** A proxy delay in time at the chain's measured pace ("about 26 hours"), or in blocks when the pace is unknown. */
export function delayText(blocks: number, msPerBlock: number | null | undefined): string {
  if (!msPerBlock || msPerBlock <= 0) return `${blocks.toLocaleString('en-US')} blocks`
  const minutes = (blocks * msPerBlock) / 60_000
  if (minutes < 90) return `about ${Math.max(1, Math.round(minutes))} minutes`
  const hours = minutes / 60
  if (hours < 48) return `about ${Math.round(hours)} hours`
  return `about ${Math.round(hours / 24)} days`
}

/** The reason in words, for a badge's tooltip and the voter picker. */
export function proxyBlockReason(p: ProxyRelationRow, msPerBlock: number | null | undefined): string | null {
  const why = proxyBlock(p)
  if (why === 'type') return `A ${p.proxyType} proxy cannot vote: only Any and Governance proxies can.`
  if (why === 'delay') return `A delayed proxy (${delayText(p.delay, msPerBlock)}, ${p.delay.toLocaleString('en-US')} blocks) must announce each call and wait that long before making it; the explorer cannot vote through it.`
  return null
}

/** The relations that can vote first, each group in the order given. */
export function splitByVote<T extends ProxyRelationRow>(rows: T[]): { voting: T[]; other: T[] } {
  return { voting: rows.filter(r => r.canVote), other: rows.filter(r => !r.canVote) }
}

/**
 * The relations a signer may be offered to vote through, one per account: only Any and
 * Governance proxies (other types are not listed at all), only relations that belong to
 * the signer itself (the api may merge in its EVM twin's), and for an account reached
 * more than once the one that can vote — Any over Governance, since only Any may also
 * claim GIGAHDX rewards. Those that can vote come first.
 */
export function proxiesToOffer<T extends ProxyRelationRow & { account: { accountId: string } }>(rows: T[], signerId: string): T[] {
  const me = signerId.toLowerCase()
  const best = new Map<string, T>()
  const rank = (p: T) => (p.canVote ? 2 : 0) + (p.proxyType === 'Any' ? 1 : 0)
  for (const p of rows) {
    const id = p.account.accountId
    if (!/^0x[0-9a-f]{64}$/i.test(id)) continue
    if (p.holder && p.holder.toLowerCase() !== me) continue
    if (p.proxyType !== 'Any' && p.proxyType !== 'Governance') continue
    const k = id.toLowerCase()
    const prev = best.get(k)
    if (!prev || rank(p) > rank(prev)) best.set(k, p)
  }
  const out = [...best.values()]
  return [...out.filter(p => p.canVote), ...out.filter(p => !p.canVote)]
}
