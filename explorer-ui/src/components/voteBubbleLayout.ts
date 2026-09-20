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

// ONE cluster holding both sides, so the chart reads as a single population with the
// balance of the vote visible in the colour mix rather than as two charts to compare.
// Deterministic spiral placement — no randomness, so the same referendum always
// renders identically. Items arrive pre-folded and pre-filtered (foldVoters).
//
// The spiral must be able to reach ANY point of the canvas. A fixed step cap put the
// ceiling at ~329 units, short of the ~340 two big circles needed between their
// centres, so a spot that existed was never sampled and the bubble was dropped on
// top of its neighbour. Derive the cap from the geometry instead: half the diagonal
// is the farthest a centre can sit from the middle.
const SPIRAL_GROWTH = 1.9
const SPIRAL_TURN = 0.35
const SPIRAL_STEPS = Math.ceil((Math.hypot(WIDTH, HEIGHT) / 2 / SPIRAL_GROWTH) ** 2)

// Clearance between two bubbles' edges: enough that neighbouring strokes read as two
// circles rather than one blob.
const BUBBLE_GAP = 0.6
// How much the whole scale steps down when a packing attempt cannot fit.
const SHRINK = 0.92

function radiusFor(weight: number, maxWeight: number, maxR: number): number {
  // sqrt so AREA is proportional to power.
  return Math.max(MIN_R, Math.sqrt(weight / maxWeight) * maxR)
}

/**
 * The spot a circle of radius `r` takes, walking the spiral out from the middle.
 *
 * Two searches rather than one with a flag inside it: this loop runs millions of
 * times per chart and a branch in its body costs ~1.6x, measured on the busiest
 * referendum there has ever been (499 live voters: 465ms one loop, 747ms two).
 * Returns -1 when nothing on the spiral is clear.
 */
function findClearSpot(
  r: number, placed: number, cx: Float64Array, cy: Float64Array, cr: Float64Array,
  out: Float64Array,
): number {
  for (let step = 0; step < SPIRAL_STEPS; step++) {
    const angle = step * SPIRAL_TURN
    const radius = Math.sqrt(step) * SPIRAL_GROWTH
    const x = WIDTH / 2 + Math.cos(angle) * radius
    const y = HEIGHT / 2 + Math.sin(angle) * radius
    if (x - r < 2 || x + r > WIDTH - 2 || y - r < 2 || y + r > HEIGHT - 2) continue
    let clear = true
    for (let i = 0; i < placed; i++) {
      const dx = cx[i] - x, dy = cy[i] - y, gap = cr[i] + r + BUBBLE_GAP
      if (dx * dx + dy * dy < gap * gap) { clear = false; break }
    }
    if (clear) { out[0] = x; out[1] = y; return step }
  }
  return -1
}

/**
 * The spot with the MOST room, for a circle that has nowhere clear to go. Only
 * reached once every scale has been tried, so it may take the slow path and score
 * every candidate: an unavoidable overlap then lands where it covers least, rather
 * than on the first spot the spiral offered — which is the middle, on top of the
 * largest bubble of all.
 */
function findRoomiestSpot(
  r: number, placed: number, cx: Float64Array, cy: Float64Array, cr: Float64Array,
  out: Float64Array,
): void {
  let bestRoom = -Infinity
  out[0] = WIDTH / 2
  out[1] = HEIGHT / 2
  for (let step = 0; step < SPIRAL_STEPS; step++) {
    const angle = step * SPIRAL_TURN
    const radius = Math.sqrt(step) * SPIRAL_GROWTH
    const x = WIDTH / 2 + Math.cos(angle) * radius
    const y = HEIGHT / 2 + Math.sin(angle) * radius
    if (x - r < 2 || x + r > WIDTH - 2 || y - r < 2 || y + r > HEIGHT - 2) continue
    let room = Infinity
    for (let i = 0; i < placed; i++) {
      const dx = cx[i] - x, dy = cy[i] - y
      const edge = Math.sqrt(dx * dx + dy * dy) - cr[i] - r
      if (edge < room) room = edge
    }
    if (room >= BUBBLE_GAP) { out[0] = x; out[1] = y; return }
    if (room > bestRoom) { bestRoom = room; out[0] = x; out[1] = y }
  }
}

/**
 * One packing attempt at a given scale.
 *
 * Returns null the moment a bubble cannot be placed clear of the ones already down,
 * so a doomed scale costs the caller almost nothing — the abort normally happens on
 * the second circle. With `force`, nothing is refused.
 */
function packAtScale(ordered: PackItem[], maxWeight: number, maxR: number, force: boolean): Bubble[] | null {
  const placed: Bubble[] = []
  // Flat mirrors of the circles already down. A busy referendum walks millions of
  // spiral steps and pair tests, all on the main thread while the page is blank, so
  // the innermost loop must stay allocation-free: no closure per step, no property
  // loads through the Bubble objects, and squared distances instead of Math.hypot —
  // d >= gap and d^2 >= gap^2 select the same spots, the square root is pure cost.
  const cx = new Float64Array(ordered.length)
  const cy = new Float64Array(ordered.length)
  const cr = new Float64Array(ordered.length)
  const out = new Float64Array(2)
  for (const item of ordered) {
    const weight = itemWeight(item)
    const r = radiusFor(weight, maxWeight, maxR)
    if (findClearSpot(r, placed.length, cx, cy, cr, out) < 0) {
      if (!force) return null
      findRoomiestSpot(r, placed.length, cx, cy, cr, out)
    }
    const x = out[0], y = out[1]
    cx[placed.length] = x
    cy[placed.length] = y
    cr[placed.length] = r
    placed.push({
      item, x, y, r,
      side: itemSide(item),
      weight,
      label: r >= LABEL_FULL_R ? 'full' : r >= LABEL_EMOJI_R ? 'emoji' : 'none',
    })
  }
  return placed
}

export function packItems(items: PackItem[]): Bubble[] {
  const live = items.filter(item => itemWeight(item) > 0)
  if (!live.length) return []
  const weights = live.map(itemWeight)
  const maxWeight = Math.max(...weights)
  // Largest first: heavy circles claim the centre, small ones fill in around them.
  const ordered = [...live].sort((a, b) => itemWeight(b) - itemWeight(a))

  // radiusScale sizes the circles so they COLLECTIVELY fill the canvas, which says
  // nothing about whether they individually fit. Two comparable whales need room
  // between their centres that a canvas this size cannot always give — on
  // referendum 411 the top two wanted 340 units apart and the most the box offers
  // from its middle is 289 — and the old packer answered that by stacking the
  // second bubble exactly on the first. Shrink the whole scale and try again
  // instead: every radius moves by the same factor, so AREA stays proportional to
  // power, which is the only thing this chart claims. Absolute size never meant
  // anything — radiusScale already clamps it to the canvas.
  const base = radiusScale(weights, maxWeight, WIDTH)
  for (let attempt = 0; attempt < 24; attempt++) {
    const packed = packAtScale(ordered, maxWeight, base * SHRINK ** attempt, false)
    if (packed) return packed
  }
  // Nothing fit in 24 shrinks (every bubble is at the MIN_R floor and there are
  // thousands of them). Place them anyway, roomiest-spot first, so the chart
  // degrades into a crowd rather than a pile.
  return packAtScale(ordered, maxWeight, MIN_R, true)!
}
