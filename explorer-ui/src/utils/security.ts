// Security-page pure helpers and the static reference tables the page renders
// beside its live data. Kept out of the component module so the load scale and
// the origin matrix can be imported by tests and by the page without dragging
// components along.

// One shared load scale for every gauge and meter on the page: green while there
// is room, amber past half, red past three quarters, and red for a tripped fuse.
export function loadColor(pct: number): string {
  if (pct >= 75) return 'var(--red)'
  if (pct >= 50) return 'var(--amber)'
  return 'var(--green)'
}

export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v === 0) return '0%'
  if (v < 0.01) return '<0.01%'
  return `${parseFloat(v.toFixed(digits))}%`
}

// A duration in whole blocks, said the way the pallet counts it (6s blocks).
// Hours up to two days, then days. The domain's own units are hours — the fuse
// period is spoken of as 24h, not one day — so the switch to days waits until
// hours stop being readable.
const DAY_THRESHOLD_HOURS = 48
function saidInUnits(mins: number): string {
  if (mins < 1) return '<1 min'
  if (mins < 60) return `${Math.round(mins)} min`
  const hours = mins / 60
  if (hours < DAY_THRESHOLD_HOURS) return `${parseFloat(hours.toFixed(1))} h`
  return `${parseFloat((hours / 24).toFixed(1))} d`
}

export function fmtBlocks(blocks: number): string {
  return saidInUnits((blocks * 6) / 60)
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return saidInUnits(ms / 60_000)
}

// static reference

// Who can change each safety control, and how quickly. Bindings are the runtime's
// `Config` origins (runtime/hydradx/src); the committee thresholds come from
// EnsureProportionAtLeast<1,2> and <2,3> over the live member count, so they are
// rendered from the member count rather than hard-coded.
export interface ControlOrigin { control: string; committee: 'majority' | 'super' | null; others: string; speed: string }
export const CONTROL_ORIGINS: ControlOrigin[] = [
  { control: 'Circuit-breaker limits, lockdowns & egress config', committee: 'majority', others: 'Root · Omnipool admin referendum', speed: 'Immediate' },
  { control: 'Paused calls', committee: 'majority', others: 'Root · General admin referendum', speed: 'Immediate' },
  { control: 'Omnipool tradability & slip fee', committee: 'majority', others: 'Root · Omnipool admin referendum', speed: 'Immediate' },
  { control: 'Stablepool tradability', committee: 'majority', others: 'Root', speed: 'Immediate' },
  { control: 'Asset ban & registry rate limits', committee: 'majority', others: 'Root · General admin referendum', speed: 'Immediate' },
  { control: 'Bridge minter shutdown (NTT)', committee: 'majority', others: 'Root · General admin referendum', speed: 'Immediate' },
  { control: 'Emergency-admin dispatch (money market)', committee: 'majority', others: 'Root', speed: 'Immediate' },
  { control: 'XCMP channel suspension', committee: 'super', others: 'Root', speed: 'Immediate' },
  { control: 'Anything root-level, via the call whitelist', committee: 'majority', others: 'Whitelisted-caller referendum', speed: '≈4h 20m floor' },
  { control: 'Omnipool weight caps, token listing & removal', committee: null, others: 'Root · Omnipool admin referendum', speed: '7-day decision' },
  { control: 'HOLLAR Stability Module parameters', committee: null, others: 'Root · Economic parameters · General admin referendum', speed: '7-day decision' },
  { control: 'Duster whitelist', committee: null, others: 'Root · General admin referendum', speed: '7-day decision' },
  { control: 'Runtime upgrade', committee: null, others: 'Root referendum', speed: '7-day decision + 12h confirm' },
]

// Calls the runtime refuses to let the pause filter touch, so the committee can
// never switch off governance itself (runtime/hydradx/src/system.rs CallFilter).
export const UNPAUSABLE = ['System', 'Timestamp', 'ParachainSystem', 'Preimage', 'Referenda', 'ConvictionVoting', 'Whitelist', 'TransactionPause']

export interface Audit { date: string; firm: string; scope: string }
// Published reviews, from galacticcouncil/hydration-security. The docs site lists
// only the first two; the repository is the complete set.
export const AUDITS: Audit[] = [
  { date: 'Jun 2025', firm: 'Spearbit / Cantina', scope: 'HOLLAR Stability Module (peg support)' },
  { date: 'May 2025', firm: 'OAK Security', scope: 'Stablepools with drifting peg (draft)' },
  { date: 'Apr 2025', firm: 'Spearbit / Cantina', scope: 'Money-market on-chain liquidations' },
  { date: 'Jan 2025', firm: 'Spearbit / Cantina', scope: 'Aave v3 money-market deployment' },
  { date: 'Oct 2024', firm: 'Pashov Audit Group', scope: 'ERC-20 mapping' },
  { date: 'Jun 2024', firm: 'SRLabs', scope: 'EVM precompiles' },
  { date: 'Apr 2024', firm: 'Code4rena', scope: 'Omnipool, stablepools, oracles, circuit breaker' },
  { date: 'Jul 2023', firm: 'Runtime Verification', scope: 'Stableswap' },
  { date: 'Jun 2023', firm: 'Runtime Verification', scope: 'EMA oracle' },
  { date: 'Sep 2022', firm: 'Runtime Verification', scope: 'Omnipool' },
  { date: 'Mar 2022', firm: 'BlockScience', scope: 'Omnipool economics' },
]

export const SECURITY_LINKS = {
  audits: 'https://github.com/galacticcouncil/hydration-security',
  bounty: 'https://immunefi.com/bug-bounty/hydration/',
  docs: 'https://docs.hydration.net/security/intro',
}
