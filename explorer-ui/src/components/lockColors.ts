/* ============ HDX lock palette (CVD-validated — fixed, never cycled) ============ */
// Lock types: the SAME entity keeps the SAME hue on every chart, in fixed
// categorical order vote / staking / gigahdx / vesting / other. This is the
// single source of truth for lock colors across the /hdx dashboard AND the
// per-account balance breakdown bar — they must stay in parity.
//
// A leaf module on purpose: the breakdown bar on every account and tag page
// needs nothing but this lookup, and importing it from HdxCharts dragged that
// module's ~9.4 kB of /hdx-only chart components onto those pages too.
export const LOCK_ORDER = ['vote', 'staking', 'gigahdx', 'vesting', 'other'] as const
// A lock names the activity that placed it, so it wears that activity's colour:
// governance locks are vote lavender, staked HDX is stake violet. The two used to
// be neighbouring purples (--lavender-deep against #9c5cc4) and the first two
// segments of the bar were near indistinguishable.
// GIGAHDX keeps its brand black, the same one its market badge wears. Vesting
// leaves red — red means the bad outcome now, and vesting is just capital on a
// schedule — for a teal no category claims.
const LOCK_COLORS: Record<string, string> = {
  vote: 'var(--cat-vote)',
  staking: 'var(--cat-stake)',
  gigahdx: '#000000', // GIGAHDX brand black
  vesting: 'var(--lock-vesting)',
  other: 'var(--neutral)',
}
export function lockColor(key: string): string { return LOCK_COLORS[key] ?? LOCK_COLORS.other }
