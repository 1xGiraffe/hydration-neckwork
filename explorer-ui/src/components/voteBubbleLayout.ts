import type { AccountRef, ReferendumVoter } from '../types'
import type { ResolvedTag } from '../userTags'

// Layout maths for the vote bubble map, kept out of the component file so the
// component module exports only components (and so the scaling is unit-testable).
//
// AREA encodes power, not radius: a 6x-conviction whale outweighs a small voter by
// orders of magnitude, and a linear radius would render everyone else as a dot.
export const WIDTH = 720
export const HEIGHT = 720   // square: the cluster reads as one population, not a band
export const MIN_R = 3

// A bubble carries its account label only once the label fits inside it. Laid out in a
// row like a list pill, icon plus shortened address needs roughly 88 units of the
// 720-wide space, and a circle only offers about 1.8r of usable chord width — hence
// r >= 50. The icon alone needs about 28. Below that a label would spill past its own
// circle, so the bubble stays bare and the hover card does the identifying.
export const LABEL_FULL_R = 50
export const LABEL_EMOJI_R = 15

export type BubbleSide = 'aye' | 'nay' | 'split'

// Several tag members' live votes combined into one bubble. Sums are exact
// integer strings (planck), like the voter fields they fold; the capital-
// weighted average conviction is derived from weighted/balance at render time.
export interface TagVoteGroup {
  tag: ResolvedTag
  voters: number
  weightedAye: string
  weightedNay: string
  weighted: string
  balance: string
}

// What the packer lays out: a lone voter, or a tag's combined votes.
export type PackItem =
  | { kind: 'voter'; voter: ReferendumVoter }
  | { kind: 'tag'; group: TagVoteGroup }

export interface Bubble {
  item: PackItem
  x: number
  y: number
  r: number
  side: BubbleSide
  weight: number
  label: 'full' | 'emoji' | 'none'
}

// A Split vote backs both sides at once, so it is neither aye nor nay.
export function bubbleSide(voter: { weightedAye: string; weightedNay: string }): BubbleSide {
  const aye = Number(voter.weightedAye), nay = Number(voter.weightedNay)
  if (aye > 0 && nay > 0) return 'split'
  return nay > 0 ? 'nay' : 'aye'
}

// Fold live voters under their resolved tags — the same one-winner-per-account
// resolution every pill uses (resolveTag: viewer's lists in priority order with
// 'system' as a slot), so a bubble groups exactly like the accounts directory
// and the holders list fold. A tag with a single live voter stays an individual
// bubble: its label already reads as the tag, and the account-level hover and
// link say strictly more than a group of one would.
export function foldVoters(voters: ReferendumVoter[], resolve: (account: AccountRef) => ResolvedTag | null): PackItem[] {
  // Withdrawn votes back nothing, so they are not plotted — the tally excludes them too.
  const live = voters.filter(voter => !voter.removed && Number(voter.weighted) > 0)
  const byTag = new Map<string, { tag: ResolvedTag; members: ReferendumVoter[] }>()
  const items: PackItem[] = []
  const slotByTag = new Map<string, number>()
  for (const voter of live) {
    const tag = voter.account ? resolve(voter.account) : null
    if (!tag) { items.push({ kind: 'voter', voter }); continue }
    const hit = byTag.get(tag.id)
    if (hit) { hit.members.push(voter); continue }
    byTag.set(tag.id, { tag, members: [voter] })
    // The group renders where its first member would have — keep that slot.
    slotByTag.set(tag.id, items.length)
    items.push({ kind: 'voter', voter })
  }
  for (const [tagId, { tag, members }] of byTag) {
    if (members.length < 2) continue
    let aye = 0n, nay = 0n, weighted = 0n, balance = 0n
    for (const m of members) {
      aye += BigInt(m.weightedAye)
      nay += BigInt(m.weightedNay)
      weighted += BigInt(m.weighted)
      balance += BigInt(m.balance)
    }
    // The first member's slot becomes the group (later members were never
    // pushed as their own items), so folding leaves no member bubble behind.
    items[slotByTag.get(tagId)!] = {
      kind: 'tag',
      group: {
        tag, voters: members.length,
        weightedAye: aye.toString(), weightedNay: nay.toString(),
        weighted: weighted.toString(), balance: balance.toString(),
      },
    }
  }
  return items
}

function itemWeight(item: PackItem): number {
  return Number(item.kind === 'voter' ? item.voter.weighted : item.group.weighted)
}
function itemSide(item: PackItem): BubbleSide {
  return bubbleSide(item.kind === 'voter' ? item.voter : item.group)
}

// The radius scale comes from the TOTAL power on the chart, not from the largest
// single vote: scaling the biggest bubble to the canvas made it ~115px tall in a
// 300px box, so every other voter had to overlap it (662 collisions on referendum
// 368). Solving pi*R^2*(sum w / max w) = area*fill for R makes the circles
// collectively fill the space, whatever the spread between the whale and the dust.
export function radiusScale(weights: number[], maxWeight: number, width: number): number {
  const total = weights.reduce((sum, w) => sum + w, 0)
  if (!(total > 0) || !(maxWeight > 0)) return MIN_R
  const usable = width * HEIGHT * 0.42
  const scale = Math.sqrt((usable * maxWeight) / (Math.PI * total))
  return Math.max(MIN_R, Math.min(scale, HEIGHT / 2.4))
}

// The referendum page's entry point: fold under nothing (a null resolver keeps
// every voter individual — VoteBubbles passes resolveTag instead). Kept as the
// packer's plain-voters form so the pinned coordinate tests keep meaning what
// they always did.
export function packVoters(voters: ReferendumVoter[]): Bubble[] {
  return packItems(foldVoters(voters, () => null))
}

// ONE cluster holding both sides, so the chart reads as a single population with the
// balance of the vote visible in the colour mix rather than as two charts to compare.
// Deterministic spiral placement — no randomness, so the same referendum always
// renders identically. Items arrive pre-folded and pre-filtered (foldVoters).
export function packItems(items: PackItem[]): Bubble[] {
  const live = items.filter(item => itemWeight(item) > 0)
  if (!live.length) return []
  const weights = live.map(itemWeight)
  const maxWeight = Math.max(...weights)
  const maxR = radiusScale(weights, maxWeight, WIDTH)
  // Largest first: heavy circles claim the centre, small ones fill in around them.
  const ordered = [...live].sort((a, b) => itemWeight(b) - itemWeight(a))

  const placed: Bubble[] = []
  // Flat mirrors of the circles already down. A busy referendum walks ~2.3M spiral
  // steps and runs ~16.5M pair tests, all on the main thread while the page is
  // blank, so the innermost loop must stay allocation-free: no closure per step,
  // no property loads through the Bubble objects, and squared distances instead of
  // Math.hypot — d >= gap and d^2 >= gap^2 select the same spots, the square root
  // is pure cost. Referendum 368: 860ms -> 77ms, same coordinates to the bit.
  const cx = new Float64Array(ordered.length)
  const cy = new Float64Array(ordered.length)
  const cr = new Float64Array(ordered.length)
  for (const item of ordered) {
    const weight = itemWeight(item)
    // sqrt so AREA is proportional to power.
    const r = Math.max(MIN_R, Math.sqrt(weight / maxWeight) * maxR)
    let best: { x: number; y: number } | null = null
    for (let step = 0; step < 30_000; step++) {
      const angle = step * 0.35
      const radius = Math.sqrt(step) * 1.9
      const x = WIDTH / 2 + Math.cos(angle) * radius
      const y = HEIGHT / 2 + Math.sin(angle) * radius
      if (x - r < 2 || x + r > WIDTH - 2 || y - r < 2 || y + r > HEIGHT - 2) continue
      let clear = true
      for (let i = 0; i < placed.length; i++) {
        const dx = cx[i] - x, dy = cy[i] - y, gap = cr[i] + r + 0.6
        if (dx * dx + dy * dy < gap * gap) { clear = false; break }
      }
      if (clear) { best = { x, y }; break }
      // Remember the first in-bounds spot in case nothing ever clears.
      if (!best) best = { x, y }
    }
    const x = best?.x ?? WIDTH / 2
    const y = best?.y ?? HEIGHT / 2
    cx[placed.length] = x
    cy[placed.length] = y
    cr[placed.length] = r
    placed.push({
      item,
      x,
      y,
      r,
      side: itemSide(item),
      weight,
      label: r >= LABEL_FULL_R ? 'full' : r >= LABEL_EMOJI_R ? 'emoji' : 'none',
    })
  }
  return placed
}
